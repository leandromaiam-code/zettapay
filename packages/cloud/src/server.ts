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
import { AccountError, Accounts } from './accounts.js';
import { Billing, BillingError } from './billing.js';
import {
  DEFAULT_PLAN_LIMITS,
  DEFAULT_PLAN_PRICES,
  effectivePlan,
  limitForPlan,
  monthStartIso,
  parsePlanLimits,
  parsePlanPrices,
  type PlanLimits,
  type PlanPrices,
} from './plans.js';

const MAX_BODY_BYTES = 16 * 1024;
/** Stripe events can be larger than our own request bodies. */
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024;
/** Open signup is throttled per client address. */
const SIGNUP_RATE_LIMIT: RateLimitConfig = { perKeyPerWindow: 5, windowMs: 60 * 60 * 1000 };
const API_PREFIX = '/api/v1';

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
  /**
   * Base origin for the hosted checkout link returned by POST /invoice. There is
   * no built-in default: when unset, responses simply omit `checkout_url`.
   */
  checkoutBaseUrl?: string;
  /** Monthly invoice cap per plan. `null` disables plan enforcement entirely. */
  planLimits?: PlanLimits | null;
  /** Monthly price per paid plan (USD), shown by GET /plans. */
  planPrices?: PlanPrices;
  /** Self-serve accounts (signup + dashboard). Built from `db` when omitted. */
  accounts?: Accounts;
  /** Subscription billing. When omitted, plans can only be assigned by the operator. */
  billing?: Billing | null;
  /** Per-address signup throttle. `null` disables it (tests). */
  signupRateLimit?: RateLimitConfig | null;
}

export class CloudApiServer {
  private readonly storage: SupabaseStorageAdapter;
  private readonly db: CloudDb;
  private readonly port: number;
  private readonly host: string;
  private readonly limiter: CloudRateLimiter | null;
  private readonly log: Logger;
  private readonly checkoutBaseUrl: string | null;
  private readonly planLimits: PlanLimits | null;
  private readonly planPrices: PlanPrices;
  private readonly accounts: Accounts;
  private readonly billing: Billing | null;
  private readonly signupLimiter: CloudRateLimiter | null;
  private server: Server | null = null;

  constructor(opts: CloudApiServerOptions) {
    this.storage = opts.storage;
    this.db = opts.db;
    this.port = opts.port ?? 8080;
    this.host = opts.host ?? '0.0.0.0';
    this.limiter = opts.rateLimit === null ? null : new CloudRateLimiter(opts.rateLimit ?? undefined);
    this.log = opts.logger ?? noopLogger;
    this.planLimits = opts.planLimits === null ? null : (opts.planLimits ?? DEFAULT_PLAN_LIMITS);
    this.planPrices = opts.planPrices ?? DEFAULT_PLAN_PRICES;
    this.accounts = opts.accounts ?? new Accounts({ db: this.db, planLimits: this.planLimits });
    this.billing = opts.billing ?? null;
    this.signupLimiter =
      opts.signupRateLimit === null ? null : new CloudRateLimiter(opts.signupRateLimit ?? SIGNUP_RATE_LIMIT);
    this.checkoutBaseUrl = opts.checkoutBaseUrl ? opts.checkoutBaseUrl.replace(/\/$/, '') : null;
  }

