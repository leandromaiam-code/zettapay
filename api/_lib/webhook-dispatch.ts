// HMAC-signed merchant webhook dispatch.
//
// HR-SECRETS-IN-GIT: the merchant's webhook_secret is generated server-side
// and stored hashed/encrypted in Supabase Vault — this module only handles
// the in-memory secret loaded for a single dispatch, never logging it.

import { createHmac } from 'node:crypto';

/** Retry schedule per the Z53 spec: 1m, 5m, 30m, 2h, 12h (max 5 attempts).
 * Index 0 is the delay before attempt 1 (so attempt 1 fires after 60s).
 * After all 5 attempts fail, the webhook is marked `webhook_failed`. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length;

export interface PaidWebhookPayload {
  invoice_id: string;
  status: 'paid';
  txid: string;
  address: string;
  amount_sats: number;
  confirmations: number;
  chain: 'bitcoin';
}

/** Returns the lowercase hex of HMAC-SHA256(secret, body). The wire format
 * for the `X-ZettaPay-Signature` header is `sha256=<hex>`. */
export function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function signatureHeader(secret: string, body: string): string {
  return `sha256=${signBody(secret, body)}`;
}

/** Constant-time signature verification mirror — used by the acceptance test
 * to prove the HMAC round-trips correctly. Returns true on match. */
export function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = signatureHeader(secret, body);
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  }
  return diff === 0;
}

export interface DispatchOptions {
  url: string;
  secret: string;
  payload: PaidWebhookPayload;
  /** Optional injection point for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** AbortSignal so the caller can bound wall-clock when running in a
   * serverless handler. */
  signal?: AbortSignal;
}

export interface DispatchResult {
  ok: boolean;
  status: number | null;
  bodySignature: string;
  bodyBytes: number;
  /** Populated only on transport failure (network, abort, DNS). */
  error?: string;
}

/** Single-attempt webhook POST. Retry scheduling is the caller's job — this
 * function just performs one HTTP attempt and reports the outcome. */
export async function dispatchOnce(opts: DispatchOptions): Promise<DispatchResult> {
  const body = JSON.stringify(opts.payload);
  const sig = signatureHeader(opts.secret, body);
  const fetcher = opts.fetchImpl ?? fetch;
  try {
    const res = await fetcher(opts.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZettaPay-Signature': sig,
        'User-Agent': 'zettapay-webhook/1',
      },
      body,
      signal: opts.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      bodySignature: sig,
      bodyBytes: body.length,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      bodySignature: sig,
      bodyBytes: body.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
