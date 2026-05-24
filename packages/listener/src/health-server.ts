// HealthServer — minimal HTTP server exposing GET /health for liveness +
// readiness probes (k8s, Docker, fly.io, etc). No express, just node:http.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ListenerStatus } from './listener.js';
import type { Logger } from './listener.js';

export const DEFAULT_HEALTH_PORT = 8787;

export interface HealthServerOptions {
  port?: number;
  host?: string;
  statusProvider: () => ListenerStatus;
  logger?: Logger;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class HealthServer {
  private readonly port: number;
  private readonly host: string;
  private readonly statusProvider: () => ListenerStatus;
  private readonly log: Logger;
  private server: Server | null = null;

  constructor(opts: HealthServerOptions) {
    this.port = opts.port ?? DEFAULT_HEALTH_PORT;
    this.host = opts.host ?? '0.0.0.0';
    this.statusProvider = opts.statusProvider;
    this.log = opts.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.log.info('health_server.listening', { port: this.port, host: this.host });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const url = req.url ?? '/';
    if (url === '/health' || url === '/' || url.startsWith('/health?')) {
      const status = this.statusProvider();
      const body = JSON.stringify({
        ok: status.wsConnected,
        ws_connected: status.wsConnected,
        subscribed_count: status.subscribedCount,
        last_event_at: status.lastEventAt,
        last_block_height: status.lastBlockHeight,
        uptime_s: status.uptimeSeconds,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end();
  }
}
