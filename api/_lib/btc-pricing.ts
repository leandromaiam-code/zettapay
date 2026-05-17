// USD → BTC spot conversion. Hits mempool.space's public price endpoint;
// falls back to coingecko if the primary fails. Both are free and don't
// require API keys (mission constraint).
//
// Caches the last-known price in-process for `TTL_MS` to amortize cold-start
// fetches across concurrent invoice creations.

const TTL_MS = 30_000;
const TIMEOUT_MS = 4_000;

let cached: { usd: number; at: number } | null = null;

interface MempoolPriceResponse {
  USD?: number;
  time?: number;
}

interface CoingeckoPriceResponse {
  bitcoin?: { usd?: number };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMempool(): Promise<number | null> {
  try {
    const res = await fetchWithTimeout('https://mempool.space/api/v1/prices', TIMEOUT_MS);
    if (!res.ok) return null;
    const json = (await res.json()) as MempoolPriceResponse;
    const usd = typeof json.USD === 'number' ? json.USD : null;
    return usd && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

async function fetchCoingecko(): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as CoingeckoPriceResponse;
    const usd = json.bitcoin?.usd;
    return typeof usd === 'number' && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

/**
 * Spot USD price of 1 BTC. Returns the cached value when fresh and falls
 * through to a network fetch (mempool first, coingecko second) otherwise. If
 * both fail and no cache exists, returns a hard-coded conservative fallback
 * so invoice creation doesn't 500 on a transient network blip — the listener
 * recomputes the real native amount when it sees the actual TX value.
 */
export async function getBtcUsdSpot(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) {
    return cached.usd;
  }
  const fromMempool = await fetchMempool();
  if (fromMempool) {
    cached = { usd: fromMempool, at: now };
    return fromMempool;
  }
  const fromCoingecko = await fetchCoingecko();
  if (fromCoingecko) {
    cached = { usd: fromCoingecko, at: now };
    return fromCoingecko;
  }
  if (cached) return cached.usd;
  // Last-resort fallback. Conservative high estimate so the invoice amount
  // requested is never WAY too low — the listener pins to real on-chain value.
  return 100_000;
}

/** Convert a USD amount to BTC, rounded to 8 decimal places (satoshi). */
export async function usdToBtc(amountUsd: number): Promise<string> {
  const spot = await getBtcUsdSpot();
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error('btc-pricing: spot price unavailable');
  }
  return (amountUsd / spot).toFixed(8);
}
