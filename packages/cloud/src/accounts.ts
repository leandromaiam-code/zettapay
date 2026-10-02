// Self-serve merchant accounts.
//
// Signup takes only public material — email, shop name, and at least one way to
// receive (a BIP-84 xpub for Bitcoin and/or, for Base, an xpub or a fixed
// address) — and returns the API key exactly once. The dashboard then
// authenticates with that API key like any other client; there is no password
// and no wallet connection.
//
// NON-CUSTODIAL: an extended PRIVATE key is rejected on sight and never stored.

import { randomBytes, randomUUID } from 'node:crypto';
import { isValidEvmAddress } from '@zettapay/listener';
import { generateApiKey } from './auth.js';
import type { CloudDb, InvoiceRow, MerchantChainRow } from './cloud-db.js';
import { assertPublicHttpsUrl, UnsafeUrlError, type LookupFn } from './net-guard.js';
import { DEFAULT_PLAN, effectivePlan, limitForPlan, monthStartIso, type PlanLimits } from './plans.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BASE58 = '[1-9A-HJ-NP-Za-km-z]';
/** Extended PUBLIC keys: mainnet BIP-32/49/84 version prefixes. */
const XPUB_RE = new RegExp(`^(xpub|ypub|zpub)${BASE58}{100,112}$`);
/** Extended PRIVATE keys — must never be accepted, logged or stored. */
const XPRV_RE = /^(xprv|yprv|zprv|tprv|uprv|vprv)/i;

export class AccountError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface SignupInput {
  email?: unknown;
  shop_name?: unknown;
  btc_xpub?: unknown;
  base_xpub?: unknown;
  base_address?: unknown;
  webhook_url?: unknown;
}

export interface SignupResult {
  merchant_id: string;
  plan: string;
  /** Shown once. Only its SHA-256 hash is stored. */
  api_key: string;
  key_prefix: string;
  /** HMAC secret for webhook verification; present when a webhook URL was given. Shown once. */
  webhook_secret?: string;
}

export interface AccountsOptions {
  db: CloudDb;
  planLimits: PlanLimits | null;
  /** DNS seam for the webhook-URL guard (tests). */
  lookup?: LookupFn;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

export class Accounts {
  private readonly db: CloudDb;
  private readonly planLimits: PlanLimits | null;
  private readonly lookup: LookupFn | undefined;

  constructor(opts: AccountsOptions) {
    this.db = opts.db;
    this.planLimits = opts.planLimits;
    this.lookup = opts.lookup;
  }

  private checkXpub(field: string, value: string): void {
    if (XPRV_RE.test(value)) {
      throw new AccountError(
        'private_key_rejected',
        `${field} looks like a PRIVATE key. ZettaPay only ever takes a public key — never share a private key or seed.`,
      );
    }
    if (!XPUB_RE.test(value)) {
      throw new AccountError('invalid_xpub', `${field} is not a valid extended public key`);
    }
  }

  private async checkWebhookUrl(url: string): Promise<void> {
    try {
      await assertPublicHttpsUrl(url, this.lookup);
    } catch (err) {
      const reason = err instanceof UnsafeUrlError ? err.reason : 'not allowed';
      throw new AccountError('invalid_webhook_url', `webhook_url ${reason}`);
    }
  }

