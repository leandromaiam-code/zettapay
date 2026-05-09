import { Connection, type Commitment, type ConnectionConfig } from "@solana/web3.js";
import type { AppEnv, SolanaNetwork } from "../env.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";

export interface SolanaServiceOptions {
  rpcUrl: string;
  network: SolanaNetwork;
  commitment?: Commitment;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  connectionConfig?: ConnectionConfig;
  logger?: Pick<Console, "warn">;
}

export class SolanaConnectionService {
  readonly connection: Connection;
  readonly network: SolanaNetwork;
  readonly rpcUrl: string;
  private readonly retryOpts: RetryOptions;

  constructor(opts: SolanaServiceOptions) {
    this.network = opts.network;
    this.rpcUrl = opts.rpcUrl;
    this.connection = new Connection(opts.rpcUrl, {
      commitment: opts.commitment ?? "confirmed",
      ...opts.connectionConfig,
    });
    const logger = opts.logger ?? console;
    this.retryOpts = {
      maxRetries: opts.maxRetries,
      initialBackoffMs: opts.initialBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      onRetry: (attempt, delayMs, error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[solana] retry ${attempt}/${opts.maxRetries} in ${delayMs}ms — ${message}`,
        );
      },
    };
  }

  async withRetry<T>(task: (connection: Connection) => Promise<T>): Promise<T> {
    return retryWithBackoff(() => task(this.connection), this.retryOpts);
  }

  async getSlot(): Promise<number> {
    return this.withRetry((conn) => conn.getSlot());
  }

  async getHealth(): Promise<{ ok: true; slot: number } | { ok: false; error: string }> {
    try {
      const slot = await this.getSlot();
      return { ok: true, slot };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

let cached: SolanaConnectionService | null = null;

export function createSolanaService(env: AppEnv): SolanaConnectionService {
  return new SolanaConnectionService({
    rpcUrl: env.solanaRpcUrl,
    network: env.solanaNetwork,
    maxRetries: env.rpcMaxRetries,
    initialBackoffMs: env.rpcInitialBackoffMs,
    maxBackoffMs: env.rpcMaxBackoffMs,
  });
}

export function getSolanaService(env: AppEnv): SolanaConnectionService {
  if (!cached) {
    cached = createSolanaService(env);
  }
  return cached;
}

export function resetSolanaService(): void {
  cached = null;
}
