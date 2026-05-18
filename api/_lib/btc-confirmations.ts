// Required confirmation tiers (mission spec):
//   < $50    → 1 confirmation
//   < $500   → 3 confirmations
//   ≥ $500   → 6 confirmations

export const CONFIRMATION_TIERS = [
  { maxUsd: 50, confirmations: 1 },
  { maxUsd: 500, confirmations: 3 },
  { maxUsd: Number.POSITIVE_INFINITY, confirmations: 6 },
] as const;

export function requiredConfirmations(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 6;
  for (const tier of CONFIRMATION_TIERS) {
    if (amountUsd < tier.maxUsd) return tier.confirmations;
  }
  return 6;
}