  async signup(input: SignupInput): Promise<SignupResult> {
    const email = str(input.email, 254).toLowerCase();
    const shopName = str(input.shop_name, 80);
    const btcXpub = str(input.btc_xpub, 200);
    const baseXpub = str(input.base_xpub, 200);
    const baseAddress = str(input.base_address, 64);
    const webhookUrl = str(input.webhook_url, 500);

    if (!EMAIL_RE.test(email)) throw new AccountError('invalid_email', 'a valid email is required');
    if (shopName.length < 2) throw new AccountError('invalid_shop_name', 'shop_name is required');
    if (!btcXpub && !baseXpub && !baseAddress) {
      throw new AccountError(
        'no_receive_method',
        'provide a Bitcoin xpub and/or a Base xpub or receive address',
      );
    }
    if (btcXpub) this.checkXpub('btc_xpub', btcXpub);
    if (baseXpub) this.checkXpub('base_xpub', baseXpub);
    if (baseAddress && !isValidEvmAddress(baseAddress)) {
      throw new AccountError('invalid_address', 'base_address is not a valid EVM address');
    }
    if (webhookUrl) await this.checkWebhookUrl(webhookUrl);

    if (await this.db.findMerchantByEmail(email)) {
      throw new AccountError('email_taken', 'an account with this email already exists', 409);
    }

    const merchantId = randomUUID();
    const now = new Date().toISOString();
    await this.db.insertMerchant({
      id: merchantId,
      auth_uid: null,
      email,
      name: shopName,
      plan: DEFAULT_PLAN,
      created_at: now,
    });

    const chain = (row: Pick<MerchantChainRow, 'chain' | 'xpub' | 'fixed_address'>): MerchantChainRow => ({
      id: randomUUID(),
      merchant_id: merchantId,
      evm_tokens: null,
      next_child_index: 0,
      created_at: now,
      ...row,
    });
    if (btcXpub) await this.db.insertChain(chain({ chain: 'btc', xpub: btcXpub, fixed_address: null }));
    if (baseXpub || baseAddress) {
      // xpub mode wins when both are given (one address per invoice).
      await this.db.insertChain(
        chain({ chain: 'base', xpub: baseXpub || null, fixed_address: baseXpub ? null : baseAddress }),
      );
    }

    let webhookSecret: string | undefined;
    if (webhookUrl) {
      webhookSecret = newWebhookSecret();
      await this.db.insertWebhook({
        id: randomUUID(),
        merchant_id: merchantId,
        url: webhookUrl,
        secret_enc: webhookSecret,
        created_at: now,
      });
    }

    const key = generateApiKey();
    await this.db.insertApiKey({
      id: randomUUID(),
      merchant_id: merchantId,
      api_key_hash: key.hash,
      key_prefix: key.prefix,
      label: 'signup',
      created_at: now,
      revoked_at: null,
    });

    return {
      merchant_id: merchantId,
      plan: DEFAULT_PLAN,
      api_key: key.key,
      key_prefix: key.prefix,
      ...(webhookSecret ? { webhook_secret: webhookSecret } : {}),
    };
  }

  /** Everything the dashboard shows about the signed-in merchant. No secrets. */
  async overview(merchantId: string): Promise<Record<string, unknown>> {
    const merchant = await this.db.getMerchant(merchantId);
    if (!merchant) throw new AccountError('not_found', 'merchant not found', 404);
    const [chains, webhook, keys, used] = await Promise.all([
      this.db.getChains(merchantId),
      this.db.getWebhook(merchantId),
      this.db.listApiKeys(merchantId),
      this.db.countInvoicesSince(merchantId, monthStartIso()),
    ]);
    const plan = effectivePlan(merchant);
    const limit = this.planLimits ? limitForPlan(this.planLimits, plan) : null;
    return {
      merchant_id: merchant.id,
      shop_name: merchant.name,
      email: merchant.email,
      plan,
      plan_expires_at: plan === DEFAULT_PLAN ? null : (merchant.plan_expires_at ?? null),
      usage: { invoices_this_month: used, monthly_limit: limit },
      chains: chains.map((c) => ({
        chain: c.chain,
        mode: c.xpub ? 'xpub' : 'fixed-address',
        // Public material, shortened only for display.
        xpub: c.xpub ? `${c.xpub.slice(0, 12)}…${c.xpub.slice(-6)}` : null,
        fixed_address: c.fixed_address,
      })),
      webhook_url: webhook?.url ?? null,
      api_keys: keys.map((k) => ({ prefix: k.key_prefix, label: k.label, created_at: k.created_at, revoked: !!k.revoked_at })),
      created_at: merchant.created_at,
    };
  }

  async recentInvoices(merchantId: string, limit: number): Promise<InvoiceRow[]> {
    return this.db.listInvoicesForMerchant(merchantId, Math.min(Math.max(limit, 1), 100));
  }

  /** Set or replace the webhook endpoint. Returns a fresh signing secret, shown once. */
  async setWebhook(merchantId: string, rawUrl: unknown): Promise<{ webhook_url: string; webhook_secret: string }> {
    const url = str(rawUrl, 500);
    if (!url) throw new AccountError('invalid_webhook_url', 'webhook_url is required');
    await this.checkWebhookUrl(url);
    const secret = newWebhookSecret();
    const existing = await this.db.getWebhook(merchantId);
    if (existing) {
      await this.db.updateWebhook(existing.id, { url, secret_enc: secret });
    } else {
      await this.db.insertWebhook({
        id: randomUUID(),
        merchant_id: merchantId,
        url,
        secret_enc: secret,
        created_at: new Date().toISOString(),
      });
    }
    return { webhook_url: url, webhook_secret: secret };
  }
}
