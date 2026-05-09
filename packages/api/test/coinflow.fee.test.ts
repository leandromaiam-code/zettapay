import { describe, it, expect } from "vitest";
import { COINFLOW_FEE_BPS, computeSettlementFee } from "../src/coinflow/fee.js";

describe("computeSettlementFee", () => {
  it("defaults to 1.5% fee (150 bps)", () => {
    expect(COINFLOW_FEE_BPS).toBe(150);
    const fee = computeSettlementFee(100);
    expect(fee.feeBps).toBe(150);
    expect(fee.amountUsdc).toBe(100);
    expect(fee.feeUsdc).toBe(1.5);
    expect(fee.netUsdc).toBe(98.5);
  });

  it("rounds the fee up at USDC atomic precision (6 decimals)", () => {
    const fee = computeSettlementFee(0.000001, 150);
    // 0.000001 * 150 / 10000 = 0.000000015 → ceil to 1 atomic unit
    expect(fee.feeUsdc).toBe(0.000001);
    expect(fee.netUsdc).toBe(0);
  });

  it("reconciles exactly: amount = fee + net", () => {
    for (const amount of [1, 12.34, 999.999999, 1234.5678]) {
      const fee = computeSettlementFee(amount);
      const recombined = Math.round((fee.feeUsdc + fee.netUsdc) * 1_000_000);
      expect(recombined).toBe(Math.round(fee.amountUsdc * 1_000_000));
    }
  });

  it("rejects non-positive amounts", () => {
    expect(() => computeSettlementFee(0)).toThrow();
    expect(() => computeSettlementFee(-5)).toThrow();
    expect(() => computeSettlementFee(Number.NaN)).toThrow();
  });

  it("rejects out-of-range fee bps", () => {
    expect(() => computeSettlementFee(10, -1)).toThrow();
    expect(() => computeSettlementFee(10, 10_001)).toThrow();
    expect(() => computeSettlementFee(10, 1.5)).toThrow();
  });
});
