import { describe, it, expect } from "vitest";
import { toAtomicAmount } from "../src/services/solana.js";

describe("toAtomicAmount", () => {
  it("converts whole USDC to 6-decimal atomic units", () => {
    expect(toAtomicAmount(1, 6)).toBe(1_000_000n);
    expect(toAtomicAmount(12, 6)).toBe(12_000_000n);
  });

  it("handles fractional amounts without float drift", () => {
    expect(toAtomicAmount(0.1, 6)).toBe(100_000n);
    expect(toAtomicAmount(1.234567, 6)).toBe(1_234_567n);
  });

  it("rejects non-positive amounts", () => {
    expect(() => toAtomicAmount(0, 6)).toThrow();
    expect(() => toAtomicAmount(-1, 6)).toThrow();
  });

  it("rejects amounts that round to zero atomic units", () => {
    expect(() => toAtomicAmount(0.0000001, 6)).toThrow();
  });
});
