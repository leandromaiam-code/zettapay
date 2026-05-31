// USDC pricing helpers for the Base chain. USDC on Base has 6 decimals and is
// treated 1:1 with USD by ZettaPay (it is a USD stablecoin). The watcher and
// invoice-core compare on-chain `balanceOf` results — which are integer base
// units — against the amount stored on the invoice, so amounts cross the
// storage boundary as integer base-unit strings, never floats.

export const USDC_DECIMALS = 6;
const USDC_UNITS_PER_USDC = 10 ** USDC_DECIMALS;

/**
 * Convert a USD amount to integer USDC base units (1 USDC = 1e6 units).
 * Rounds to the nearest base unit so floating-point dust (e.g. 19.99 * 1e6)
 * never leaks a fractional unit into storage.
 */
export function usdToUsdc(usd: number): number {
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
    throw new Error('usdToUsdc: usd must be a positive finite number');
  }
  return Math.round(usd * USDC_UNITS_PER_USDC);
}

/**
 * Render integer USDC base units as a decimal USDC string with trailing zeros
 * stripped ("29000000" → "29", "1500000" → "1.5"). Inverse of usdToUsdc for
 * display only — comparisons always happen in integer base units.
 */
export function formatUsdc(units: number): string {
  if (!Number.isInteger(units) || units < 0) {
    throw new Error('formatUsdc: units must be a non-negative integer');
  }
  const whole = Math.floor(units / USDC_UNITS_PER_USDC);
  const frac = units % USDC_UNITS_PER_USDC;
  if (frac === 0) return `${whole}`;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
