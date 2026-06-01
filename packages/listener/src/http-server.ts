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
import { timingSafeEqual } from 'node:crypto';
import type { ListenerStatus, Logger } from './listener.js';
import type { StorageAdapter } from './storage/index.js';
import type { Invoice } from './types.js';
import {
  createBaseInvoiceForMerchant,
  createFixedEvmInvoiceForMerchant,
  createInvoiceForMerchant,
} from './invoice-core.js';
import { formatUsdc } from './usdc-pricing.js';
import { lookupEvmChain } from './fixed-address-watcher.js';
import {
  SlidingWindowRateLimiter,
  type RateLimitConfig,
} from './rate-limit.js';

export const DEFAULT_HEALTH_PORT = 8787;

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Constant-time string comparison (Z76 FIX 1). A naive `a === b` short-circuits
 * on the first differing byte, leaking — via response timing — how much of the
 * API key an attacker has guessed. We compare equal-length Buffers with
 * crypto.timingSafeEqual; on a length mismatch we still burn one compare so the
 * key's length isn't leaked either, then return false. Mirrors the receiver's
 * HMAC comparison.
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    const filler = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, filler);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export interface AppServerOptions {
  port?: number;
  host?: string;
  statusProvider: () => ListenerStatus;
  storage: StorageAdapter;
  merchantId: string;
  apiKey?: string;
  corsOrigins?: string[];
  /** Account-level EVM xpub (MERCHANT_XPUB_EVM). When unset, chain='base' is disabled. */
  evmXpub?: string;
  /** Override the USDC token used for base payment URIs. */
  baseUsdcAddress?: string;
  /** Fixed receive address (MERCHANT_EVM_ADDRESS) for the xpub-less USDC mode. */
  fixedEvmAddress?: string;
  /** Chain aliases enabled for fixed mode (e.g. ['base','polygon']). */
  fixedEvmChains?: string[];
  /** Token aliases the merchant accepts on fixed mode (e.g. ['usdc','usdt']). */
  fixedEvmTokens?: string[];
  /** Sliding-window rate limit for POST /invoice. null disables limiting. */
  rateLimit?: RateLimitConfig | null;
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
  const base = {
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
  // For EVM stablecoin chains (USDC or USDT — both 6 decimals), `amount` is
  // stored as integer base units — expose it under the correct labels too. BTC
  // serialization is unchanged.
  if (inv.chain !== 'btc' && (inv.asset === 'USDC' || inv.asset === 'USDT')) {
    const units = Number(inv.amount);
    return {
      ...base,
      amount_usdc_units: units,
      amount_usdc: Number.isInteger(units) ? formatUsdc(units) : inv.amount,
    };
  }
  return base;
}

export class AppServer {
  private readonly port: number;
  private readonly host: string;
  private readonly statusProvider: () => ListenerStatus;
  private readonly storage: StorageAdapter;
  private readonly merchantId: string;
  private readonly apiKey?: string;
  private readonly corsOrigins: string[];
  private readonly evmXpub?: string;
  private readonly baseUsdcAddress?: string;
  private readonly fixedEvmAddress?: string;
  private readonly fixedEvmChains: string[];
  private readonly fixedEvmTokens: string[];
  private readonly rateLimiter: SlidingWindowRateLimiter | null;
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
    this.evmXpub = opts.evmXpub;
    this.baseUsdcAddress = opts.baseUsdcAddress;
    this.fixedEvmAddress = opts.fixedEvmAddress;
    this.fixedEvmChains = (opts.fixedEvmChains ?? []).map((c) => c.toLowerCase());
    // Default to USDC-only so a fixed deployment with no MERCHANT_EVM_TOKENS set
    // behaves exactly as before USDT existed.
    this.fixedEvmTokens = (opts.fixedEvmTokens ?? ['usdc']).map((t) => t.toLowerCase());
    // rateLimit === undefined → default limiter; null → disabled.
    this.rateLimiter =
      opts.rateLimit === null
        ? null
        : new SlidingWindowRateLimiter(opts.rateLimit ?? undefined);
    this.log = opts.logger ?? noopLogger;
  }

  /** Best-effort client IP for rate-limit bucketing. */
  private clientIp(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      const first = fwd.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** True when chain is served by the fixed-address (xpub-less) USDC mode. */
  private fixedModeFor(alias: string): boolean {
    if (!this.fixedEvmAddress) return false;
    const spec = lookupEvmChain(alias);
    return spec !== null && this.fixedEvmChains.includes(spec.chain);
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

  /** OS-assigned port after start() — useful when constructed with port 0. */
  get boundPort(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
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
      // Rate limit BEFORE auth so a flood is bounded even without a valid key
      // (DoS / nonce-pool-exhaustion defense, Z76 FIX 3). Local Map only.
      if (this.rateLimiter) {
        const ip = this.clientIp(req);
        const decision = this.rateLimiter.hit(ip);
        if (!decision.allowed) {
          if (decision.retryAfterSeconds) {
            res.setHeader('retry-after', String(decision.retryAfterSeconds));
          }
          this.log.warn('http_server.rate_limited', { ip, scope: decision.scope });
          this.sendJson(res, 429, {
            error: {
              code: 'rate_limited',
              message: `too many invoice requests (${decision.scope} limit) — slow down`,
            },
          });
          return;
        }
      }
      if (this.apiKey) {
        const got = String(req.headers['x-zettapay-api-key'] ?? '');
        if (!timingSafeStrEqual(got, this.apiKey)) {
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
      // chain is optional and defaults to 'btc' — a body with no chain (or
      // chain:'btc') takes the exact same path it did before base existed.
      const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : 'btc';
      if (chain === 'base') {
        // xpub mode (per-invoice derived address) takes precedence — it is the
        // more secure path. Fixed mode is the xpub-less fallback.
        if (this.evmXpub) {
          await this.handleCreateBaseInvoice(body, res);
          return;
        }
        if (this.fixedModeFor('base')) {
          await this.handleCreateFixedInvoice('base', body, res);
          return;
        }
        await this.handleCreateBaseInvoice(body, res); // emits base_disabled
        return;
      }
      if (chain === 'ethereum' || chain === 'polygon') {
        if (this.fixedModeFor(chain)) {
          await this.handleCreateFixedInvoice(chain, body, res);
          return;
        }
        this.sendJson(res, 400, {
          error: {
            code: 'chain_disabled',
            message: `chain "${chain}" is not enabled — set MERCHANT_EVM_ADDRESS + MERCHANT_EVM_CHAINS to accept USDC`,
          },
        });
        return;
      }
      if (chain !== 'btc') {
        this.sendJson(res, 400, {
          error: { code: 'unsupported_chain', message: `chain "${chain}" is not supported` },
        });
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

  private async handleCreateBaseInvoice(
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.evmXpub) {
      this.sendJson(res, 400, {
        error: {
          code: 'base_disabled',
          message: 'chain "base" is not enabled — set MERCHANT_XPUB_EVM to accept USDC on Base',
        },
      });
      return;
    }
    const amountUsd = Number(body.amount_usd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      this.sendJson(res, 400, {
        error: { code: 'invalid_amount', message: 'amount_usd must be a positive number' },
      });
      return;
    }
    const expiresIn =
      Number.isInteger(body.expires_in) && (body.expires_in as number) > 0
        ? (body.expires_in as number)
        : undefined;
    try {
      const r = await createBaseInvoiceForMerchant(this.storage, this.merchantId, {
        amountUsd,
        evmXpub: this.evmXpub,
        usdcAddress: this.baseUsdcAddress,
        expiresInSeconds: expiresIn,
      });
      this.log.info('http_server.base_invoice_created', {
        invoice_id: r.invoice.id,
        address: r.invoice.address,
        amount_usd: amountUsd,
      });
      this.sendJson(res, 201, {
        ...serializeInvoice(r.invoice),
        derivation_path: r.path,
        amount_usd: amountUsd,
        amount_usdc: r.amountUsdc,
        amount_usdc_units: r.amountUsdcUnits,
        qr_uri: r.eip681,
        verify_url: `https://basescan.org/address/${r.invoice.address}`,
      });
    } catch (e) {
      this.sendJson(res, 500, { error: { code: 'create_failed', message: (e as Error).message } });
    }
  }

  /**
   * Fixed-address (xpub-less) USDC invoice. Shares ONE receive address; the
   * payer is identified by a per-invoice nonce in the amount's low decimals.
   * TTL is 1h so nonces recycle.
   */
  private async handleCreateFixedInvoice(
    chainAlias: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const spec = lookupEvmChain(chainAlias);
    if (!spec || !this.fixedEvmAddress) {
      this.sendJson(res, 400, {
        error: { code: 'chain_disabled', message: `chain "${chainAlias}" is not enabled` },
      });
      return;
    }
    const amountUsd = Number(body.amount_usd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      this.sendJson(res, 400, {
        error: { code: 'invalid_amount', message: 'amount_usd must be a positive number' },
      });
      return;
    }
    // Asset is optional and defaults to 'usdc' (Z77) — a body with no `asset`
    // takes the exact same path it did before USDT existed.
    const asset = typeof body.asset === 'string' ? body.asset.trim().toLowerCase() : 'usdc';
    if (!this.fixedEvmTokens.includes(asset)) {
      this.sendJson(res, 400, {
        error: {
          code: 'asset_disabled',
          message: `asset "${asset}" is not enabled — set MERCHANT_EVM_TOKENS to accept it`,
        },
      });
      return;
    }
    try {
      const r = await createFixedEvmInvoiceForMerchant(this.storage, this.merchantId, {
        amountUsd,
        fixedAddress: this.fixedEvmAddress,
        chainAlias,
        asset,
      });
      this.log.info('http_server.fixed_invoice_created', {
        invoice_id: r.invoice.id,
        chain: r.invoice.chain,
        asset: r.asset,
        nonce: r.nonce,
        amount_usd: amountUsd,
      });
      this.sendJson(res, 201, {
        ...serializeInvoice(r.invoice),
        mode: 'fixed-address',
        nonce: r.nonce,
        asset: r.asset,
        token_address: r.tokenAddress,
        amount_usd: amountUsd,
        amount_usdc: r.amountUsdc,
        amount_usdc_units: Number(r.amountUsdcUnits),
        qr_uri: r.eip681,
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Nonce-pool exhaustion is a transient capacity limit → 503, not a 500.
      const exhausted = msg.includes('nonce pool exhausted');
      this.sendJson(res, exhausted ? 503 : 500, {
        error: { code: exhausted ? 'capacity' : 'create_failed', message: msg },
      });
    }
  }
}
