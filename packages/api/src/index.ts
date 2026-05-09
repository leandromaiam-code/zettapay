import express from "express";
import { loadEnv } from "./env.js";
import { getSolanaService } from "./lib/solana.js";
import { healthRouter } from "./routes/health.js";
import { faucetRouter } from "./routes/faucet.js";

export function createApp(env = loadEnv()) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  const solana = getSolanaService(env);

  app.use("/health", healthRouter(solana));
  app.use("/faucet", faucetRouter(solana, env.faucetMaxAirdropLamports));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  return { app, env, solana };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { app, env, solana } = createApp();
  app.listen(env.port, () => {
    console.log(
      `[zettapay-api] listening on :${env.port} — solana ${solana.network} via ${solana.rpcUrl}`,
    );
  });
}
