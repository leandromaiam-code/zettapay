import { describe, it, expect } from "vitest";
import { BRIDGE_FEE_BPS, computeBridgeFee } from "../src/bridge/fee.js";

describe("computeBridgeFee", () => {
  it("defaults to 0.30% (30 bps) — premissa VI.20", () => {
    expect(BRIDGE_FEE_BPS).toBe(30);
    const fee = computeBridgeFee(100);
    expect(fee.feeBps).toBe(30);
    expect(fee.amountUsdc).toBe(100);
    expect(fee.feeUsdc).toBe(0.3);
    expect(fee.netUsdc).toBe(99.7);
  });

  it("reconciles exactly: amount = fee + net", () => {
    for (const amount of [1, 12.34, 999.999999, 1234.5678]) {
      const fee = computeBridgeFee(amount);
      const recombined = Math.round((fee.feeUsdc + fee.netUsdc) * 1_000_000);
      expect(recombined).toBe(Math.round(fee.amountUsdc * 1_000_000));
    }
  });

  it("rounds up on fractional cents to favor the protocol", () => {
    const fee = computeBridgeFee(0.000001, 30);
    expect(fee.feeUsdc).toBe(0.000001);
    expect(fee.netUsdc).toBe(0);
  });

  it("rejects bad inputs", () => {
    expect(() => computeBridgeFee(0)).toThrow();
    expect(() => computeBridgeFee(-1)).toThrow();
    expect(() => computeBridgeFee(10, -1)).toThrow();
    expect(() => computeBridgeFee(10, 10_001)).toThrow();
  });
});
