import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";

export interface MigrationFile {
  /** Sortable filename, e.g. `20260509000000_init.sql`. */
  name: string;
  /** Absolute path on disk. */
  path: string;
}

export interface MigrationRecord {
  name: string;
  appliedAt: Date;
}

export interface MigrationResult {
  /** Migrations applied in this run (in order). */
  applied: string[];
  /** Migrations skipped because already in `schema_migrations`. */
  skipped: string[];
}

const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/i;

/** Scan a migrations directory and return *.sql files sorted by name. */
export async function discoverMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const sql = entries
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();
  return sql.map((name) => ({ name, path: join(dir, name) }));
}

/** Idempotent: creates `schema_migrations` if missing. */
export async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function listAppliedMigrations(
  client: PoolClient,
): Promise<MigrationRecord[]> {
  const result = await client.query<{ name: string; applied_at: Date }>(
    `SELECT name, applied_at FROM schema_migrations ORDER BY name ASC`,
  );
  return result.rows.map((row) => ({
    name: row.name,
    appliedAt: row.applied_at,
  }));
}

/**
 * Apply every pending migration in `dir` against `pool`. Each file runs in its
 * own transaction so a failure leaves earlier migrations committed and aborts
 * the rest — recoverable by fixing the SQL and re-running.
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
): Promise<MigrationResult> {
  const files = await discoverMigrations(dir);
  if (files.length === 0) return { applied: [], skipped: [] };

  const setupClient = await pool.connect();
  let appliedNames = new Set<string>();
  try {
    await ensureMigrationsTable(setupClient);
    const records = await listAppliedMigrations(setupClient);
    appliedNames = new Set(records.map((r) => r.name));
  } finally {
    setupClient.release();
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (appliedNames.has(file.name)) {
      skipped.push(file.name);
      continue;
    }
    const sql = await readFile(file.path, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (name) VALUES ($1)
           ON CONFLICT (name) DO NOTHING`,
        [file.name],
      );
      await client.query("COMMIT");
      applied.push(file.name);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${file.name} failed: ${message}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}
