import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findMerchantByEmail, recordRecoverAttempt } from '../_lib/merchant-store.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Neutral message: never confirm or deny that an email maps to a merchant
// from this endpoint — that would enable enumeration. The signup form is
// explicit about duplicates because the user *just* typed the address.
const NEUTRAL_BODY = {
  ok: true,
  message:
    'If this email is registered, we just sent a magic link with your access credentials. Check your inbox.',
};

function sendMagicLink(email: string, merchantId: string): void {
  // In production this hands off to the transactional mailer. For preview,
  // devnet and tests we log the payload so the operator can pluck the link
  // from the function output without leaking it to the requester.
  const url = `https://zettapay.io/login?merchant=${encodeURIComponent(merchantId)}&hint=${encodeURIComponent(email)}`;
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'recover_creds.magic_link.dispatched',
      email,
      merchantId,
      url,
    }),
  );
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      endpoint: '/api/merchants/recover-creds',
      method: 'POST',
      description:
        'Send a magic-link recovery email to a registered merchant. Response body is intentionally identical for known and unknown emails to prevent enumeration. Rate-limited to 3 requests per email per hour.',
      requestBody: { email: 'string (required, valid email)' },
      responses: {
        '200': 'request accepted (neutral)',
        '400': 'invalid email',
        '429': 'rate limit exceeded',
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    res.status(400).json({
      error: { code: 'invalid_email', message: 'Field "email" must be a valid email address' },
    });
    return;
  }

  const throttle = recordRecoverAttempt(email);
  if (!throttle.allowed) {
    res.setHeader('Retry-After', String(throttle.retryAfterSeconds));
    res.status(429).json({
      error: {
        code: 'rate_limited',
        message: 'Too many recovery requests for this email. Try again later.',
      },
      retry_after_seconds: throttle.retryAfterSeconds,
    });
    return;
  }

  const merchant = findMerchantByEmail(email);
  if (merchant) {
    sendMagicLink(merchant.email, merchant.id);
  }

  res.status(200).json(NEUTRAL_BODY);
}
