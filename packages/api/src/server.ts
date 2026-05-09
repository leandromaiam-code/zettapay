import { buildApp } from './app.js';
import { logger } from './lib/logger.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const { app } = await buildApp();
  app.listen(port, host, () => {
    console.log(`[zettapay-api] listening on http://${host}:${port}`);
  });
}

app.listen(port, host, () => {
  logger.info('server_listening', { host, port });
main().catch((err) => {
  console.error('[zettapay-api] failed to start', err);
  process.exit(1);
});
