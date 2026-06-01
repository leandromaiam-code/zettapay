#!/usr/bin/env node
// CloudApiServer — the multi-tenant HTTP surface. It deliberately mirrors the
// self-hosted listener's HTTP API shape (same response fields) so the SDK, MCP
// server and OpenAPI spec work against the cloud base URL with zero changes —
// no lock-in. Every authed request is scoped to the merchant resolved from the
// API key; one tenant can never read or create another tenant's invoices.
//
// NON-CUSTODIAL: invoice addresses are derived from the merchant's PUBLIC xpub
// (BTC) or a fixed public receive address + per-invoice nonce (Base). No signing
// material is ever involved.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildBip21Uri,
  buildEvmUsdcUri,
  createBaseInvoiceForMerchant,
  createFixedEvmInvoiceForMerchant,
  createInvoiceForMerchant,
  formatUsdc,
  lookupEvmChain,
  NONCE_MODULUS,
  type Invoice,
  type Logger,
} from '@zettapay/listener';
import type { CloudDb } from './cloud-db.js';
import { SupabaseStorageAdapter } from './storage.js';
import { SupabaseRestDb } from './supabase-db.js';
import { startCloudFleet } from './webhook-fleet.js';
import { authenticate, CloudRateLimiter, type RateLimitConfig } from './auth.js';

const MAX_BODY_BYTES = 16 * 1024;
const API_PREFIX = '/api/v1';
const DEFAULT_CHECKOUT_BASE_URL = 'https://zettapay.4profitai.com';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CloudApiServerOptions {
  storage: SupabaseStorageAdapter;
  db: CloudDb;
  port?: number;
  host?: string;
  rateLimit?: RateLimitConfig | null;
  logger?: Logger;
  /** Base origin for the hosted checkout link returned by POST /invoice. */
  checkoutBaseUrl?: string;
}

export class CloudApiServer {
  private readonly storage: SupabaseStorageAdapter;
  private readonly db: CloudDb;
  private readonly port: number;
  private readonly host: string;
  private readonly limiter: CloudRateLimiter | null;
  private readonly log: Logger;
  private readonly checkoutBaseUrl: string;
  private server: Server | null = null;

  constructor(opts: CloudApiServerOptions) {
    this.storage = opts.storage;
    this.db = opts.db;
    this.port = opts.port ?? 8080;
    this.host = opts.host ?? '0.0.0.0';
    this.limiter = opts.rateLimit === null ? null : new CloudRateLimiter(opts.rateLimit ?? undefined);
    this.log = opts.logger ?? noopLogger;
    this.checkoutBaseUrl = (opts.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL).replace(/\/$/, '');
  }

