import { describe, it, expect } from "vitest";
import { PIX_FEE_BPS, computePixSettlementFee } from "../src/pix/fee.js";

describe("computePixSettlementFee", () => {
  it("defaults to 1.5% fee (150 bps) — matches Coinflow USDC->USD rate", () => {
    expect(PIX_FEE_BPS).toBe(150);
    const fee = computePixSettlementFee(100);
    expect(fee.feeBps).toBe(150);
    expect(fee.amountUsdc).toBe(100);
    expect(fee.feeUsdc).toBe(1.5);
    expect(fee.netUsdc).toBe(98.5);
  });

  it("reconciles exactly: amount = fee + net", () => {
    for (const amount of [1, 12.34, 999.999999, 1234.5678]) {
      const fee = computePixSettlementFee(amount);
      const recombined = Math.round((fee.feeUsdc + fee.netUsdc) * 1_000_000);
      expect(recombined).toBe(Math.round(fee.amountUsdc * 1_000_000));
    }
  });

  it("rejects non-positive amounts and out-of-range bps", () => {
    expect(() => computePixSettlementFee(0)).toThrow();
    expect(() => computePixSettlementFee(-1)).toThrow();
    expect(() => computePixSettlementFee(10, -1)).toThrow();
    expect(() => computePixSettlementFee(10, 10_001)).toThrow();
  });
});
