// In-process merchant registry used by the Vercel serverless surface to
// dedup signups by email and rate-limit credential-recovery attempts.
//
// The canonical persistence layer is Postgres (Supabase) — see
// supabase/migrations/20260517000000_zettapay_merchants_email_unique.sql
// which enforces UNIQUE(email) at the database level. This module gives
// the stateless handler a per-warm-container dedup gate so the 409 path
// works even before the Supabase write commits and so the test suite can
// exercise the duplicate flow without a live DB.

const RECOVER_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RECOVER_MAX_PER_WINDOW = 3;

export interface MerchantRecord {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

const byEmail = new Map<string, MerchantRecord>();
const recoverAttempts = new Map<string, number[]>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findMerchantByEmail(email: string): MerchantRecord | null {
  const key = normalizeEmail(email);
  return byEmail.get(key) ?? null;
}

export function rememberMerchant(record: MerchantRecord): MerchantRecord {
  const key = normalizeEmail(record.email);
  const existing = byEmail.get(key);
  if (existing) return existing;
  const stored: MerchantRecord = { ...record, email: key };
  byEmail.set(key, stored);
  return stored;
}

export interface RecoverThrottleResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function recordRecoverAttempt(email: string, now: number = Date.now()): RecoverThrottleResult {
  const key = normalizeEmail(email);
  const cutoff = now - RECOVER_WINDOW_MS;
  const history = (recoverAttempts.get(key) ?? []).filter((ts) => ts > cutoff);
  if (history.length >= RECOVER_MAX_PER_WINDOW) {
    const oldest = history[0] ?? now;
    const retryMs = Math.max(0, RECOVER_WINDOW_MS - (now - oldest));
    recoverAttempts.set(key, history);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(retryMs / 1000),
    };
  }
  history.push(now);
  recoverAttempts.set(key, history);
  return {
    allowed: true,
    remaining: RECOVER_MAX_PER_WINDOW - history.length,
    retryAfterSeconds: 0,
  };
}

// Test-only: clear all in-process state. Not exported in production paths.
export function __resetMerchantStoreForTests(): void {
  byEmail.clear();
  recoverAttempts.clear();
}
