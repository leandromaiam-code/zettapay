/**
 * ZettaPay protocol fee for cross-chain USDC bridge intents.
 * 0.30% = 30 basis points — matches the headline ZettaPay rate
 * (premissa VI.20). Captured at intent creation so historical
 * rows remain auditable even if the rate changes later.
 */
export const BRIDGE_FEE_BPS = 30;

export interface BridgeFeeBreakdown {
  amountUsdc: number;
  feeBps: number;
  feeUsdc: number;
  netUsdc: number;
}

const USDC_DECIMALS = 6;

/**
 * Compute fee + net amount for a bridged USDC intent. Mirrors the
 * Coinflow fee math: round-up on the fee atomic, net = amount - fee
 * so the arithmetic always reconciles exactly at 6-decimal precision.
 */
export function computeBridgeFee(
  amountUsdc: number,
  feeBps: number = BRIDGE_FEE_BPS,
): BridgeFeeBreakdown {
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
