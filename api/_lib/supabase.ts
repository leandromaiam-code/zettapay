// Minimal Supabase REST client via fetch — keeps the Vercel /api/ functions
// dependency-free of @supabase/supabase-js (which would add ~150 KB to every
// cold start). All calls go through PostgREST using the service-role JWT;
// caller must scope writes carefully because RLS is open server-side.
//
// Env contract:
//   SUPABASE_URL                  — https://<project>.supabase.co (required)
//   SUPABASE_SERVICE_ROLE_KEY     — sb-svc JWT (required, server-only)
//
// All helpers return parsed JSON or throw a `SupabaseError` with the HTTP
// status + PostgREST body. They never log secrets.

export class SupabaseError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = (env.SUPABASE_URL ?? '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey: key };
}

export function requireSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const cfg = loadSupabaseConfig(env);
  if (!cfg) {
    throw new SupabaseError(
      'supabase_not_configured',
      503,
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing',
    );
  }
  return cfg;
}

interface RestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | undefined>;
  body?: unknown;
  prefer?: string;
  signal?: AbortSignal;
}

async function rest<T>(cfg: SupabaseConfig, path: string, opts: RestOptions = {}): Promise<T> {
  const url = new URL(`${cfg.url}/rest/v1/${path.replace(/^\/+/, '')}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new SupabaseError(
      `supabase ${opts.method ?? 'GET'} ${path} failed: ${res.status}`,
      res.status,
      text,
    );
  }
  if (text.length === 0) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new SupabaseError(
      `supabase response not JSON: ${(err as Error).message}`,
      res.status,
      text,
    );
  }
}

export const supabase = {
  /** Insert a row and return the single inserted row. Throws on conflict. */
  async insertReturning<T>(
    cfg: SupabaseConfig,
    table: string,
    row: Record<string, unknown>,
  ): Promise<T> {
    const rows = await rest<T[]>(cfg, table, {
      method: 'POST',
      body: row,
      prefer: 'return=representation',
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new SupabaseError('supabase insert returned no rows', 500, '');
    }
    return rows[0] as T;
  },

  /** Update rows matching the filter and return them. */
  async updateReturning<T>(
    cfg: SupabaseConfig,
    table: string,
    filter: Record<string, string>,
    patch: Record<string, unknown>,
  ): Promise<T[]> {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(filter)) {
      query[k] = `eq.${v}`;
    }
    return rest<T[]>(cfg, table, {
      method: 'PATCH',
      query,
      body: patch,
      prefer: 'return=representation',
    });
  },

  /** Select rows matching an eq.* filter. */
  async select<T>(
    cfg: SupabaseConfig,
    table: string,
    filter: Record<string, string> = {},
    options: { select?: string; limit?: number; order?: string } = {},
  ): Promise<T[]> {
    const query: Record<string, string> = {};
    if (options.select) query['select'] = options.select;
    if (options.limit !== undefined) query['limit'] = String(options.limit);
    if (options.order) query['order'] = options.order;
    for (const [k, v] of Object.entries(filter)) {
      query[k] = `eq.${v}`;
    }
    return rest<T[]>(cfg, table, { method: 'GET', query });
  },

  /** Invoke a Postgres function (`/rest/v1/rpc/<name>`). */
  async rpc<T>(cfg: SupabaseConfig, fn: string, args: Record<string, unknown>): Promise<T> {
    return rest<T>(cfg, `rpc/${fn}`, { method: 'POST', body: args });
  },
};
