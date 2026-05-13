import { Pool, type PoolConfig } from "pg";

export interface PostgresPoolConfig {
  /** Postgres DSN. Required. Supabase format: `postgres://...pooler.supabase.com:6543/postgres`. */
  connectionString: string;
  /** Force TLS on. Defaults to true for non-loopback hosts; required by Supabase. */
  ssl?: boolean;
  /** Pool size cap. Defaults to 10 — Supabase pooler tier sizing. */
  max?: number;
  /** Min idle clients kept warm. Defaults to 0. */
  min?: number;
  /** Idle client timeout in ms. Defaults to 30s. */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout. Defaults to 10s — fail fast under load. */
  connectionTimeoutMillis?: number;
  /** Statement timeout (ms). Defaults to 30s — kills runaway queries. */
  statementTimeoutMillis?: number;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** True for Supabase pooler / managed Postgres / anything not on the loopback. */
export function shouldUseSslForHost(host: string): boolean {
  if (!host) return true;
  return !LOOPBACK.has(host.toLowerCase());
}

function hostFromConnectionString(dsn: string): string {
  try {
    return new URL(dsn).hostname;
  } catch {
    return "";
  }
}

export function buildPoolConfig(input: PostgresPoolConfig): PoolConfig {
  const host = hostFromConnectionString(input.connectionString);
  const useSsl = input.ssl ?? shouldUseSslForHost(host);
  const statementTimeout = input.statementTimeoutMillis ?? 30_000;

  return {
    connectionString: input.connectionString,
    max: input.max ?? 10,
    min: input.min ?? 0,
    idleTimeoutMillis: input.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: input.connectionTimeoutMillis ?? 10_000,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    application_name: "zettapay-api",
    statement_timeout: statementTimeout,
  } satisfies PoolConfig;
}

let pool: Pool | null = null;

/** Lazy singleton. Premise 13: prod path; SQLite remains the dev default. */
export function getPostgresPool(input?: PostgresPoolConfig): Pool {
  if (pool) return pool;
  const connectionString =
    input?.connectionString ?? readPostgresConnectionString();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — set DATABASE_URL or SUPABASE_DB_URL to enable Postgres",
    );
  }
  pool = new Pool(buildPoolConfig({ ...input, connectionString }));
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (!pool) return;
  const handle = pool;
  pool = null;
  await handle.end();
}

/** Reset the singleton so tests can swap pools — never call from app code. */
export function resetPostgresPoolForTests(): void {
  pool = null;
}

/** Returns the first non-empty Postgres DSN env var. Supabase first, then DATABASE_URL. */
export function readPostgresConnectionString(): string | null {
  const candidates = [
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL,
    process.env.DATABASE_URL,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** "postgres" → use Postgres, anything else → SQLite (the dev default). */
export function shouldUsePostgres(): boolean {
  return (process.env.DATABASE_DRIVER ?? "sqlite").toLowerCase() === "postgres";
}
