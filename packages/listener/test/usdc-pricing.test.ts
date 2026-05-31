import { describe, expect, it } from 'vitest';
import { formatUsdc, usdToUsdc, USDC_DECIMALS } from '../src/usdc-pricing.js';

describe('usdToUsdc', () => {
  it('USDC has 6 decimals', () => {
    expect(USDC_DECIMALS).toBe(6);
  });

  it('converts whole dollars to integer base units', () => {
    expect(usdToUsdc(29)).toBe(29_000_000);
    expect(usdToUsdc(1)).toBe(1_000_000);
  });

  it('rounds fractional cents to the nearest base unit', () => {
    expect(usdToUsdc(19.99)).toBe(19_990_000);
    expect(usdToUsdc(0.5)).toBe(500_000);
  });

  it('rejects non-positive / non-finite amounts', () => {
    expect(() => usdToUsdc(0)).toThrow();
    expect(() => usdToUsdc(-5)).toThrow();
    expect(() => usdToUsdc(Number.NaN)).toThrow();
    expect(() => usdToUsdc(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('formatUsdc', () => {
  it('renders whole amounts without a decimal point', () => {
    expect(formatUsdc(29_000_000)).toBe('29');
    expect(formatUsdc(0)).toBe('0');
  });

  it('strips trailing zeros on fractional amounts', () => {
    expect(formatUsdc(1_500_000)).toBe('1.5');
    expect(formatUsdc(19_990_000)).toBe('19.99');
    expect(formatUsdc(1)).toBe('0.000001');
  });

  it('round-trips usdToUsdc for representable amounts', () => {
    expect(formatUsdc(usdToUsdc(29))).toBe('29');
    expect(formatUsdc(usdToUsdc(19.99))).toBe('19.99');
  });

  it('rejects negative / non-integer units', () => {
    expect(() => formatUsdc(-1)).toThrow();
    expect(() => formatUsdc(1.5)).toThrow();
  });
});
