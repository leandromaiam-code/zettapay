import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  appendAudit,
  listAuditEntries,
} from "../src/db/audit_journal.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  enableCoinflowSettlement,
  disableCoinflowSettlement,
} from "../src/coinflow/service.js";
import { Keypair } from "@solana/web3.js";

describe("audit_journal append-only journal (Z21.3)", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("persists an entry with actor, event, entity context, reason, and payload", () => {
    const entry = appendAudit(db, {
      actor: "merchant:m_1",
      event: "test.event",
      entityType: "merchant",
      entityId: "m_1",
      reason: "unit test",
      payload: { foo: "bar" },
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.actor).toBe("merchant:m_1");
    expect(entry.event).toBe("test.event");
    expect(entry.entityType).toBe("merchant");
    expect(entry.entityId).toBe("m_1");
    expect(entry.reason).toBe("unit test");
    expect(entry.payload).toEqual({ foo: "bar" });
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("filters by entityType and entityId", () => {
    appendAudit(db, { actor: "a", event: "e1", entityType: "merchant", entityId: "m_1" });
    appendAudit(db, { actor: "a", event: "e2", entityType: "merchant", entityId: "m_2" });
    appendAudit(db, { actor: "a", event: "e3", entityType: "agent_identity", entityId: "agt_1" });

    const merchants = listAuditEntries(db, { entityType: "merchant" });
    expect(merchants).toHaveLength(2);
    const m1Only = listAuditEntries(db, { entityType: "merchant", entityId: "m_1" });
    expect(m1Only).toHaveLength(1);
    expect(m1Only[0]?.event).toBe("e1");
  });

  it("rejects UPDATE on existing rows (immutability trigger)", () => {
    const entry = appendAudit(db, { actor: "a", event: "e", reason: "r" });
    expect(() =>
      db
        .prepare("UPDATE audit_journal SET reason = ? WHERE id = ?")
        .run("tampered", entry.id),
    ).toThrowError(/append-only/i);
  });

  it("rejects DELETE on existing rows (immutability trigger)", () => {
    const entry = appendAudit(db, { actor: "a", event: "e" });
    expect(() =>
      db.prepare("DELETE FROM audit_journal WHERE id = ?").run(entry.id),
    ).toThrowError(/append-only/i);
    // Row is still there.
    expect(listAuditEntries(db)).toHaveLength(1);
  });

  it("captures merchant.registered when a merchant onboards", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: wallet,
      email: "ops@acme.test",
      webhookUrl: "https://acme.test/webhook",
    });
    const events = listAuditEntries(db, { event: "merchant.registered" });
    expect(events).toHaveLength(1);
    expect(events[0]?.entityType).toBe("merchant");
    expect(events[0]?.entityId).toBe(merchant.id);
    expect(events[0]?.reason).toBe("self-service registration");
  });

  it("captures settlement.coinflow.enabled and disabled state changes", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "ops@acme.test",
      webhookUrl: null,
    });

    enableCoinflowSettlement(db, merchant.id, {
      coinflowMerchantId: "cf_123",
      bankAccountId: "ba_456",
      autoSettle: true,
    });
    disableCoinflowSettlement(db, merchant.id);

    const enabled = listAuditEntries(db, {
      event: "settlement.coinflow.enabled",
      entityId: merchant.id,
    });
    const disabled = listAuditEntries(db, {
      event: "settlement.coinflow.disabled",
      entityId: merchant.id,
    });
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.payload).toMatchObject({
      coinflowMerchantId: "cf_123",
      bankAccountId: "ba_456",
      autoSettle: true,
    });
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.reason).toMatch(/disabled fiat settlement/i);
  });
});
