// Subscription billing for the cloud tier.
//
// A plan is a flat monthly price that only raises the merchant's monthly invoice
// cap — there is no per-transaction fee and ZettaPay never touches the funds a
// merchant receives. The merchant picks how to pay for the plan:
//
//   * crypto — an ordinary ZettaPay invoice issued by the platform's own
//     merchant account (BILLING_MERCHANT_ID). When the watcher fleet confirms
//     it, the plan is activated for 30 days. Renewal is a new invoice.
//   * card   — a Stripe Checkout subscription. Stripe's webhook activates and
//     renews the plan; cancelling in Stripe lets it lapse back to free.
//
// Either way the outcome is the same two columns on the merchant row:
// `plan` and `plan_expires_at`.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createBaseInvoiceForMerchant,
  createFixedEvmInvoiceForMerchant,
  type Logger,
} from '@zettapay/listener';
import type { CloudDb, SubscriptionRow } from './cloud-db.js';
import type { PlanPrices } from './plans.js';
import { SupabaseStorageAdapter } from './storage.js';

const CRYPTO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
/** Slack after a Stripe period ends before the plan lapses (covers a late renewal charge). */
const STRIPE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_SIGNATURE_TOLERANCE_S = 300;
const DEFAULT_RECONCILE_MS = 30_000;

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
  /** Stripe Price id per plan (recurring, monthly). */
  priceIds: Record<string, string>;
}

export interface BillingOptions {
  db: CloudDb;
  storage: SupabaseStorageAdapter;
  prices: PlanPrices;
  /** Merchant that receives crypto subscription payments. Unset = crypto billing off. */
  billingMerchantId?: string;
  stripe?: StripeConfig;
  /** Site origin: hosted checkout lives at `${siteUrl}/checkout/:id`, the dashboard at `${siteUrl}/app`. */
  siteUrl?: string;
  reconcileMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
}

export interface CheckoutResult {
  subscription_id: string;
  method: 'crypto' | 'stripe';
  plan: string;
  amount_usd: number;
  checkout_url: string;
  invoice_id?: string;
}

export class Billing {
  private readonly db: CloudDb;
  private readonly storage: SupabaseStorageAdapter;
  private readonly prices: PlanPrices;
  private readonly billingMerchantId: string | null;
  private readonly stripe: StripeConfig | null;
  private readonly siteUrl: string | null;
  private readonly reconcileMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(opts: BillingOptions) {
    this.db = opts.db;
    this.storage = opts.storage;
    this.prices = opts.prices;
    this.billingMerchantId = opts.billingMerchantId || null;
    this.stripe = opts.stripe?.secretKey ? opts.stripe : null;
    this.siteUrl = opts.siteUrl ? opts.siteUrl.replace(/\/$/, '') : null;
    this.reconcileMs = opts.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
  }

