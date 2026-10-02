// Cloud plans. The managed tier is billed by a flat subscription per plan; the
// only thing a plan gates is how many invoices a merchant may create per
// calendar month (UTC). There is no per-transaction fee anywhere — funds settle
// straight into the merchant's wallet and ZettaPay is never in the flow.
//
// The self-hosted listener has no plans and no limits; this module is cloud-only.

export const DEFAULT_PLAN = 'free';

/** Invoices per calendar month. `null` means unlimited. */
export type PlanLimits = Record<string, number | null>;

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  free: 50,
  starter: 500,
  pro: 5000,
  unlimited: null,
};

/**
 * Parse an operator override (`PLAN_LIMITS` env, JSON object of plan → monthly
 * invoice cap, `null` for unlimited). Unknown or malformed input falls back to
 * the defaults so a typo can never silently lift every limit.
 */
export function parsePlanLimits(raw: string | undefined): PlanLimits {
  if (!raw) return DEFAULT_PLAN_LIMITS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return DEFAULT_PLAN_LIMITS;
    }
    const out: PlanLimits = {};
    for (const [plan, limit] of Object.entries(parsed)) {
      if (limit === null) out[plan] = null;
      else if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) out[plan] = limit;
      else return DEFAULT_PLAN_LIMITS;
    }
    return Object.keys(out).length > 0 ? out : DEFAULT_PLAN_LIMITS;
  } catch {
    return DEFAULT_PLAN_LIMITS;
  }
}

/** Monthly cap for a plan. An unknown plan name is treated as the default plan. */
export function limitForPlan(limits: PlanLimits, plan: string | null | undefined): number | null {
  const name = plan && plan in limits ? plan : DEFAULT_PLAN;
  const limit = limits[name];
  return limit === undefined ? 0 : limit;
}

/** ISO timestamp of the first instant of the current UTC calendar month. */
export function monthStartIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Monthly subscription price per paid plan, in USD. Free and unlimited are not for sale. */
export type PlanPrices = Record<string, number>;

export const DEFAULT_PLAN_PRICES: PlanPrices = {
  starter: 19,
  pro: 49,
};

/** Parse an operator override (`PLAN_PRICES` env, JSON object of plan → USD/month). */
export function parsePlanPrices(raw: string | undefined): PlanPrices {
  if (!raw) return DEFAULT_PLAN_PRICES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_PLAN_PRICES;
    const out: PlanPrices = {};
    for (const [plan, price] of Object.entries(parsed)) {
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) out[plan] = price;
      else return DEFAULT_PLAN_PRICES;
    }
    return Object.keys(out).length > 0 ? out : DEFAULT_PLAN_PRICES;
  } catch {
    return DEFAULT_PLAN_PRICES;
  }
}

/**
 * The plan a merchant is actually on right now: a paid plan whose period has
 * ended counts as the default plan until it is renewed. A plan with no expiry
 * (assigned by the operator) never lapses.
 */
export function effectivePlan(
  merchant: { plan?: string | null; plan_expires_at?: string | null } | null | undefined,
  now: number = Date.now(),
): string {
  const plan = merchant?.plan || DEFAULT_PLAN;
  if (plan === DEFAULT_PLAN) return plan;
  const expires = merchant?.plan_expires_at ? Date.parse(merchant.plan_expires_at) : NaN;
  if (Number.isFinite(expires) && expires < now) return DEFAULT_PLAN;
  return plan;
}
