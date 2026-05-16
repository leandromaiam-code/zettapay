/**
 * Z8.2 — apply Supabase Postgres migrations against the configured pool.
 *
 *   DATABASE_URL=postgres://... \
 *   npx tsx packages/api/src/db/migrate-cli.ts
 *
 * Defaults: scans `<repo>/supabase/migrations`. Override with --dir or
 * MIGRATIONS_DIR. Reads DSN from SUPABASE_DB_URL → POSTGRES_URL → DATABASE_URL.
 */
import { resolve } from "node:path";
import {
  closePostgresPool,
  getPostgresPool,
  readPostgresConnectionString,
} from "./postgres.js";
import { runMigrations } from "./migrate.js";

function parseDirArg(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" || arg === "-d") {
      return args[i + 1] ?? null;
    }
    if (arg && arg.startsWith("--dir=")) {
      return arg.slice("--dir=".length);
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!readPostgresConnectionString()) {
    console.error(
      "[migrate] DATABASE_URL is not set — refusing to run without a DSN.",
    );
    process.exitCode = 2;
    return;
  }

  const cwdDefault = resolve(process.cwd(), "supabase", "migrations");
  const repoDefault = resolve(
    new URL("../../../../supabase/migrations", import.meta.url).pathname,
  );
  const dir =
    parseDirArg() ?? process.env.MIGRATIONS_DIR ?? cwdDefault ?? repoDefault;

  console.log(`[migrate] applying migrations from ${dir}`);
  const pool = getPostgresPool();
  try {
    const result = await runMigrations(pool, dir);
    if (result.applied.length === 0) {
      console.log(
        `[migrate] no pending migrations (${result.skipped.length} already applied)`,
      );
    } else {
      console.log(`[migrate] applied ${result.applied.length} migration(s):`);
      for (const name of result.applied) console.log(`  + ${name}`);
      if (result.skipped.length > 0) {
        console.log(`[migrate] skipped ${result.skipped.length} (already applied)`);
      }
    }
  } finally {
    await closePostgresPool();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  void closePostgresPool();
});
