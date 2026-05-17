// Minimal PostgREST helper for serverless handlers.
//
// We deliberately avoid the @supabase/supabase-js dependency so this lane
// stays additive (no impact on packages/api). Service-role key never leaves
// server-side env; merchants.xpub is a public-ish identifier but xpub rows
// still go through the service role to bypass RLS on row insertion.

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export function supabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_SERVICE_ROLE_KEY.length > 0;
}

function authHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export interface PostgrestError {
  status: number;
  message: string;
}

export async function insertRow<T>(
  table: string,
  row: Record<string, unknown>,
): Promise<T | PostgrestError> {
  if (!supabaseConfigured()) {
    return { status: 503, message: 'supabase_unconfigured' };
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { ...authHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { status: res.status, message: text || res.statusText };
  }
  const data = (await res.json()) as T[];
  return data[0] as T;
}

export async function selectFirst<T>(
  table: string,
  where: Record<string, string>,
): Promise<T | null | PostgrestError> {
  if (!supabaseConfigured()) {
    return { status: 503, message: 'supabase_unconfigured' };
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(where)) {
    params.set(k, `eq.${v}`);
  }
  params.set('limit', '1');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?${params.toString()}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { status: res.status, message: text || res.statusText };
  }
  const data = (await res.json()) as T[];
  return data.length > 0 ? (data[0] as T) : null;
}

export function isPostgrestError(value: unknown): value is PostgrestError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PostgrestError).status === 'number' &&
    typeof (value as PostgrestError).message === 'string'
  );
}
