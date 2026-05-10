import type { PaymentIntent } from './types.js';

export const DEFAULT_API_BASE = 'https://api.zettapay.io';
export const DEFAULT_CHECKOUT_BASE = 'https://pay.zettapay.io';

const POLL_INTERVAL_MS = 2_500;
// Bounded so an abandoned modal doesn't keep firing GETs forever (5 min).
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export class ApiError extends Error {
  override readonly name = 'ZettaPayApiError';
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function normalizeIntent(json: unknown): PaymentIntent {
  const root = json as { payment?: Record<string, unknown> } & Record<string, unknown>;
  const p = (root.payment ?? root) as Record<string, unknown>;
  if (typeof p.id !== 'string') {
    throw new ApiError('invalid_response', 'Payment intent response missing id');
  }
  return {
    id: p.id,
    merchantId: String(p.merchantId ?? ''),
    amount: Number(p.amount ?? p.amountUsdc ?? 0),
    currency: String(p.currency ?? 'USDC'),
    status: (p.status as string) ?? 'pending',
    txSignature: (p.txSignature as string | null | undefined) ?? null,
    createdAt: p.createdAt as string | number | undefined,
  };
}

export async function createPaymentIntent(args: {
  apiBase: string;
  merchantId: string;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
}): Promise<PaymentIntent> {
  const url = `${trimBase(args.apiBase)}/pay`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // Idempotency-Key prevents duplicate intents when a flaky network
      // causes the modal to retry on open. Using a per-call random key is
      // the canonical Stripe pattern.
      'idempotency-key': cryptoRandomId(),
      'x-zettapay-widget': globalThis.__ZETTAPAY_WIDGET_VERSION__ ?? 'dev',
    },
    body: JSON.stringify({
      merchantId: args.merchantId,
      amount: args.amount,
      currency: args.currency,
      metadata: { ...(args.metadata ?? {}), source: 'widget' },
    }),
  });

  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `Payment intent creation failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // body wasn't JSON — fall through with the http_* defaults.
    }
    throw new ApiError(code, message, res.status);
  }

  return normalizeIntent(await res.json());
}

export interface PollResult {
  status: 'completed' | 'failed' | 'expired' | 'timeout';
  intent: PaymentIntent;
}

/**
 * Polls a payment intent until it is no longer `pending`. Resolves with the
 * terminal status; rejects only on network/transport failure. Caller controls
 * cancellation via `signal` (e.g. modal close) so we don't leak intervals.
 */
export async function pollPaymentStatus(args: {
  apiBase: string;
  paymentId: string;
  signal?: AbortSignal;
}): Promise<PollResult> {
  const url = `${trimBase(args.apiBase)}/payments/${encodeURIComponent(args.paymentId)}`;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (args.signal?.aborted) {
      throw new ApiError('aborted', 'Polling aborted');
    }
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: args.signal,
      });
      if (res.ok) {
        const intent = normalizeIntent(await res.json());
        if (intent.status !== 'pending') {
          return { status: intent.status as PollResult['status'], intent };
        }
      } else if (res.status === 404) {
        // Intent not yet visible to read replicas — retry instead of failing.
      } else {
        throw new ApiError(`http_${res.status}`, `Status check failed (${res.status})`, res.status);
      }
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new ApiError('aborted', 'Polling aborted');
      }
      // Transient fetch failure (offline, DNS): swallow and retry.
    }
    await sleep(POLL_INTERVAL_MS, args.signal);
  }

  return {
    status: 'timeout',
    intent: {
      id: args.paymentId,
      merchantId: '',
      amount: 0,
      currency: 'USDC',
      status: 'pending',
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('aborted', 'Sleep aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ApiError('aborted', 'Sleep aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cryptoRandomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for very old environments — collision risk is acceptable for
  // an idempotency key scoped to a single browser session.
  return `wgt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
