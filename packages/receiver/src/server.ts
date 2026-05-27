// HTTP server for the receiver test tool. Plain `node:http` — no Express /
// Fastify / Koa — because every byte of dependency surface in a developer
// trust-tool tool is a byte you have to audit before plugging it into your
// laptop.
//
// Endpoints:
//   GET  /           — JSON service status (uptime, request counters)
//   POST /webhook    — verify HMAC + replay window, emit a structured log
//   *                — 404
//
// The server binds to 127.0.0.1 by default. We deliberately do NOT default to
// 0.0.0.0 because the receiver typically runs on a developer's laptop with no
// firewall in front of it — leaking webhooks across a coffee-shop network is
// a "found by accident" foot-gun we want to make impossible without an
// explicit --bind flag.

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { verifySignature } from './hmac.js';
import type { ServerStats, WebhookEnvelope } from './types.js';

export interface ReceiverServerOptions {
  /** Shared HMAC secret. Must match the listener's MERCHANT_WEBHOOK_SECRET. */
  secret: string;
  /** Bind host. Default `127.0.0.1`. */
  bind?: string;
  /** Bind port. `0` lets the OS pick (useful in tests). */
  port: number;
  /** Replay window in seconds. Default 300. */
  maxAgeSeconds?: number;
  /** Maximum body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Pluggable logger; default writes structured JSON lines to stdout. */
  log?: ReceiverLogger;
  /** Hook fired after every webhook (success or failure). Used by --exit-on. */
  onWebhook?: (event: WebhookOutcome) => void;
}

export interface ReceiverLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface WebhookOutcome {
  /** True when the signature + replay checks passed. */
  ok: boolean;
  /** Parsed JSON envelope when the body was JSON-decodable. */
  envelope: WebhookEnvelope | null;
  /** Raw body bytes received. */
  body: Buffer;
  /** When the request was received. */
  receivedAt: Date;
  /** Failure reason when `ok=false`. */
  reason?: 'missing_signature' | 'missing_timestamp' | 'bad_timestamp' | 'timestamp_too_old' | 'invalid_signature' | 'malformed_body';
  /** Age of the timestamp header relative to receipt, in ms (when known). */
  ageMs?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_BIND = '127.0.0.1';

export class ReceiverServer {
  readonly stats: ServerStats;
  private readonly opts: ReceiverServerOptions;
  private readonly log: ReceiverLogger;
  private server: Server | null = null;

  constructor(opts: ReceiverServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? defaultLogger();
    this.stats = {
      startedAt: new Date(),
      requestsTotal: 0,
      requestsOk: 0,
      requestsFailed: 0,
    };
  }

  /** Start listening. Resolves with the bound port (useful when port=0). */
  async listen(): Promise<{ port: number; host: string }> {
    if (this.server) throw new Error('@zettapay/receiver: already listening');
    const host = this.opts.bind ?? DEFAULT_BIND;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    if (addr == null || typeof addr === 'string') {
      throw new Error('@zettapay/receiver: server.address() returned no port');
    }
    return { port: addr.port, host };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Build a `WebhookOutcome` without binding a socket — exposed for tests. */
  async handleRaw(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; body: object; outcome?: WebhookOutcome }> {
    if (method === 'GET' && (url === '/' || url === '/health')) {
      return { status: 200, body: this.statusBody() };
    }
    if (method !== 'POST' || url !== '/webhook') {
      return { status: 404, body: { ok: false, error: 'not_found' } };
    }
    return this.handleWebhook(headers, body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    try {
      if (method === 'GET' && (url === '/' || url === '/health')) {
        return respondJson(res, 200, this.statusBody());
      }
      if (method !== 'POST' || url !== '/webhook') {
        return respondJson(res, 404, { ok: false, error: 'not_found' });
      }
      const body = await readBody(req, this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY);
      const result = await this.handleWebhook(toHeaderMap(req.headers), body);
      respondJson(res, result.status, result.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('receiver.fatal', { message });
      respondJson(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  private async handleWebhook(
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; body: object; outcome: WebhookOutcome }> {
    const receivedAt = new Date();
    this.stats.requestsTotal += 1;

    const verify = verifySignature({
      body,
      signatureHeader: headers['x-zettapay-signature'],
      timestampHeader: headers['x-zettapay-timestamp'],
      secret: this.opts.secret,
      maxAgeSeconds: this.opts.maxAgeSeconds,
    });

    let envelope: WebhookEnvelope | null = null;
    let malformed = false;
    if (body.length > 0) {
      try {
        envelope = JSON.parse(body.toString('utf8')) as WebhookEnvelope;
      } catch {
        malformed = true;
      }
    }

    if (!verify.ok) {
      this.stats.requestsFailed += 1;
      const outcome: WebhookOutcome = {
        ok: false,
        envelope,
        body,
        receivedAt,
        reason: verify.reason,
        ageMs: verify.ageMs,
      };
      this.opts.onWebhook?.(outcome);
      this.log.warn('webhook.rejected', {
        reason: verify.reason,
        age_ms: verify.ageMs,
      });
      const status = verify.reason === 'invalid_signature' || verify.reason === 'timestamp_too_old' ? 401 : 400;
      return {
        status,
        body: { ok: false, error: verify.reason },
        outcome,
      };
    }

    if (malformed) {
      this.stats.requestsFailed += 1;
      const outcome: WebhookOutcome = {
        ok: false,
        envelope: null,
        body,
        receivedAt,
        reason: 'malformed_body',
        ageMs: verify.ageMs,
      };
      this.opts.onWebhook?.(outcome);
      this.log.warn('webhook.malformed_body', { bytes: body.length });
      return {
        status: 400,
        body: { ok: false, error: 'malformed_body' },
        outcome,
      };
    }

    this.stats.requestsOk += 1;
    const outcome: WebhookOutcome = {
      ok: true,
      envelope,
      body,
      receivedAt,
      ageMs: verify.ageMs,
    };
    this.opts.onWebhook?.(outcome);
    this.log.info('webhook.received', {
      sig_valid: true,
      event: envelope?.event,
      invoice_id: envelope?.invoice_id,
      age_ms: verify.ageMs,
    });
    return {
      status: 200,
      body: { ok: true, received_at: receivedAt.toISOString() },
      outcome,
    };
  }

  private statusBody(): object {
    const uptimeS = Math.max(0, Math.round((Date.now() - this.stats.startedAt.getTime()) / 1000));
    return {
      ok: true,
      service: 'zettapay-receiver',
      uptime_s: uptimeS,
      requests_total: this.stats.requestsTotal,
      requests_ok: this.stats.requestsOk,
      requests_failed: this.stats.requestsFailed,
    };
  }
}

/**
 * Convenience: compute the signature the way the listener does, so callers
 * (eg. tests, CI smoke probes, the README curl example) don't need to
 * reimport `node:crypto`.
 */
export function signRequest(secret: string, body: string | Buffer): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function defaultLogger(): ReceiverLogger {
  return {
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

function emit(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta === undefined ? {} : { meta }),
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function toHeaderMap(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

function respondJson(res: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        reject(new Error(`body exceeds ${max} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
