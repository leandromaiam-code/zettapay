// Service-role Supabase client for the Vercel /api/ lane (Z45).
// Held in module scope so concurrent serverless invocations share a single
// connection pool. Returns null when env vars are missing so callers can
// route to a friendly 503 instead of crashing during boot.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'x-zettapay-runtime': 'vercel-serverless' } },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
