import { loadEnv } from "./config/env.js";
import { openDatabase } from "./db/index.js";
import { SolanaService } from "./services/solana.js";
import { createApp } from "./app.js";

function main(): void {
  const env = loadEnv();
  const db = openDatabase(env.databasePath);
  const solana = new SolanaService({
    rpcUrl: env.solanaRpcUrl,
    commitment: env.solanaCommitment,
    usdcMintAddress: env.usdcMintAddress,
    payerSecretKey: env.payerSecretKey,
  });

  const app = createApp({ db, solana });
  const server = app.listen(env.port, () => {
    console.log(
      `[zettapay-api] listening on :${env.port} (rpc=${env.solanaRpcUrl}, commitment=${env.solanaCommitment})`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[zettapay-api] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
