import { createHash, createHmac, randomBytes } from 'node:crypto';
import { base58Encode } from './base58.js';

const HTTPS_RE = /^https:\/\//i;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const MERCHANT_REF_RE = /^[a-zA-Z0-9_-]{3,64}$/;

export function normalizeMerchantId(raw: unknown): string | null {
  let value: unknown = raw;
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^@/, '');
  if (!MERCHANT_REF_RE.test(trimmed)) return null;
  return trimmed;
}

export function deterministicWallet(merchantId: string): string {
  return base58Encode(createHash('sha256').update(`zettapay:merchant:wallet:${merchantId}`).digest());
}

export function deterministicApiKey(merchantId: string): string {
  const seed = process.env.ZETTAPAY_DASHBOARD_SECRET || 'zettapay-dashboard-dev-secret';
  return 'zp_live_' + createHmac('sha256', seed).update(`apiKey:${merchantId}`).digest('hex').slice(0, 32);
}

export function deterministicSecretKey(merchantId: string): string {
  const seed = process.env.ZETTAPAY_DASHBOARD_SECRET || 'zettapay-dashboard-dev-secret';
  return 'sk_live_' + createHmac('sha256', seed).update(`secretKey:${merchantId}`).digest('hex').slice(0, 48);
}

export function maskKey(key: string): string {
  if (key.length <= 8) return key.replace(/./g, '•');
  return key.slice(0, 8) + '•'.repeat(Math.max(8, key.length - 12)) + key.slice(-4);
}

export function freshApiKey(): string {
  return 'zp_live_' + randomBytes(16).toString('hex');
}

export function freshSecretKey(): string {
  return 'sk_live_' + randomBytes(24).toString('hex');
}

export function validateWebhookUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: 'webhookUrl must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 2048) return { ok: false, message: 'webhookUrl must be ≤2048 chars' };
  if (!HTTPS_RE.test(trimmed)) return { ok: false, message: 'webhookUrl must be an https:// URL' };
  return { ok: true, value: trimmed };
}

export function validateAllowedOrigins(raw: unknown): { ok: true; value: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'allowedOrigins must be an array of strings' };
  if (raw.length > 16) return { ok: false, message: 'allowedOrigins must be ≤16 entries' };
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, message: 'allowedOrigins entries must be strings' };
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (!ORIGIN_RE.test(trimmed)) {
      return { ok: false, message: `invalid origin: ${trimmed}` };
    }
    out.push(trimmed.toLowerCase());
  }
  return { ok: true, value: Array.from(new Set(out)) };
}

export function isValidWallet(raw: unknown): raw is string {
  return typeof raw === 'string' && SOLANA_ADDRESS_RE.test(raw);
}

export function originFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const hostStr = Array.isArray(host) ? host[0] : host;
  return hostStr ? `${proto}://${hostStr}` : 'https://zettapay.io';
}

export function hostFromRequest(req: { headers: Record<string, string | string[] | undefined> }): string {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const hostStr = Array.isArray(host) ? host[0] : host;
  return hostStr ?? 'zettapay.io';
}
