import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { logger } from "./lib/logger.js";

export { createApp } from "./app.js";
export { getConfig, loadConfig } from "./config.js";

function start(): void {
  const cfg = getConfig();
  const app = createApp();
  app.listen(cfg.port, () => {
    logger.info("api_listening", {
      port: cfg.port,
      cluster: cfg.solana.cluster,
      env: cfg.nodeEnv,
    });
  });
}

const isDirectRun = (() => {
  if (typeof process === "undefined") return false;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
})();

if (isDirectRun) start();
