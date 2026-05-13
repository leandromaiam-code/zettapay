import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  buildProtocolConfigId,
  getProtocolConfig,
  isProtocolCluster,
  listProtocolConfigs,
  upsertProtocolConfig,
} from "../src/db/protocol_config.js";

const DEVNET_PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const TESTNET_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const DEPLOYER = "11111111111111111111111111111111";

describe("isProtocolCluster", () => {
  it("accepts the four canonical Solana clusters", () => {
    expect(isProtocolCluster("mainnet-beta")).toBe(true);
    expect(isProtocolCluster("devnet")).toBe(true);
    expect(isProtocolCluster("testnet")).toBe(true);
    expect(isProtocolCluster("localnet")).toBe(true);
  });

  it("rejects unknown clusters and aliases", () => {
    expect(isProtocolCluster("mainnet")).toBe(false);
    expect(isProtocolCluster("DEVNET")).toBe(false);
    expect(isProtocolCluster("")).toBe(false);
  });
});

describe("buildProtocolConfigId", () => {
  it("returns a deterministic <program>:<cluster> composite", () => {
    expect(buildProtocolConfigId("zettapay-core", "devnet")).toBe(
      "zettapay-core:devnet",
    );
  });
});

describe("upsertProtocolConfig", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("inserts a fresh row and round-trips every column", () => {
    const inserted = upsertProtocolConfig(db, {
      programName: "zettapay-core",
      cluster: "devnet",
      programId: DEVNET_PROGRAM_ID,
      deployerPubkey: DEPLOYER,
      deployTxSignature: "sig123",
      artifactSha256: "abc".padEnd(64, "0"),
      artifactSize: 245760,
    });
    expect(inserted.id).toBe("zettapay-core:devnet");
    expect(inserted.programId).toBe(DEVNET_PROGRAM_ID);
    expect(inserted.deployerPubkey).toBe(DEPLOYER);
    expect(inserted.deployTxSignature).toBe("sig123");
    expect(inserted.artifactSize).toBe(245760);
    expect(inserted.deployedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const fetched = getProtocolConfig(db, "zettapay-core", "devnet");
    expect(fetched?.programId).toBe(DEVNET_PROGRAM_ID);
    expect(fetched?.artifactSha256).toBe("abc".padEnd(64, "0"));
  });

  it("upserts on (program_name, cluster) — second call replaces program_id", async () => {
    const first = upsertProtocolConfig(db, {
      programName: "zettapay-core",
      cluster: "devnet",
      programId: DEVNET_PROGRAM_ID,
    });
    // strftime('%f','now') has millisecond resolution; sleep one tick so
    // updated_at can legitimately move forward.
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertProtocolConfig(db, {
      programName: "zettapay-core",
      cluster: "devnet",
      programId: TESTNET_PROGRAM_ID,
      deployTxSignature: "new-sig",
    });
    expect(second.id).toBe(first.id);
    expect(second.programId).toBe(TESTNET_PROGRAM_ID);
    expect(second.deployTxSignature).toBe("new-sig");
    expect(second.deployedAt).toBe(first.deployedAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);

    const all = listProtocolConfigs(db);
    expect(all).toHaveLength(1);
  });

  it("keeps separate rows for the same program across clusters", () => {
    upsertProtocolConfig(db, {
      programName: "zettapay-core",
      cluster: "devnet",
      programId: DEVNET_PROGRAM_ID,
    });
    upsertProtocolConfig(db, {
      programName: "zettapay-core",
      cluster: "testnet",
      programId: TESTNET_PROGRAM_ID,
    });
    const all = listProtocolConfigs(db);
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.cluster).sort()).toEqual(["devnet", "testnet"]);
  });

  it("rejects an invalid cluster before touching the DB", () => {
    expect(() =>
      upsertProtocolConfig(db, {
        programName: "zettapay-core",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cluster: "mainnet" as any,
        programId: DEVNET_PROGRAM_ID,
      }),
    ).toThrow(/invalid cluster/);
  });

  it("rejects empty programName / programId", () => {
    expect(() =>
      upsertProtocolConfig(db, {
        programName: "",
        cluster: "devnet",
        programId: DEVNET_PROGRAM_ID,
      }),
    ).toThrow(/programName/);
    expect(() =>
      upsertProtocolConfig(db, {
        programName: "zettapay-core",
        cluster: "devnet",
        programId: "",
      }),
    ).toThrow(/programId/);
  });

  it("getProtocolConfig returns null when no row exists for the pair", () => {
    expect(getProtocolConfig(db, "zettapay-core", "devnet")).toBeNull();
  });
});
