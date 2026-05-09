import { createApp } from "./app.js";
import {
  HttpCoinflowClient,
  type CoinflowClient,
  type CoinflowEnvironment,
} from "./coinflow/client.js";
import { closeDatabase, openDatabase } from "./db/index.js";
import { logger } from "./lib/logger.js";
import { GracefulShutdown } from "./lib/shutdown.js";
import { SolanaService } from "./services/solana.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const shutdownTimeoutMs = Number.parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS ?? "30000",
  10,
);

const db = openDatabase(process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite");

const solana = new SolanaService({
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  commitment:
    (process.env.SOLANA_COMMITMENT as
      | "processed"
      | "confirmed"
      | "finalized"
      | undefined) ?? "confirmed",
  usdcMintAddress:
    process.env.SOLANA_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payerSecretKey:
    process.env.SOLANA_FEE_PAYER_SECRET ?? process.env.PAYER_SECRET_KEY ?? null,
});

const shutdown = new GracefulShutdown({ shutdownTimeoutMs, logger });
shutdown.register("database", () => closeDatabase());

const coinflow = loadCoinflow();

const app = createApp({ db, solana, shutdown, coinflow });

const server = app.listen(port, host, () => {
  logger.info("server.listening", { host, port });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

shutdown.install(server);

function loadCoinflow(): CoinflowClient | undefined {
  const apiKey = process.env.COINFLOW_API_KEY;
  if (!apiKey) return undefined;
  const envValue = (process.env.COINFLOW_ENV ?? "sandbox").toLowerCase();
  if (envValue !== "sandbox" && envValue !== "production") {
    logger.error("coinflow.env.invalid", { value: envValue });
    return undefined;
  }
  const baseUrl = process.env.COINFLOW_BASE_URL;
  return new HttpCoinflowClient({
    apiKey,
    environment: envValue as CoinflowEnvironment,
    ...(baseUrl ? { baseUrl } : {}),
  });
}
