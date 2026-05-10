import { createHmac, randomUUID } from 'node:crypto';
import { context, propagation } from '@opentelemetry/api';
import { withSpan } from './lib/tracer.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Sophisticated exponential backoff schedule for merchant webhook delivery.
 *
 * 1s → 5s → 25s → 2min → 10min → 1h → 6h → 24h
 *
 * Combined with `DEFAULT_MAX_ATTEMPTS = 10`, the dispatcher attempts the
 * initial POST plus up to 8 retries (9 attempts) before parking the event in
 * the dead-letter queue. The schedule mirrors Stripe-grade reliability: short
 * spacing absorbs transient blips, day-long tails ride out merchant outages.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  1 * SECOND,
  5 * SECOND,
  25 * SECOND,
  2 * MINUTE,
  10 * MINUTE,
  1 * HOUR,
  6 * HOUR,
  24 * HOUR,
];

export const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER = 'X-ZettaPay-Signature';
const TIMESTAMP_HEADER = 'X-ZettaPay-Timestamp';
const EVENT_ID_HEADER = 'X-ZettaPay-Event-Id';
const ATTEMPT_HEADER = 'X-ZettaPay-Attempt';

export type DeadLetterReason = 'retries_exhausted' | 'non_retryable_status';

export interface DeadLetterEvent {
  url: string;
  eventId: string;
  payload: unknown;
  attempts: WebhookAttempt[];
  reason: DeadLetterReason;
}

export interface DispatchWebhookOptions {
  url: string;
  payload: unknown;
  secret?: string;
  eventId?: string;
  retryDelaysMs?: readonly number[];
  /**
   * Hard cap on total attempts (initial + retries). Defaults to 10.
   * Combined with `retryDelaysMs`, the effective number of attempts is
   * `min(retryDelaysMs.length + 1, maxAttempts)`.
   */
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onDeadLetter?: (event: DeadLetterEvent) => void | Promise<void>;
  /**
   * Called once per HTTP attempt (after the response or transport error). Runs
   * sequentially with the dispatch loop so observers (persistence, metrics)
   * see each attempt in order. Errors thrown here are swallowed — observability
   * must not mask the real delivery outcome.
   */
  onAttempt?: (event: WebhookAttemptEvent) => void | Promise<void>;
  /**
   * Called once before the first attempt with the resolved eventId and the
   * effective total attempt budget. Useful for upserting a `pending` row in
   * persistence layers before any HTTP traffic happens.
   */
  onStart?: (event: WebhookStartEvent) => void | Promise<void>;
}

export interface WebhookStartEvent {
  url: string;
  eventId: string;
  payload: unknown;
  maxAttempts: number;
}

export interface WebhookAttemptEvent {
  url: string;
  eventId: string;
  payload: unknown;
  attempt: WebhookAttempt;
  /** ISO-8601 timestamp captured at attempt start. */
  attemptedAt: string;
}

