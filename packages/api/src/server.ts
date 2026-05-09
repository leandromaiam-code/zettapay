import { buildApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = buildApp();

app.listen(port, host, () => {
  console.log(`[zettapay-api] listening on http://${host}:${port}`);
});
