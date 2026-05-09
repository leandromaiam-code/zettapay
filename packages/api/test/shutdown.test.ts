import { describe, expect, it, vi } from "vitest";
import { GracefulShutdown } from "../src/lib/shutdown.js";

interface FakeServer {
  closed: boolean;
  closeCallback: ((err?: Error) => void) | null;
  close: (cb?: (err?: Error) => void) => void;
}

function makeFakeServer(): FakeServer {
  const server: FakeServer = {
    closed: false,
    closeCallback: null,
    close(cb) {
      server.closed = true;
      server.closeCallback = cb ?? null;
      cb?.();
    },
  };
  return server;
}

interface Harness {
  shutdown: GracefulShutdown;
  server: FakeServer;
  exit: ReturnType<typeof vi.fn>;
  fire: (signal: NodeJS.Signals) => void;
  exitCalled: () => Promise<number>;
}

function buildHarness(opts: { shutdownTimeoutMs?: number; closeHookBudgetMs?: number } = {}): Harness {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const exit = vi.fn();
  const exitWaiters: Array<(code: number) => void> = [];
  const wrappedExit = (code: number): void => {
    exit(code);
    while (exitWaiters.length) exitWaiters.shift()!(code);
  };
  const shutdown = new GracefulShutdown({
    shutdownTimeoutMs: opts.shutdownTimeoutMs ?? 1_000,
    closeHookBudgetMs: opts.closeHookBudgetMs ?? 200,
    exit: wrappedExit,
    on: (signal, handler) => handlers.set(signal, handler),
  });
  const server = makeFakeServer();
  shutdown.install(server);
  return {
    shutdown,
    server,
    exit,
    fire: (signal) => {
      const handler = handlers.get(signal);
      if (!handler) throw new Error(`no handler for ${signal}`);
      handler();
    },
    exitCalled: () =>
      new Promise<number>((resolve) => {
        if (exit.mock.calls.length > 0) {
          resolve(exit.mock.calls[0]![0] as number);
          return;
        }
        exitWaiters.push(resolve);
      }),
  };
}

describe("GracefulShutdown", () => {
  it("registers close hooks and runs them on shutdown", async () => {
    const harness = buildHarness();
    const order: string[] = [];
    harness.shutdown.register("redis", async () => {
      order.push("redis");
    });
    harness.shutdown.register("database", () => {
      order.push("database");
    });

    harness.fire("SIGTERM");
    const code = await harness.exitCalled();

    expect(code).toBe(0);
    expect(harness.server.closed).toBe(true);
    expect(order).toEqual(["redis", "database"]);
  });

  it("waits for inflight tracked tasks before closing resources", async () => {
    const harness = buildHarness({ shutdownTimeoutMs: 2_000, closeHookBudgetMs: 200 });
    const events: string[] = [];

    let resolveTask!: () => void;
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve;
    }).then(() => {
      events.push("task_done");
    });
    harness.shutdown.track(task);
    harness.shutdown.register("database", () => {
      events.push("hook_database");
    });

    harness.fire("SIGTERM");
    expect(harness.shutdown.isShuttingDown()).toBe(true);
    expect(harness.shutdown.inflightCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);

    resolveTask();
    await harness.exitCalled();

    expect(events).toEqual(["task_done", "hook_database"]);
  });

  it("force-exits when drain budget elapses without inflight resolving", async () => {
    const harness = buildHarness({ shutdownTimeoutMs: 150, closeHookBudgetMs: 50 });
    const hookRan = vi.fn();
    harness.shutdown.register("database", hookRan);

    const stuck = new Promise<void>(() => {
      // never resolves
    });
    harness.shutdown.track(stuck);

    harness.fire("SIGTERM");
    const code = await harness.exitCalled();

    expect(code).toBe(0);
    expect(hookRan).toHaveBeenCalled();
  });

  it("forces immediate exit on second signal", async () => {
    const harness = buildHarness({ shutdownTimeoutMs: 5_000 });
    const stuck = new Promise<void>(() => undefined);
    harness.shutdown.track(stuck);

    harness.fire("SIGTERM");
    expect(harness.exit).not.toHaveBeenCalled();

    harness.fire("SIGTERM");
    expect(harness.exit).toHaveBeenCalledWith(1);
  });

  it("isolates failing close hooks from later hooks", async () => {
    const harness = buildHarness();
    const ran: string[] = [];
    harness.shutdown.register("flaky", () => {
      ran.push("flaky");
      throw new Error("boom");
    });
    harness.shutdown.register("database", () => {
      ran.push("database");
    });

    harness.fire("SIGTERM");
    const code = await harness.exitCalled();

    expect(code).toBe(0);
    expect(ran).toEqual(["flaky", "database"]);
  });

  it("track() returns the original promise and removes it on resolve", async () => {
    const harness = buildHarness();
    const result = await harness.shutdown.track(Promise.resolve(42));
    expect(result).toBe(42);
    await new Promise((r) => setImmediate(r));
    expect(harness.shutdown.inflightCount()).toBe(0);
  });

  it("track() removes promise on rejection too", async () => {
    const harness = buildHarness();
    const tracked = harness.shutdown.track(Promise.reject(new Error("nope")));
    await expect(tracked).rejects.toThrow("nope");
    await new Promise((r) => setImmediate(r));
    expect(harness.shutdown.inflightCount()).toBe(0);
  });

  it("drain() returns immediately when nothing is inflight", async () => {
    const harness = buildHarness();
    const result = await harness.shutdown.drain(50);
    expect(result.drained).toBe(true);
    expect(result.abandoned).toBe(0);
  });

  it("SIGINT also triggers shutdown", async () => {
    const harness = buildHarness();
    const hook = vi.fn();
    harness.shutdown.register("database", hook);
    harness.fire("SIGINT");
    await harness.exitCalled();
    expect(hook).toHaveBeenCalled();
  });
});
