export interface RetryOptions {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const TRANSIENT_PATTERNS = [
  "fetch failed",
  "network",
  "timeout",
  "timed out",
  "econn",
  "etimedout",
  "socket hang up",
  "503",
  "502",
  "504",
  "429",
  "rate limit",
  "too many requests",
];

export function isTransientRpcError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const haystack = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((needle) => haystack.includes(needle));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function retryWithBackoff<T>(
  task: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const isRetryable = options.isRetryable ?? isTransientRpcError;
  let attempt = 0;
  let delay = Math.max(1, options.initialBackoffMs);
  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= options.maxRetries || !isRetryable(error)) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * Math.min(delay, 250));
      const wait = Math.min(delay + jitter, options.maxBackoffMs);
      options.onRetry?.(attempt + 1, wait, error);
      await sleep(wait);
      attempt += 1;
      delay = Math.min(delay * 2, options.maxBackoffMs);
    }
  }
}
