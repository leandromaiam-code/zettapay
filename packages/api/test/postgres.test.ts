import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  buildPoolConfig,
  readPostgresConnectionString,
  resetPostgresPoolForTests,
  shouldUsePostgres,
  shouldUseSslForHost,
} from "../src/db/postgres.js";

describe("postgres pool config", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetPostgresPoolForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("uses tls for non-loopback hosts", () => {
    expect(shouldUseSslForHost("aws-0-us-east-1.pooler.supabase.com")).toBe(
      true,
    );
    expect(shouldUseSslForHost("db.example.com")).toBe(true);
  });

  it("skips tls on loopback so dev Postgres works", () => {
    expect(shouldUseSslForHost("localhost")).toBe(false);
    expect(shouldUseSslForHost("127.0.0.1")).toBe(false);
    expect(shouldUseSslForHost("::1")).toBe(false);
  });

  it("buildPoolConfig defaults: ssl on for managed hosts, sane pool sizing", () => {
    const cfg = buildPoolConfig({
      connectionString:
        "postgres://postgres:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: false });
    expect(cfg.max).toBe(10);
    expect(cfg.min).toBe(0);
    expect(cfg.connectionTimeoutMillis).toBe(10_000);
    expect(cfg.idleTimeoutMillis).toBe(30_000);
    expect(cfg.application_name).toBe("zettapay-api");
    expect(cfg.statement_timeout).toBe(30_000);
  });

  it("buildPoolConfig disables ssl on loopback DSNs", () => {
    const cfg = buildPoolConfig({
      connectionString: "postgres://postgres:postgres@127.0.0.1:5432/zettapay",
    });
    expect(cfg.ssl).toBe(false);
  });

  it("buildPoolConfig honors caller overrides for ssl, pool size, timeouts", () => {
    const cfg = buildPoolConfig({
      connectionString: "postgres://u:p@db.example.com/z",
      ssl: false,
      max: 25,
      min: 2,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 2_000,
      statementTimeoutMillis: 5_000,
    });
    expect(cfg.ssl).toBe(false);
    expect(cfg.max).toBe(25);
    expect(cfg.min).toBe(2);
    expect(cfg.idleTimeoutMillis).toBe(60_000);
    expect(cfg.connectionTimeoutMillis).toBe(2_000);
    expect(cfg.statement_timeout).toBe(5_000);
  });

  it("readPostgresConnectionString prefers SUPABASE_DB_URL → POSTGRES_URL → DATABASE_URL", () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.DATABASE_URL;
    expect(readPostgresConnectionString()).toBeNull();

    process.env.DATABASE_URL = "postgres://a/b";
    expect(readPostgresConnectionString()).toBe("postgres://a/b");

    process.env.POSTGRES_URL = "postgres://c/d";
    expect(readPostgresConnectionString()).toBe("postgres://c/d");

    process.env.SUPABASE_DB_URL = "postgres://e/f";
    expect(readPostgresConnectionString()).toBe("postgres://e/f");
  });

  it("readPostgresConnectionString trims whitespace and treats empty as missing", () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.POSTGRES_URL;
    process.env.DATABASE_URL = "   ";
    expect(readPostgresConnectionString()).toBeNull();
    process.env.DATABASE_URL = "  postgres://x/y  ";
    expect(readPostgresConnectionString()).toBe("postgres://x/y");
  });

  it("shouldUsePostgres only flips on with explicit DATABASE_DRIVER=postgres", () => {
    delete process.env.DATABASE_DRIVER;
    expect(shouldUsePostgres()).toBe(false);

    process.env.DATABASE_DRIVER = "sqlite";
    expect(shouldUsePostgres()).toBe(false);

    process.env.DATABASE_DRIVER = "postgres";
    expect(shouldUsePostgres()).toBe(true);

    process.env.DATABASE_DRIVER = "POSTGRES";
    expect(shouldUsePostgres()).toBe(true);
  });
});
