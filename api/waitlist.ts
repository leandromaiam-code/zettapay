// Cloud early-access waitlist. Stores the email the visitor typed on /app so it
// can actually be contacted when Cloud opens. Email only — no other personal
// data is collected (HR-PII-MINIMAL).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadSupabaseConfig, supabase, SupabaseError } from './_lib/supabase.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: { code: 'method_not_allowed' } });
    return;
  }

  const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: { code: 'invalid_email', message: 'a valid email is required' } });
    return;
  }

  const cfg = loadSupabaseConfig();
  if (!cfg) {
    res.status(503).json({ error: { code: 'waitlist_unavailable' } });
    return;
  }

  try {
    await supabase.insertReturning(cfg, 'zettapay_waitlist', { email, source: 'app' });
    res.status(201).json({ ok: true });
  } catch (err) {
    // 409 = this email is already on the list. Same answer for the visitor, and
    // it avoids confirming to a stranger whether an address is registered.
    if (err instanceof SupabaseError && err.status === 409) {
      res.status(201).json({ ok: true });
      return;
    }
    res.status(502).json({ error: { code: 'waitlist_unavailable' } });
  }
}