  /** Hosted checkout link a payer opens to settle this invoice. */
  private checkoutUrl(invoiceId: string): string | undefined {
    if (!this.checkoutBaseUrl) return undefined;
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

    if (method === 'GET' && path === `${API_PREFIX}/plans`) {
      this.sendPublic(res, 200, this.describePlans());
      return;
    }
    if (method === 'POST' && path === `${API_PREFIX}/signup`) {
      await this.handleSignup(req, res);
      return;
    }
    if (method === 'GET' && path === `${API_PREFIX}/me`) {
      await this.withMerchant(req, res, (id) => this.accounts.overview(id));
      return;
    }
    if (method === 'GET' && path === `${API_PREFIX}/invoices`) {
      const limit = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? 25);
      await this.withMerchant(req, res, async (id) => ({
        invoices: (await this.accounts.recentInvoices(id, Number.isFinite(limit) ? limit : 25)).map(serializeInvoiceRow),
      }));
      return;
    }
    if (method === 'POST' && path === `${API_PREFIX}/webhook`) {
      await this.withMerchant(req, res, async (id) => {
        const body = await readJsonBody(req);
        return this.accounts.setWebhook(id, body.webhook_url);
      });
      return;
    }
    if (method === 'POST' && path === `${API_PREFIX}/billing/checkout`) {
      await this.withMerchant(req, res, async (id) => {
        if (!this.billing) throw new BillingError('method_unavailable', 'billing is not enabled', 409);
        const body = await readJsonBody(req);
        return this.billing.createCheckout(
          id,
          String(body.plan ?? ''),
          String(body.method ?? 'crypto'),
          typeof body.asset === 'string' ? body.asset : 'usdc',
        );
      });
      return;
    }
    if (method === 'POST' && path === `${API_PREFIX}/billing/stripe/webhook`) {
      await this.handleStripeWebhook(req, res);
      return;
    }

