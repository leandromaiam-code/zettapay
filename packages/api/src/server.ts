import { buildApp } from './app.js';
import { logger } from './lib/logger.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = buildApp();

app.listen(port, host, () => {
  logger.info('server_listening', { host, port });
});