  /** Hosted checkout link a payer opens to settle this invoice. */
  private checkoutUrl(invoiceId: string): string {
    return `${this.checkoutBaseUrl}/checkout/${invoiceId}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.host, () => resolve());
    });
    this.log.info('cloud_api.listening', { port: this.boundPort, host: this.host });
  }

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

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }

  /** JSON reply for the public checkout surface — open CORS, read-only. */
  private sendPublic(res: ServerResponse, code: number, body: unknown): void {
    this.applyCors(res);
    this.send(res, code, body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    if (method === 'GET' && path === `${API_PREFIX}/health`) {
      this.send(res, 200, { ok: true, service: 'zettapay-cloud', ts: new Date().toISOString() });
      return;
    }

    if (method === 'POST' && path === `${API_PREFIX}/invoice`) {
      await this.handleCreateInvoice(req, res);
      return;
    }

    if (method === 'GET' && path.startsWith(`${API_PREFIX}/invoice/`)) {
      await this.handleGetInvoice(req, res, path.slice(`${API_PREFIX}/invoice/`.length));
      return;
    }

    // Public, unauthenticated checkout view — the payer has no API key. Only
    // safe display fields are returned (see buildCheckoutView).
    if (method === 'OPTIONS' && path.startsWith(`${API_PREFIX}/checkout/`)) {
      this.applyCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === 'GET' && path.startsWith(`${API_PREFIX}/checkout/`)) {
      await this.handleGetCheckout(res, path.slice(`${API_PREFIX}/checkout/`.length));
      return;
    }

    this.send(res, 404, { error: { code: 'not_found' } });
  }

  /** Resolve the merchant from the API key header, or null after sending 401. */
  private async requireMerchant(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    const header = req.headers['x-zettapay-api-key'];
    const presented = Array.isArray(header) ? header[0] : header;
    const auth = await authenticate(this.db, presented);
    if (!auth.ok || !auth.merchantId) {
      this.send(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid api key' } });
      return null;
    }
    return auth.merchantId;
  }

  private async handleCreateInvoice(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const merchantId = await this.requireMerchant(req, res);
    if (!merchantId) return;

    if (this.limiter) {
      const decision = this.limiter.hit(merchantId);
      if (!decision.allowed) {
        if (decision.retryAfterSeconds) res.setHeader('retry-after', String(decision.retryAfterSeconds));
        this.send(res, 429, { error: { code: 'rate_limited', message: 'too many invoice requests' } });
        return;
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      this.send(res, 400, { error: { code: 'bad_body', message: (e as Error).message } });
      return;
    }

    const chain = typeof body.chain === 'string' ? body.chain.toLowerCase() : 'btc';
    try {
      if (chain === 'btc') {
        await this.createBtc(merchantId, body, res);
        return;
      }
      if (chain === 'base') {
        await this.createBase(merchantId, body, res);
        return;
      }
      this.send(res, 400, { error: { code: 'unsupported_chain', message: `chain "${chain}" is not supported` } });
    } catch (e) {
      this.send(res, 500, { error: { code: 'create_failed', message: (e as Error).message } });
    }
  }

  private async createBtc(merchantId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const amountSats = Number(body.amount_sats);
    if (!Number.isInteger(amountSats) || amountSats <= 0) {
      this.send(res, 400, { error: { code: 'invalid_amount', message: 'amount_sats must be a positive integer' } });
      return;
    }
    const memo = typeof body.memo === 'string' ? body.memo.slice(0, 200) : undefined;
    const r = await createInvoiceForMerchant(this.storage, merchantId, { amountSats, memo });
    this.send(res, 201, {
      ...serializeInvoice(r.invoice),
      derivation_path: r.path,
      network: r.network,
      amount_sats: r.amountSats,
      qr_uri: r.bip21,
      verify_url: `https://mempool.space/address/${r.invoice.address}`,
      checkout_url: this.checkoutUrl(r.invoice.id),
    });
  }

  private async createBase(merchantId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const amountUsd = Number(body.amount_usd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      this.send(res, 400, { error: { code: 'invalid_amount', message: 'amount_usd must be a positive number' } });
      return;
    }
    const cfg = await this.storage.getChainConfig(merchantId, 'base');
    if (!cfg) {
      this.send(res, 400, { error: { code: 'chain_disabled', message: 'merchant has no base chain configured' } });
      return;
    }
    // xpub mode (per-invoice derived address) is preferred; fixed-address mode is
    // the xpub-less fallback (one address + per-invoice nonce in the USDC decimals).
    if (cfg.xpub) {
      const r = await createBaseInvoiceForMerchant(this.storage, merchantId, {
        amountUsd,
        evmXpub: cfg.xpub,
      });
      this.send(res, 201, {
        ...serializeInvoice(r.invoice),
        derivation_path: r.path,
        amount_usd: amountUsd,
        amount_usdc: r.amountUsdc,
        amount_usdc_units: r.amountUsdcUnits,
        qr_uri: r.eip681,
        verify_url: `https://basescan.org/address/${r.invoice.address}`,
        checkout_url: this.checkoutUrl(r.invoice.id),
      });
      return;
    }
    if (cfg.fixedAddress) {
      const asset = typeof body.asset === 'string' ? body.asset.trim().toLowerCase() : 'usdc';
      const r = await createFixedEvmInvoiceForMerchant(this.storage, merchantId, {
        amountUsd,
        fixedAddress: cfg.fixedAddress,
        chainAlias: 'base',
        asset,
      });
      this.send(res, 201, {
        ...serializeInvoice(r.invoice),
        mode: 'fixed-address',
        nonce: r.nonce,
        asset: r.asset,
        token_address: r.tokenAddress,
        amount_usd: amountUsd,
        amount_usdc: r.amountUsdc,
        amount_usdc_units: Number(r.amountUsdcUnits),
        qr_uri: r.eip681,
        checkout_url: this.checkoutUrl(r.invoice.id),
      });
      return;
    }
    this.send(res, 400, { error: { code: 'chain_disabled', message: 'base chain has neither xpub nor fixed address' } });
  }

  private async handleGetInvoice(req: IncomingMessage, res: ServerResponse, rawId: string): Promise<void> {
    const merchantId = await this.requireMerchant(req, res);
    if (!merchantId) return;
    const id = decodeURIComponent(rawId);
    if (!id) {
      this.send(res, 400, { error: { code: 'missing_id' } });
      return;
    }
    const inv = await this.storage.getInvoice(id);
    // Tenant isolation: an invoice owned by another merchant is reported as a
    // plain 404 — its existence is never leaked across tenants.
    if (!inv || inv.merchant_id !== merchantId) {
      this.send(res, 404, { error: { code: 'not_found' } });
      return;
    }
    this.send(res, 200, serializeInvoice(inv));
  }

  /**
   * PUBLIC checkout view — no API key. The payer who opens the hosted checkout
   * link has no credentials, so this returns ONLY the fields needed to render a
   * payment screen (shop name for branding, amount, receive address, QR URI,
   * status, countdown). It deliberately never exposes the merchant's xpub,
   * webhook secret, API key, email, or any other invoice/merchant.
   */
  private async handleGetCheckout(res: ServerResponse, rawId: string): Promise<void> {
    const id = decodeURIComponent(rawId);
    if (!id) {
      this.sendPublic(res, 400, { error: { code: 'missing_id' } });
      return;
    }
    const inv = await this.storage.getInvoice(id);
    if (!inv) {
      this.sendPublic(res, 404, { error: { code: 'not_found' } });
      return;
    }
    const merchant = await this.storage.getMerchant(inv.merchant_id);
    this.sendPublic(res, 200, buildCheckoutView(inv, merchant?.shop_name ?? ''));
  }
}