  /** Payment methods a merchant can use right now. */
  get methods(): Array<'crypto' | 'stripe'> {
    const out: Array<'crypto' | 'stripe'> = [];
    if (this.billingMerchantId && this.siteUrl) out.push('crypto');
    if (this.stripe && this.siteUrl) out.push('stripe');
    return out;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.reconcile()
        .catch((err) => this.log.error('billing.reconcile_failed', err))
        .finally(() => this.schedule());
    }, this.reconcileMs);
  }

  private priceFor(plan: string): number {
    const price = this.prices[plan];
    if (typeof price !== 'number' || price <= 0) {
      throw new BillingError('unknown_plan', `plan "${plan}" is not purchasable`);
    }
    return price;
  }

  async createCheckout(
    merchantId: string,
    plan: string,
    method: string,
    asset = 'usdc',
  ): Promise<CheckoutResult> {
    const amountUsd = this.priceFor(plan);
    if (!this.methods.includes(method as 'crypto' | 'stripe')) {
      throw new BillingError('method_unavailable', `payment method "${method}" is not available`, 409);
    }
    return method === 'stripe'
      ? this.createStripeCheckout(merchantId, plan, amountUsd)
      : this.createCryptoCheckout(merchantId, plan, amountUsd, asset);
  }

  // --- crypto -------------------------------------------------------------

  private async createCryptoCheckout(
    merchantId: string,
    plan: string,
    amountUsd: number,
    asset: string,
  ): Promise<CheckoutResult> {
    const payee = this.billingMerchantId;
    if (!payee || !this.siteUrl) throw new BillingError('method_unavailable', 'crypto billing is not configured', 409);
    const cfg = await this.storage.getChainConfig(payee, 'base');
    if (!cfg) throw new BillingError('method_unavailable', 'crypto billing is not configured', 409);

    let invoiceId: string;
    if (cfg.xpub) {
      const r = await createBaseInvoiceForMerchant(this.storage, payee, { amountUsd, evmXpub: cfg.xpub });
      invoiceId = r.invoice.id;
    } else if (cfg.fixedAddress) {
      const r = await createFixedEvmInvoiceForMerchant(this.storage, payee, {
        amountUsd,
        fixedAddress: cfg.fixedAddress,
        chainAlias: 'base',
        asset: asset.trim().toLowerCase() === 'usdt' ? 'usdt' : 'usdc',
      });
      invoiceId = r.invoice.id;
    } else {
      throw new BillingError('method_unavailable', 'crypto billing is not configured', 409);
    }

    const sub: SubscriptionRow = {
      id: randomUUID(),
      merchant_id: merchantId,
      plan,
      method: 'crypto',
      status: 'pending',
      invoice_id: invoiceId,
      stripe_session_id: null,
      stripe_subscription_id: null,
      amount_usd: amountUsd,
      period_end: null,
      created_at: new Date(this.now()).toISOString(),
    };
    await this.db.insertSubscription(sub);
    return {
      subscription_id: sub.id,
      method: 'crypto',
      plan,
      amount_usd: amountUsd,
      invoice_id: invoiceId,
      checkout_url: `${this.siteUrl}/checkout/${invoiceId}`,
    };
  }

  /**
   * Settle pending crypto subscriptions: a confirmed invoice activates the plan
   * for 30 days (stacking on top of time still left on the same plan); an
   * invoice that expired or failed closes the attempt.
   */
  async reconcile(): Promise<void> {
    const pending = await this.db.listPendingCryptoSubscriptions();
    for (const sub of pending) {
      if (!sub.invoice_id) continue;
      const inv = await this.storage.getInvoice(sub.invoice_id);
      if (!inv) continue;
      const lapsed = inv.status === 'pending' && Date.parse(inv.expires_at) < this.now();
      if (inv.status === 'confirmed') {
        const merchant = await this.db.getMerchant(sub.merchant_id);
        const currentEnd = merchant?.plan === sub.plan && merchant.plan_expires_at ? Date.parse(merchant.plan_expires_at) : 0;
        const periodEnd = new Date(Math.max(this.now(), currentEnd) + CRYPTO_PERIOD_MS).toISOString();
        await this.activate(sub.merchant_id, sub.plan, periodEnd);
        await this.db.updateSubscription(sub.id, { status: 'active', period_end: periodEnd });
        this.log.info('billing.crypto_activated', { merchant_id: sub.merchant_id, plan: sub.plan });
      } else if (lapsed || inv.status === 'expired' || inv.status === 'failed') {
        await this.db.updateSubscription(sub.id, { status: 'expired' });
      }
    }
  }

  private async activate(merchantId: string, plan: string, periodEnd: string | null): Promise<void> {
    await this.db.updateMerchant(merchantId, { plan, plan_expires_at: periodEnd });
  }

  // --- stripe -------------------------------------------------------------

  private async stripeRequest(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const stripe = this.stripe;
    if (!stripe) throw new BillingError('method_unavailable', 'card billing is not configured', 409);
    const res = await this.fetchImpl(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${stripe.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      this.log.warn('billing.stripe_error', { path, status: res.status });
      throw new BillingError('stripe_error', 'the card processor rejected the request', 502);
    }
    return body;
  }

  private async createStripeCheckout(merchantId: string, plan: string, amountUsd: number): Promise<CheckoutResult> {
    const stripe = this.stripe;
    const priceId = stripe?.priceIds[plan];
    if (!stripe || !priceId || !this.siteUrl) {
      throw new BillingError('method_unavailable', 'card billing is not available for this plan', 409);
    }
    const merchant = await this.db.getMerchant(merchantId);
    const subId = randomUUID();
    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      client_reference_id: merchantId,
      success_url: `${this.siteUrl}/app?billing=success`,
      cancel_url: `${this.siteUrl}/app?billing=cancelled`,
      'metadata[merchant_id]': merchantId,
      'metadata[plan]': plan,
      'metadata[subscription_row]': subId,
      'subscription_data[metadata][merchant_id]': merchantId,
      'subscription_data[metadata][plan]': plan,
    };
    if (merchant?.email) form.customer_email = merchant.email;
    const session = await this.stripeRequest('/checkout/sessions', form);
    const url = typeof session.url === 'string' ? session.url : '';
    if (!url) throw new BillingError('stripe_error', 'the card processor returned no checkout link', 502);

    await this.db.insertSubscription({
      id: subId,
      merchant_id: merchantId,
      plan,
      method: 'stripe',
      status: 'pending',
      invoice_id: null,
      stripe_session_id: typeof session.id === 'string' ? session.id : null,
      stripe_subscription_id: null,
      amount_usd: amountUsd,
      period_end: null,
      created_at: new Date(this.now()).toISOString(),
    });
    return { subscription_id: subId, method: 'stripe', plan, amount_usd: amountUsd, checkout_url: url };
  }

  /** Verify a `Stripe-Signature` header (scheme v1) against the raw request body. */
  verifyStripeSignature(rawBody: string, header: string | undefined): boolean {
    const secret = this.stripe?.webhookSecret;
    if (!secret || !header) return false;
    let timestamp = '';
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [k, v] = part.split('=');
      if (k === 't' && v) timestamp = v;
      if (k === 'v1' && v) signatures.push(v);
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.now() / 1000 - ts) > STRIPE_SIGNATURE_TOLERANCE_S) return false;
    const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
    return signatures.some((sig) => {
      const got = Buffer.from(sig);
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
  }

  /**
   * Apply a verified Stripe event. Only three matter:
   *   checkout.session.completed    — first payment: activate the plan
   *   invoice.paid                  — renewal: push the period end forward
   *   customer.subscription.deleted — cancelled: back to free
   * Anything else is acknowledged and ignored.
   */
  async handleStripeEvent(event: Record<string, unknown>): Promise<void> {
    const type = String(event.type ?? '');
    const obj = ((event.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
    const metadata = (obj.metadata ?? {}) as Record<string, unknown>;

    if (type === 'checkout.session.completed') {
      const merchantId = String(metadata.merchant_id ?? obj.client_reference_id ?? '');
      const plan = String(metadata.plan ?? '');
      if (!merchantId || !plan || !(plan in this.prices)) return;
      const stripeSubId = typeof obj.subscription === 'string' ? obj.subscription : null;
      const periodEnd = new Date(this.now() + CRYPTO_PERIOD_MS + STRIPE_GRACE_MS).toISOString();
      await this.activate(merchantId, plan, periodEnd);
      const rowId = String(metadata.subscription_row ?? '');
      if (rowId) {
        await this.db.updateSubscription(rowId, {
          status: 'active',
          stripe_subscription_id: stripeSubId,
          period_end: periodEnd,
        });
      }
      this.log.info('billing.stripe_activated', { merchant_id: merchantId, plan });
      return;
    }

    if (type === 'invoice.paid') {
      const stripeSubId = typeof obj.subscription === 'string' ? obj.subscription : '';
      if (!stripeSubId) return;
      const sub = await this.db.findSubscriptionByStripeId(stripeSubId);
      if (!sub) return;
      const lines = ((obj.lines as Record<string, unknown> | undefined)?.data ?? []) as Array<Record<string, unknown>>;
      const lineEnd = Number((lines[0]?.period as Record<string, unknown> | undefined)?.end ?? 0);
      const base = lineEnd > 0 ? lineEnd * 1000 : this.now() + CRYPTO_PERIOD_MS;
      const periodEnd = new Date(base + STRIPE_GRACE_MS).toISOString();
      await this.activate(sub.merchant_id, sub.plan, periodEnd);
      await this.db.updateSubscription(sub.id, { status: 'active', period_end: periodEnd });
      return;
    }

    if (type === 'customer.subscription.deleted') {
      const stripeSubId = typeof obj.id === 'string' ? obj.id : '';
      const sub = stripeSubId ? await this.db.findSubscriptionByStripeId(stripeSubId) : null;
      if (!sub) return;
      await this.db.updateSubscription(sub.id, { status: 'canceled' });
      const merchant = await this.db.getMerchant(sub.merchant_id);
      // Only downgrade when the cancelled subscription is the one backing the
      // merchant's current plan (they may have since paid in crypto).
      if (merchant?.plan === sub.plan) await this.activate(sub.merchant_id, 'free', null);
    }
  }
}
