// WebhookDispatcher — pulls due events from StorageAdapter, POSTs them to the
// merchant's webhook URL with an HMAC-SHA256 signature over the raw body, and
// schedules retries against a Stripe-grade curve. Records every attempt back
// through StorageAdapter (HR-STORAGE-ADAPTER).
//
// Outbound traffic is bound to MERCHANT_WEBHOOK_URL (HR-PHONE-HOME).

import { createHmac } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { WebhookEvent } from './types.js';
import type { Logger } from './listener.js';
import { classifyWebhookUrl } from './cli/util.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Retry curve from mission spec: 1s, 5s, 30s, 2m, 10m, 30m, 1h, 3h, 12h, 24h.
 * Index i is the delay between attempt i and attempt i+1; 10 entries cap the
 * total attempt count at 10. After the last entry the event stays "dead" — no
 * future poll will pick it up because next_retry_at is pushed to 24h forever.
 */
export const RETRY_CURVE_MS: readonly number[] = [
  1 * SECOND,
  5 * SECOND,
  30 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  30 * MINUTE,
  1 * HOUR,
  3 * HOUR,
  12 * HOUR,
  24 * HOUR,
];

export const MAX_ATTEMPTS = RETRY_CURVE_MS.length;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_BATCH = 25;
const SIGNATURE_HEADER = 'X-ZettaPay-Signature';
const TIMESTAMP_HEADER = 'X-ZettaPay-Timestamp';
const EVENT_ID_HEADER = 'X-ZettaPay-Event-Id';
const ATTEMPT_HEADER = 'X-ZettaPay-Attempt';

export interface WebhookDispatcherOptions {
  storage: StorageAdapter;
  webhookUrl: string;
  webhookSecret: string;
  pollIntervalMs?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class WebhookDispatcher {
  private readonly storage: StorageAdapter;
  private readonly url: string;
  private readonly secret: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;

  constructor(opts: WebhookDispatcherOptions) {
    this.storage = opts.storage;
    this.url = opts.webhookUrl;
    this.secret = opts.webhookSecret;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? noopLogger;
    const policy = classifyWebhookUrl(this.url);
    if (!policy.ok) {
      throw new Error(
        '@zettapay/listener: MERCHANT_WEBHOOK_URL must use https:// (TLS required, HR rule). ' +
          'The only exception is http://localhost / 127.0.0.1 / ::1 for dev/test against @zettapay/receiver.',
      );
    }
    if (policy.mode === 'localhost-http') {
      // Single warning at boot; do not re-emit per delivery.
      this.log.warn('webhook_dispatcher.dev_mode_http', { url: this.url, message: policy.warning });
    }
  }

  start(): void {
    this.stopped = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => this.log.error('webhook_dispatcher.tick_failed', err))
        .finally(() => this.scheduleNext());
    }, this.pollIntervalMs);
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const due = await this.storage.getWebhookEventsDue(new Date(), this.batchSize);
      for (const evt of due) {
        if (this.stopped) break;
        await this.deliverOne(evt);
      }
    } finally {
      this.running = false;
    }
  }

  private async deliverOne(evt: WebhookEvent): Promise<void> {
    if (evt.attempts >= MAX_ATTEMPTS) {
      // Retry budget exhausted. Storage already parks next_retry_at at the
      // 24h tail; we skip the HTTP attempt so a dead event cannot loop.
      this.log.warn('webhook_dispatcher.dead', { id: evt.id, attempts: evt.attempts });
      return;
    }
    const attemptNumber = evt.attempts + 1;
    const body = evt.payload_json;
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', this.secret).update(body).digest('hex');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: timestamp,
      [EVENT_ID_HEADER]: evt.id,
      [ATTEMPT_HEADER]: String(attemptNumber),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let statusCode: number | undefined;
    let error: string | undefined;
    let ok = false;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      statusCode = res.status;
      ok = res.ok;
      if (!ok) error = `http_${statusCode}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    const nextRetryAt = ok ? null : nextRetryDate(attemptNumber);
    await this.storage.markWebhookDelivered(evt.id, {
      ok,
      statusCode,
      error,
      nextRetryAt,
    });

    if (ok) {
      this.log.info('webhook_dispatcher.delivered', {
        id: evt.id,
        attempt: attemptNumber,
        status: statusCode,
      });
    } else {
      this.log.warn('webhook_dispatcher.failed', {
        id: evt.id,
        attempt: attemptNumber,
        status: statusCode,
        error,
      });
    }
  }
}

/**
 * Returns the next-retry timestamp for a given attempt number (1-indexed).
 * After MAX_ATTEMPTS, the event is parked 24h into the future so it stops
 * showing up in `getWebhookEventsDue` polls (effective dead-letter).
 */
export function nextRetryDate(attemptNumber: number): Date {
  const idx = Math.min(attemptNumber, RETRY_CURVE_MS.length) - 1;
  const delay = RETRY_CURVE_MS[Math.max(0, idx)] ?? 24 * HOUR;
  return new Date(Date.now() + delay);
}