export interface WebhookAttempt {
  attempt: number;
  status: number | null;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface WebhookDispatchResult {
  delivered: boolean;
  deadLettered: boolean;
  deadLetterReason?: DeadLetterReason;
  eventId: string;
  attempts: WebhookAttempt[];
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isRetryable(status: number): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return false;
}

function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function dispatchWebhook(options: DispatchWebhookOptions): Promise<WebhookDispatchResult> {
  const {
    url,
    payload,
    secret,
    eventId = randomUUID(),
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
    onDeadLetter,
    onAttempt,
    onStart,
  } = options;

  const body = JSON.stringify(payload);
  const totalAttempts = Math.max(1, Math.min(retryDelaysMs.length + 1, maxAttempts));

  return withSpan(
    'zettapay.webhook.dispatch',
    {
      'zettapay.webhook.event_id': eventId,
      'zettapay.webhook.url': url,
      'zettapay.webhook.max_attempts': totalAttempts,
    },
    async (dispatchSpan) => {
      const attempts: WebhookAttempt[] = [];

      await emitObserver(onStart, { url, eventId, payload, maxAttempts: totalAttempts });

      for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        const timestamp = String(now());
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
          [EVENT_ID_HEADER]: eventId,
          [TIMESTAMP_HEADER]: timestamp,
          [ATTEMPT_HEADER]: String(attempt),
        };
        if (secret) {
          headers[SIGNATURE_HEADER] = `sha256=${signPayload(secret, timestamp, body)}`;
        }

        // Inject W3C traceparent / tracestate so a merchant who speaks
        // OpenTelemetry can join the same trace as the originating request.
        propagation.inject(context.active(), headers);

        const startedAt = now();
        const attemptRecord = await withSpan(
          'zettapay.webhook.attempt',
          {
            'zettapay.webhook.event_id': eventId,
            'zettapay.webhook.url': url,
            'zettapay.webhook.attempt': attempt,
          },
          async (attemptSpan): Promise<WebhookAttempt> => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            let status: number | null = null;
            let ok = false;
            let error: string | undefined;

            try {
              const response = await fetchImpl(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
              });
              status = response.status;
              ok = response.ok;
            } catch (err) {
              error = err instanceof Error ? err.message : String(err);
            } finally {
              clearTimeout(timeoutId);
            }

            attemptSpan.setAttribute('http.response.status_code', status ?? -1);
            attemptSpan.setAttribute('zettapay.webhook.ok', ok);
            if (error) attemptSpan.setAttribute('zettapay.webhook.error', error);

            return {
              attempt,
              status,
              ok,
              error,
              durationMs: now() - startedAt,
            };
          },
        );
        attempts.push(attemptRecord);
        await emitObserver(onAttempt, {
          url,
          eventId,
          payload,
          attempt: attemptRecord,
          attemptedAt: new Date(startedAt).toISOString(),
        });

        if (attemptRecord.ok) {
          dispatchSpan.setAttribute('zettapay.webhook.outcome', 'delivered');
          dispatchSpan.setAttribute('zettapay.webhook.attempts_used', attempts.length);
          return { delivered: true, deadLettered: false, eventId, attempts };
        }

        const status = attemptRecord.status;
        const transportFailure = status === null;
        if (!transportFailure && status !== null && !isRetryable(status)) {
          const reason: DeadLetterReason = 'non_retryable_status';
          dispatchSpan.setAttribute('zettapay.webhook.outcome', 'dead_lettered');
          dispatchSpan.setAttribute('zettapay.webhook.dead_letter_reason', reason);
          dispatchSpan.setAttribute('zettapay.webhook.attempts_used', attempts.length);
          await emitDeadLetter(onDeadLetter, { url, eventId, payload, attempts, reason });
          return { delivered: false, deadLettered: true, deadLetterReason: reason, eventId, attempts };
        }

        const isLastAttempt = attempt === totalAttempts;
        if (isLastAttempt) break;

        const delay = retryDelaysMs[attempt - 1] ?? 0;
        await sleep(delay);
      }

      const reason: DeadLetterReason = 'retries_exhausted';
      dispatchSpan.setAttribute('zettapay.webhook.outcome', 'dead_lettered');
      dispatchSpan.setAttribute('zettapay.webhook.dead_letter_reason', reason);
      dispatchSpan.setAttribute('zettapay.webhook.attempts_used', attempts.length);
      await emitDeadLetter(onDeadLetter, { url, eventId, payload, attempts, reason });
      return { delivered: false, deadLettered: true, deadLetterReason: reason, eventId, attempts };
    },
  );
}

async function emitDeadLetter(
  handler: ((event: DeadLetterEvent) => void | Promise<void>) | undefined,
  event: DeadLetterEvent,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch {
    // swallow — dead-letter sink failure must not mask the dispatch result.
  }
}

async function emitObserver<T>(
  handler: ((event: T) => void | Promise<void>) | undefined,
  event: T,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch {
    // swallow — observer failure must not mask the dispatch result.
  }
}
