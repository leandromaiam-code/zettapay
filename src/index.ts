import { createApp } from './app.js';
import { env } from './utils/env.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(
    { port: env.port, cluster: env.solanaCluster, endpoint: env.solanaRpcUrl },
    'ZettaPay listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
