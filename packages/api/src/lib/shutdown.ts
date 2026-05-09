import type { Logger } from "./logger.js";

export type CloseHook = () => void | Promise<void>;

export interface ServerLike {
  close(callback?: (err?: Error) => void): unknown;
}

export interface GracefulShutdownOptions {
  /** Total grace period from receiving signal to forced exit. Default 30s. */
  shutdownTimeoutMs?: number;
  /** Reserved budget (subtracted from shutdownTimeoutMs) for close hooks. Default 5s. */
  closeHookBudgetMs?: number;
  logger?: Logger;
  /** Override exit (testing). Default `process.exit`. */
  exit?: (code: number) => void;
  /** Override signal subscription (testing). Default `process.once`. */
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
}

interface RegisteredHook {
  name: string;
  fn: CloseHook;
}

/**
 * Coordinates a clean shutdown: stop accepting new HTTP connections, wait for
 * inflight async work (webhook deliveries, on-chain confirmations) to settle,
 * then close registered resources (database, redis, etc.) before exit.
 *
 * Triggered by SIGTERM (orchestrator stop) or SIGINT (Ctrl+C).
 */
export class GracefulShutdown {
  private readonly closeHooks: RegisteredHook[] = [];
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly shutdownTimeoutMs: number;
  private readonly closeHookBudgetMs: number;
  private readonly log: Logger | null;
  private readonly exit: (code: number) => void;
  private readonly on: (signal: NodeJS.Signals, handler: () => void) => void;
  private shuttingDown = false;
  private drainResolve: (() => void) | null = null;
  private drainPromise: Promise<void>;

  constructor(options: GracefulShutdownOptions = {}) {
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    this.closeHookBudgetMs = options.closeHookBudgetMs ?? 5_000;
    this.log = options.logger ?? null;
    this.exit = options.exit ?? ((code) => process.exit(code));
    this.on =
      options.on ??
      ((signal, handler) => {
        process.once(signal, handler);
      });
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
    });
  }

  /** Register a resource cleanup invoked after inflight work has drained. */
  register(name: string, fn: CloseHook): void {
    this.closeHooks.push({ name, fn });
  }

  /**
   * Track an inflight async task (e.g. a webhook delivery). The promise is
   * awaited during shutdown drain. Returns the same promise so callers can
   * `await dispatcher.track(dispatchWebhook(...))` ergonomically.
   */
  track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    promise
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(promise);
        if (this.shuttingDown && this.inflight.size === 0) {
          this.drainResolve?.();
        }
      });
    return promise;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Block until inflight tasks complete or `timeoutMs` elapses.
   * Returns whether the queue fully drained.
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; abandoned: number }> {
    if (this.inflight.size === 0) {
      return { drained: true, abandoned: 0 };
    }
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race<boolean>([
      this.drainPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { drained, abandoned: this.inflight.size };
  }

  /**
   * Install SIGTERM / SIGINT handlers. The first signal initiates the drain;
   * a second forces an immediate exit (operators escape latch).
   */
  install(server: ServerLike): void {
    const handle = (signal: NodeJS.Signals): void => {
      if (this.shuttingDown) {
        this.log?.warn("shutdown.signal_repeat_force_exit", { signal });
        this.exit(1);
        return;
      }
      this.shuttingDown = true;
      this.log?.info("shutdown.signal_received", {
        signal,
        inflight: this.inflight.size,
      });

      const overall = setTimeout(() => {
        this.log?.error("shutdown.timeout_force_exit", {
          timeoutMs: this.shutdownTimeoutMs,
          inflight: this.inflight.size,
        });
        this.exit(1);
      }, this.shutdownTimeoutMs);
      overall.unref?.();

      server.close((err) => {
        if (err) {
          this.log?.error("shutdown.server_close_error", { error: err.message });
        } else {
          this.log?.info("shutdown.server_closed");
        }
      });

      void this.runShutdown()
        .catch((err) => {
          this.log?.error("shutdown.unexpected_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          clearTimeout(overall);
          this.exit(0);
        });
    };

    this.on("SIGTERM", () => handle("SIGTERM"));
    this.on("SIGINT", () => handle("SIGINT"));
  }

  private async runShutdown(): Promise<void> {
    const drainBudget = Math.max(
      0,
      this.shutdownTimeoutMs - this.closeHookBudgetMs,
    );
    const result = await this.drain(drainBudget);
    if (!result.drained) {
      this.log?.warn("shutdown.drain_timeout", { abandoned: result.abandoned });
    } else {
      this.log?.info("shutdown.drained");
    }
    await this.runCloseHooks();
    this.log?.info("shutdown.complete");
  }

  private async runCloseHooks(): Promise<void> {
    for (const hook of this.closeHooks) {
      try {
        await hook.fn();
        this.log?.info("shutdown.hook_closed", { name: hook.name });
      } catch (err) {
        this.log?.error("shutdown.hook_failed", {
          name: hook.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
