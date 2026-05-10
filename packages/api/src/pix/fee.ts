/**
 * ZettaPay protocol fee for Pix auto-settlement (USDC → BRL Pix payout to MEI).
 * 1.5% = 150 basis points, captured at settlement time so historical rows
 * remain auditable even if pricing later changes.
 */
export const PIX_FEE_BPS = 150;

export {
  computeSettlementFee as computePixSettlementFee,
  type FeeBreakdown,
} from "../coinflow/fee.js";