/**
 * Project an invoice down to the minimal, non-secret display surface a payer
 * needs. Only public on-chain material (address, amount, tx hash) plus the shop
 * name for branding is included — never xpub, webhook secret, API key, email,
 * or the internal merchant id.
 */
export function buildCheckoutView(inv: Invoice, shopName: string): Record<string, unknown> {
  const isBtc = inv.chain === 'btc';
  const addrBase = isBtc ? 'https://mempool.space/address/' : 'https://basescan.org/address/';
  const txBase = isBtc ? 'https://mempool.space/tx/' : 'https://basescan.org/tx/';
  const view: Record<string, unknown> = {
    invoice_id: inv.id,
    shop_name: shopName,
    chain: inv.chain,
    asset: inv.asset,
    status: inv.status,
    receive_address: inv.address,
    expires_at: inv.expires_at,
    created_at: inv.created_at,
    tx_hash: inv.tx_hash,
    paid_at: inv.paid_at,
    verify_url: `${addrBase}${inv.address}`,
    tx_url: inv.tx_hash ? `${txBase}${inv.tx_hash}` : null,
  };

  if (isBtc) {
    view.amount_btc = inv.amount;
    view.qr_uri = buildBip21Uri(inv.address, btcToSats(inv.amount));
    return view;
  }

  // EVM (USDC/USDT on Base): amount is stored as integer token base units.
  const units = safeBigInt(inv.amount);
  view.amount_usdc_units = Number(units);
  view.amount_usdc = formatUsdc(Number(units));
  const spec = lookupEvmChain(inv.chain);
  const token = spec?.tokens.find((t) => t.symbol.toUpperCase() === inv.asset.toUpperCase());
  if (spec && token) {
    view.qr_uri = buildEvmUsdcUri(inv.address, units, token.address, spec.chainId);
  }
  // Fixed-address mode (no HD child index) carries the payer nonce in the low
  // USDC decimals; surface it so the checkout can display the exact amount.
  if (inv.child_index === null) {
    view.nonce = Number(units % BigInt(NONCE_MODULUS));
  }
  return view;
}

function btcToSats(amountBtc: string): number {
  return Math.round(Number(amountBtc) * 100_000_000);
}

function safeBigInt(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

export function serializeInvoice(inv: Invoice): Record<string, unknown> {
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

const consoleLogger: Logger = {
  info: (msg, meta) => process.stdout.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  warn: (msg, meta) => process.stderr.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  error: (msg, meta) => process.stderr.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
};

/** Bootstrap: shared Supabase DB → adapter → API server + watcher fleet. */
async function main(): Promise<void> {
  const db = SupabaseRestDb.fromEnv(process.env);
  const storage = new SupabaseStorageAdapter(db);
  const server = new CloudApiServer({
    storage,
    db,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    host: process.env.HOST,
    checkoutBaseUrl: process.env.CHECKOUT_BASE_URL,
    logger: consoleLogger,
  });
  const fleet = await startCloudFleet({
    storage,
    btcWsUrl: process.env.BTC_WS_URL,
    btcRestBase: process.env.BTC_REST_BASE,
    baseRpcUrl: process.env.BASE_RPC_URL,
    logger: consoleLogger,
  });
  await server.start();

  const shutdown = (): void => {
    void Promise.allSettled([server.stop(), fleet.stop()]).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`@zettapay/cloud failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
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
