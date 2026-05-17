import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedAnon: SupabaseClient | null = null;
let cachedService: SupabaseClient | null = null;

export type SupabaseStatus =
  | { ok: true; client: SupabaseClient }
  | { ok: false; reason: 'missing_url' | 'missing_anon_key' | 'missing_service_role_key' };

export function supabaseUrl(): string | null {
  const url = process.env.SUPABASE_URL?.trim();
  return url && url.length > 0 ? url : null;
}

export function supabaseAnonKey(): string | null {
  const key = process.env.SUPABASE_ANON_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function supabaseServiceRoleKey(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function getSupabaseAnon(): SupabaseStatus {
  const url = supabaseUrl();
  if (!url) return { ok: false, reason: 'missing_url' };
  const key = supabaseAnonKey();
  if (!key) return { ok: false, reason: 'missing_anon_key' };
  if (!cachedAnon) {
    cachedAnon = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }
  return { ok: true, client: cachedAnon };
}

export function getSupabaseService(): SupabaseStatus {
  const url = supabaseUrl();
  if (!url) return { ok: false, reason: 'missing_url' };
  const key = supabaseServiceRoleKey();
  if (!key) return { ok: false, reason: 'missing_service_role_key' };
  if (!cachedService) {
    cachedService = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }
  return { ok: true, client: cachedService };
}

export function isVerificationConfigured(): boolean {
  return supabaseUrl() !== null && supabaseAnonKey() !== null;
}