    this.send(res, 404, { error: { code: 'not_found' } });
  }

  /** Public plan catalogue: caps, prices and the payment methods on offer. */
  private describePlans(): Record<string, unknown> {
    const limits = this.planLimits ?? {};
    return {
      plans: Object.keys(limits)
        .filter((name) => name === 'free' || name in this.planPrices)
        .map((name) => ({
          plan: name,
          invoices_per_month: limits[name] ?? null,
          price_usd_per_month: this.planPrices[name] ?? 0,
        })),
      payment_methods: this.billing?.methods ?? [],
      transaction_fee: 0,
    };
  }

  private clientAddress(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    return first || req.socket.remoteAddress || 'unknown';
  }

  /** Run an authenticated JSON handler, mapping domain errors to HTTP replies. */
  private async withMerchant(
    req: IncomingMessage,
    res: ServerResponse,
    run: (merchantId: string) => Promise<unknown>,
  ): Promise<void> {
    const merchantId = await this.requireMerchant(req, res);
    if (!merchantId) return;
    try {
      this.send(res, 200, await run(merchantId));
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private sendError(res: ServerResponse, e: unknown): void {
    if (e instanceof AccountError || e instanceof BillingError) {
      this.send(res, e.status, { error: { code: e.code, message: e.message } });
      return;
    }
    const message = e instanceof Error ? e.message : 'unexpected error';
    if (message === 'body too large' || message === 'invalid JSON body') {
      this.send(res, 400, { error: { code: 'bad_body', message } });
      return;
    }
    this.log.error('cloud_api.request_failed', { message });
    this.send(res, 500, { error: { code: 'internal_error' } });
  }

  private async handleSignup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.signupLimiter) {
      const decision = this.signupLimiter.hit(this.clientAddress(req));
      if (!decision.allowed) {
        if (decision.retryAfterSeconds) res.setHeader('retry-after', String(decision.retryAfterSeconds));
        this.send(res, 429, { error: { code: 'rate_limited', message: 'too many signups from this address' } });
        return;
      }
    }
    try {
      const body = await readJsonBody(req);
      this.send(res, 201, await this.accounts.signup(body));
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private async handleStripeWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.billing) {
      this.send(res, 404, { error: { code: 'not_found' } });
      return;
    }
    let raw: string;
    try {
      raw = await readRawBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch {
      this.send(res, 400, { error: { code: 'bad_body' } });
      return;
    }
    const header = req.headers['stripe-signature'];
    if (!this.billing.verifyStripeSignature(raw, Array.isArray(header) ? header[0] : header)) {
      this.send(res, 400, { error: { code: 'bad_signature' } });
      return;
    }
    try {
      await this.billing.handleStripeEvent(JSON.parse(raw) as Record<string, unknown>);
      this.send(res, 200, { received: true });
    } catch (e) {
      // A 5xx makes Stripe retry, which is what we want when our database hiccups.
      this.log.error('cloud_api.stripe_event_failed', { message: e instanceof Error ? e.message : String(e) });
      this.send(res, 500, { error: { code: 'internal_error' } });
    }
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

    if (!(await this.withinPlan(merchantId, res))) return;

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

  /**
   * Plan gate: a merchant may create at most its plan's monthly invoice cap.
   * Replies 402 and returns false once the cap is reached. Existing invoices are
   * never affected — they keep being watched, confirmed and webhooked.
   */
  private async withinPlan(merchantId: string, res: ServerResponse): Promise<boolean> {
    if (!this.planLimits) return true;
    const merchant = await this.db.getMerchant(merchantId);
    const plan = effectivePlan(merchant);
    const limit = limitForPlan(this.planLimits, plan);
    if (limit === null) return true;
    const used = await this.db.countInvoicesSince(merchantId, monthStartIso());
    if (used < limit) return true;
    this.send(res, 402, {
      error: {
        code: 'plan_limit_reached',
        message: `plan "${plan}" allows ${limit} invoices per month`,
        plan,
        limit,
        used,
      },
    });
    return false;
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

/** Dashboard view of an invoice row (the merchant's own data; no secrets exist on it). */
function serializeInvoiceRow(row: {
  id: string;
  chain: string;
  asset: string;
  amount_units: string | null;
  address: string;
  status: string;
  tx_hash: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
}): Record<string, unknown> {
  const evm = row.chain !== 'btc';
  const units = Number(row.amount_units ?? '');
  return {
    invoice_id: row.id,
    chain: row.chain,
    asset: row.asset,
    amount: evm && Number.isInteger(units) ? formatUsdc(units) : (row.amount_units ?? ''),
    receive_address: row.address,
    status: row.status === 'pending' && Date.parse(row.expires_at) < Date.now() ? 'expired' : row.status,
    tx_hash: row.tx_hash,
    created_at: row.created_at,
    paid_at: row.paid_at,
    expires_at: row.expires_at,
  };
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  const env = process.env;
  const planLimits = parsePlanLimits(env.PLAN_LIMITS);
  const planPrices = parsePlanPrices(env.PLAN_PRICES);
  const stripePrices: Record<string, string> = {};
  if (env.STRIPE_PRICE_STARTER) stripePrices.starter = env.STRIPE_PRICE_STARTER;
  if (env.STRIPE_PRICE_PRO) stripePrices.pro = env.STRIPE_PRICE_PRO;
  const billing = new Billing({
    db,
    storage,
    prices: planPrices,
    billingMerchantId: env.BILLING_MERCHANT_ID,
    stripe: env.STRIPE_SECRET_KEY
      ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET, priceIds: stripePrices }
      : undefined,
    siteUrl: env.CHECKOUT_BASE_URL,
    logger: consoleLogger,
  });
  const server = new CloudApiServer({
    storage,
    db,
    planPrices,
    billing,
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    host: process.env.HOST,
    checkoutBaseUrl: process.env.CHECKOUT_BASE_URL,
    planLimits,
    logger: consoleLogger,
  });
  const fleet = await startCloudFleet({
    storage,
    btcWsUrl: process.env.BTC_WS_URL,
    btcRestBase: process.env.BTC_REST_BASE,
    baseRpcUrl: process.env.BASE_RPC_URL,
    db,
    baseRpcUrls: csv(env.BASE_RPC_URLS),
    logger: consoleLogger,
  });
  billing.start();
  await server.start();

  const shutdown = (): void => {
    billing.stop();
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

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRawBody(req, MAX_BODY_BYTES)).trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}
