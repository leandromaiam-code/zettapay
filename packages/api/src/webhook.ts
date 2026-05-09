import { createHmac, randomUUID } from 'node:crypto';

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];
const DEFAULT_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER = 'X-ZettaPay-Signature';
const TIMESTAMP_HEADER = 'X-ZettaPay-Timestamp';
const EVENT_ID_HEADER = 'X-ZettaPay-Event-Id';

export interface DispatchWebhookOptions {
  url: string;
  payload: unknown;
  secret?: string;
  eventId?: string;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const body = JSON.stringify(payload);
  const totalAttempts = retryDelaysMs.length + 1;
  const attempts: WebhookAttempt[] = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const timestamp = String(now());
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      [EVENT_ID_HEADER]: eventId,
      [TIMESTAMP_HEADER]: timestamp,
    };
    if (secret) {
      headers[SIGNATURE_HEADER] = `sha256=${signPayload(secret, timestamp, body)}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();
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

    attempts.push({ attempt, status, ok, error, durationMs: now() - startedAt });

    if (ok) {
      return { delivered: true, eventId, attempts };
    }

    const isLastAttempt = attempt === totalAttempts;
    const transportFailure = status === null;
    if (!transportFailure && status !== null && !isRetryable(status)) {
      return { delivered: false, eventId, attempts };
    }

    if (isLastAttempt) break;

    const delay = retryDelaysMs[attempt - 1] ?? 0;
    await sleep(delay);
  }

  return { delivered: false, eventId, attempts };
}
