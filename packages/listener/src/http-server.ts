// AppServer — single node:http server (no framework) exposing:
//   GET  /health         liveness/readiness (same payload as the old HealthServer)
//   POST /invoice        create a pending invoice (merchant backend → listener)
//   GET  /invoice/:id    poll invoice status
//
// This is what turns @zettapay/listener into a self-contained payment server:
// the merchant's backend POSTs here to create an invoice, the listener stores
// it locally (JSON/SQLite — the merchant's box), and the existing resync loop
// subscribes the address on-chain within ~30s. On payment the webhook fires.
//
// HR-CUSTODY: derives from the merchant xpub only; never a signing key.
// HR-PHONE-HOME: no outbound calls here (the watcher talks to mempool).
// Auth: POST /invoice requires header X-ZettaPay-Api-Key === ZETTAPAY_API_KEY
// when that env var is set. If unset, POST is open (dev) with a startup warning.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ListenerStatus, Logger } from './listener.js';
import type { StorageAdapter } from './storage/index.js';
import type { Invoice } from './types.js';
import { createInvoiceForMerchant } from './invoice-core.js';

export const DEFAULT_HEALTH_PORT = 8787;

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const MAX_BODY_BYTES = 16 * 1024;

export interface AppServerOptions {
  port?: number;
  host?: string;
  statusProvider: () => ListenerStatus;
  storage: StorageAdapter;
  merchantId: string;
  apiKey?: string;
  corsOrigins?: string[];
  logger?: Logger;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serializeInvoice(inv: Invoice): Record<string, unknown> {
  return {
    invoice_id: inv.id,
    merchant_id: inv.merchant_id,
    chain: inv.chain,
    asset: inv.asset,
    amount_btc: inv.amount,
    receive_address: inv.address,
    child_index: inv.child_index,
    status: inv.status,
    tx_hash: inv.tx_hash,
    paid_at: inv.paid_at,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
  };
}

export class AppServer {
  private readonly port: number;
  private readonly host: string;
  private readonly statusProvider: () => ListenerStatus;
  private readonly storage: StorageAdapter;
  private readonly merchantId: string;
  private readonly apiKey?: string;
  private readonly corsOrigins: string[];
  private readonly log: Logger;
  private server: Server | null = null;

  constructor(opts: AppServerOptions) {
    this.port = opts.port ?? DEFAULT_HEALTH_PORT;
    this.host = opts.host ?? '0.0.0.0';
    this.statusProvider = opts.statusProvider;
    this.storage = opts.storage;
    this.merchantId = opts.merchantId;
    this.apiKey = opts.apiKey;
    this.corsOrigins = opts.corsOrigins ?? [];
    this.log = opts.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (!this.apiKey) {
      this.log.warn('http_server.no_api_key', {
        message:
          'DEV MODE: POST /invoice is unauthenticated. Set ZETTAPAY_API_KEY for production.',
      });
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.log.info('http_server.listening', { port: this.port, host: this.host });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && this.corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-zettapay-api-key');
  }

  private sendJson(res: ServerResponse, code: number, body: unknown): void {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    this.applyCors(req, res);

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // GET /health  (and / for convenience)
    if (method === 'GET' && (path === '/health' || path === '/')) {
      const s = this.statusProvider();
      this.sendJson(res, 200, {
        ok: s.wsConnected,
        ws_connected: s.wsConnected,
        subscribed_count: s.subscribedCount,
        last_event_at: s.lastEventAt,
        last_block_height: s.lastBlockHeight,
        uptime_s: s.uptimeSeconds,
      });
      return;
    }

    // POST /invoice
    if (method === 'POST' && path === '/invoice') {
      if (this.apiKey) {
        const got = String(req.headers['x-zettapay-api-key'] ?? '');
        if (got !== this.apiKey) {
          this.sendJson(res, 401, { error: { code: 'unauthorized', message: 'invalid api key' } });
          return;
        }
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        this.sendJson(res, 400, { error: { code: 'bad_body', message: (e as Error).message } });
        return;
      }
      const amountSats = Number(body.amount_sats);
      if (!Number.isInteger(amountSats) || amountSats <= 0) {
        this.sendJson(res, 400, {
          error: { code: 'invalid_amount', message: 'amount_sats must be a positive integer' },
        });
        return;
      }
      const memo = typeof body.memo === 'string' ? body.memo.slice(0, 200) : undefined;
      const expiresIn =
        Number.isInteger(body.expires_in) && (body.expires_in as number) > 0
          ? (body.expires_in as number)
          : undefined;
      try {
        const r = await createInvoiceForMerchant(this.storage, this.merchantId, {
          amountSats,
          memo,
          expiresInSeconds: expiresIn,
        });
        this.log.info('http_server.invoice_created', {
          invoice_id: r.invoice.id,
          address: r.invoice.address,
          amount_sats: amountSats,
        });
        this.sendJson(res, 201, {
          ...serializeInvoice(r.invoice),
          derivation_path: r.path,
          network: r.network,
          amount_sats: r.amountSats,
          qr_uri: r.bip21,
          verify_url: `https://mempool.space/address/${r.invoice.address}`,
        });
      } catch (e) {
        this.sendJson(res, 500, { error: { code: 'create_failed', message: (e as Error).message } });
      }
      return;
    }

    // GET /invoice/:id
    if (method === 'GET' && path.startsWith('/invoice/')) {
      const id = decodeURIComponent(path.slice('/invoice/'.length));
      if (!id) {
        this.sendJson(res, 400, { error: { code: 'missing_id' } });
        return;
      }
      let inv: Invoice | null;
      try {
        inv = await this.storage.getInvoice(id);
      } catch (e) {
        this.sendJson(res, 500, { error: { code: 'lookup_failed', message: (e as Error).message } });
        return;
      }
      if (!inv) {
        this.sendJson(res, 404, { error: { code: 'not_found' } });
        return;
      }
      // Lazy auto-expire on read.
      if (inv.status === 'pending' && new Date(inv.expires_at).getTime() < Date.now()) {
        try {
          inv = await this.storage.updateInvoiceStatus(inv.id, 'expired');
        } catch {
          /* best effort — return the stale-but-known row */
        }
      }
      this.sendJson(res, 200, serializeInvoice(inv));
      return;
    }

    this.sendJson(res, 404, { error: { code: 'not_found' } });
  }
}
