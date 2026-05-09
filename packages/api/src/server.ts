import { buildApp } from './app.js';
import { logger } from './lib/logger.js';
import { createApp } from "./app.js";
import { openDatabase } from "./db/index.js";
import { SolanaService } from "./services/solana.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const { app } = await buildApp();
  app.listen(port, host, () => {
    console.log(`[zettapay-api] listening on http://${host}:${port}`);
  });
}
const db = openDatabase(process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite");

const solana = new SolanaService({
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  commitment: (process.env.SOLANA_COMMITMENT as
    | "processed"
    | "confirmed"
    | "finalized"
    | undefined) ?? "confirmed",
  usdcMintAddress:
    process.env.SOLANA_USDC_MINT ??
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  payerSecretKey:
    process.env.SOLANA_FEE_PAYER_SECRET ?? process.env.PAYER_SECRET_KEY ?? null,
});

const app = createApp({ db, solana });

app.listen(port, host, () => {
  logger.info('server_listening', { host, port });
main().catch((err) => {
  console.error('[zettapay-api] failed to start', err);
  process.exit(1);
});
