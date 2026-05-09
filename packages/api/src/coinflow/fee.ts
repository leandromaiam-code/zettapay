/**
 * ZettaPay protocol fee for Coinflow auto-settlement (USDC → USD bank account).
 * 1.5% = 150 basis points. Captured at settlement time so historical rows
 * remain auditable even if pricing later changes.
 */
export const COINFLOW_FEE_BPS = 150;

export interface FeeBreakdown {
  amountUsdc: number;
  feeBps: number;
  feeUsdc: number;
  netUsdc: number;
}

const USDC_DECIMALS = 6;

/**
 * Compute fee + net amount for a USDC settlement, rounded to USDC atomic
 * precision (6 decimals). The fee rounds up to favor the protocol on
 * fractional cents; the net is then computed as `amount − fee` so the
 * arithmetic always reconciles exactly.
 */
export function computeSettlementFee(
  amountUsdc: number,
  feeBps: number = COINFLOW_FEE_BPS,
): FeeBreakdown {
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error("amountUsdc must be a positive finite number");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("feeBps must be an integer in [0, 10000]");
  }
  const scale = 10 ** USDC_DECIMALS;
  const amountAtomic = Math.round(amountUsdc * scale);
  const feeAtomic = Math.ceil((amountAtomic * feeBps) / 10_000);
  const netAtomic = amountAtomic - feeAtomic;
  return {
    amountUsdc: amountAtomic / scale,
    feeBps,
    feeUsdc: feeAtomic / scale,
    netUsdc: netAtomic / scale,
  };
}
