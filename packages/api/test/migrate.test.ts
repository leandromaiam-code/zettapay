import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverMigrations,
  ensureMigrationsTable,
  listAppliedMigrations,
  runMigrations,
} from "../src/db/migrate.js";

describe("discoverMigrations", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zettapay-migrate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns sorted *.sql files matching the timestamped naming", async () => {
    await writeFile(join(dir, "20260510000000_one.sql"), "select 1;");
    await writeFile(join(dir, "20260509000000_zero.sql"), "select 0;");
    await writeFile(join(dir, "20260511000000_two.sql"), "select 2;");
    const files = await discoverMigrations(dir);
    expect(files.map((f) => f.name)).toEqual([
      "20260509000000_zero.sql",
      "20260510000000_one.sql",
      "20260511000000_two.sql",
    ]);
  });

  it("ignores non-*.sql files and files that do not match the timestamp pattern", async () => {
    await writeFile(join(dir, "README.md"), "hello");
    await writeFile(join(dir, "ignore_me.sql"), "select 1;");
    await writeFile(join(dir, "20260509000000_ok.sql"), "select 0;");
    const files = await discoverMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["20260509000000_ok.sql"]);
  });

  it("returns empty list when the directory does not exist", async () => {
    const missing = join(dir, "does-not-exist");
    const files = await discoverMigrations(missing);
    expect(files).toEqual([]);
  });

  it("returns absolute paths joined with the dir", async () => {
    const file = "20260509000000_init.sql";
    await writeFile(join(dir, file), "select 1;");
    const files = await discoverMigrations(dir);
    expect(files[0]?.path).toBe(join(dir, file));
  });
});

// In-memory pg fakes — exercise the runner's control-flow without a live DB.
type Sql = string;
interface FakeClient {
  query: (text: Sql, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  release: () => void;
  log: Array<{ text: Sql; params?: unknown[] }>;
}

interface FakePool {
  connect: () => Promise<FakeClient>;
  end: () => Promise<void>;
  /** Captures every statement that hit any client, in order. */
  log: Array<{ text: Sql; params?: unknown[] }>;
  /** Track which migrations have been recorded. */
  applied: Set<string>;
  /** Inject a SQL error keyed by substring match (first match wins, then clears). */
  failOn?: { match: string; message: string } | null;
}

function makeFakePool(): FakePool {
  const log: FakePool["log"] = [];
  const applied = new Set<string>();
  const pool: FakePool = {
    log,
    applied,
    failOn: null,
    end: async () => {},
    connect: async () => {
      const clientLog: FakeClient["log"] = [];
      return {
        log: clientLog,
        release: () => {},
        query: async (text: Sql, params?: unknown[]) => {
          log.push({ text, params });
          clientLog.push({ text, params });
          if (
            pool.failOn &&
            text.includes(pool.failOn.match) &&
            // Don't fail on the metadata insert — only on the migration body.
            !text.startsWith("INSERT INTO schema_migrations")
          ) {
            const error = new Error(pool.failOn.message);
            pool.failOn = null;
            throw error;
          }
          if (text.startsWith("INSERT INTO schema_migrations")) {
            const name = (params?.[0] as string) ?? "";
            applied.add(name);
            return { rows: [] };
          }
          if (text.startsWith("SELECT name, applied_at FROM schema_migrations")) {
            return {
              rows: Array.from(applied).map((name) => ({
                name,
                applied_at: new Date(),
              })),
            };
          }
          return { rows: [] };
        },
      };
    },
  };
  return pool;
}

describe("runMigrations", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zettapay-migrate-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty result when there are no migrations", async () => {
    const pool = makeFakePool();
    const empty = join(dir, "nope");
    await mkdir(empty, { recursive: true });
    const result = await runMigrations(pool as never, empty);
    expect(result).toEqual({ applied: [], skipped: [] });
  });

  it("applies pending files in sorted order, wraps each in BEGIN/COMMIT, records in schema_migrations", async () => {
    await writeFile(join(dir, "20260509000000_init.sql"), "create table a();");
    await writeFile(
      join(dir, "20260510000000_second.sql"),
      "create table b();",
    );
    const pool = makeFakePool();

    const result = await runMigrations(pool as never, dir);

    expect(result.applied).toEqual([
      "20260509000000_init.sql",
      "20260510000000_second.sql",
    ]);
    expect(result.skipped).toEqual([]);
    // Confirm BEGIN/body/INSERT/COMMIT shape per migration.
    const texts = pool.log.map((l) => l.text);
    expect(texts.filter((t) => t === "BEGIN").length).toBe(2);
    expect(texts.filter((t) => t === "COMMIT").length).toBe(2);
    expect(texts).toContain("create table a();");
    expect(texts).toContain("create table b();");
    expect(pool.applied.has("20260509000000_init.sql")).toBe(true);
    expect(pool.applied.has("20260510000000_second.sql")).toBe(true);
  });

  it("skips already-applied migrations", async () => {
    await writeFile(join(dir, "20260509000000_init.sql"), "create table a();");
    await writeFile(join(dir, "20260510000000_second.sql"), "create table b();");
    const pool = makeFakePool();
    pool.applied.add("20260509000000_init.sql");

    const result = await runMigrations(pool as never, dir);
    expect(result.applied).toEqual(["20260510000000_second.sql"]);
    expect(result.skipped).toEqual(["20260509000000_init.sql"]);
    // Only the second migration's body should have run.
    expect(pool.log.filter((l) => l.text === "create table a();").length).toBe(0);
    expect(pool.log.filter((l) => l.text === "create table b();").length).toBe(1);
  });

  it("rolls back the failing migration and aborts the rest with a wrapped error", async () => {
    await writeFile(join(dir, "20260509000000_init.sql"), "create table a();");
    await writeFile(
      join(dir, "20260510000000_broken.sql"),
      "create table broken();",
    );
    await writeFile(join(dir, "20260511000000_third.sql"), "create table c();");
    const pool = makeFakePool();
    pool.failOn = { match: "create table broken()", message: "syntax error at or near foo" };

    await expect(runMigrations(pool as never, dir)).rejects.toThrow(
      /20260510000000_broken\.sql failed: syntax error at or near foo/,
    );

    const texts = pool.log.map((l) => l.text);
    expect(texts).toContain("ROLLBACK");
    // Third migration must not run after the failure.
    expect(texts).not.toContain("create table c();");
    expect(pool.applied.has("20260510000000_broken.sql")).toBe(false);
  });
});

describe("ensureMigrationsTable + listAppliedMigrations", () => {
  it("issues CREATE TABLE IF NOT EXISTS schema_migrations", async () => {
    const pool = makeFakePool();
    const client = await pool.connect();
    await ensureMigrationsTable(client as never);
    expect(client.log[0]?.text ?? "").toMatch(
      /CREATE TABLE IF NOT EXISTS schema_migrations/,
    );
  });

  it("maps SELECT rows into MigrationRecord objects", async () => {
    const pool = makeFakePool();
    pool.applied.add("20260509000000_init.sql");
    pool.applied.add("20260510000000_second.sql");
    const client = await pool.connect();
    const records = await listAppliedMigrations(client as never);
    expect(records.map((r) => r.name).sort()).toEqual([
      "20260509000000_init.sql",
      "20260510000000_second.sql",
    ]);
    for (const record of records) {
      expect(record.appliedAt).toBeInstanceOf(Date);
    }
  });
});
