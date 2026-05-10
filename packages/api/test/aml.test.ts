import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  insertPayment,
  markPaymentCompleted,
  getPayment,
} from "../src/db/payments.js";
import {
  evaluatePayment,
  evaluatePaymentById,
  generateSar,
  fileSar,
  reviewAlert,
  listAlerts,
  listSars,
  getAlert,
  getSar,
  loadAmlConfigFromEnv,
  DEFAULT_AML_CONFIG,
  type AmlMonitorConfig,
} from "../src/services/aml.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { HttpError } from "../src/lib/errors.js";

function newWallet(): string {
  return Keypair.generate().publicKey.toBase58();
}

function insertCompleted(
  db: Db,
  opts: {
    merchantId: string;
    payerWallet: string;
    amount: number;
    sequence: number;
  },
): string {
  const id = `pay_aml_${opts.sequence}_${Math.random().toString(36).slice(2, 8)}`;
  insertPayment(db, {
    id,
    merchantId: opts.merchantId,
    amountUsdc: opts.amount,
    payerWallet: opts.payerWallet,
    metadata: null,
  });
  markPaymentCompleted(db, id, `sig_${id}`);
  return id;
}

describe("AML transaction monitoring (Z21.2)", () => {
  let db: Db;
  let merchantId: string;
  let payerWallet: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "AML Co",
      walletAddress: newWallet(),
      email: `aml-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerWallet = newWallet();
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("evaluatePayment rule pack", () => {
    it("does not fire alerts for a normal small payment", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 25,
        sequence: 1,
      });
      const result = evaluatePayment(db, { payment: getPayment(db, id) });
      expect(result.alerts).toHaveLength(0);
    });

    it("flags single payment ≥ high_amount threshold", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const result = evaluatePayment(db, { payment: getPayment(db, id) });
      const highAmount = result.alerts.find((a) => a.rule === "high_amount");
      expect(highAmount).toBeDefined();
      expect(highAmount?.severity).toBe("high");
      expect(highAmount?.score).toBe(75);
      expect(highAmount?.evidence["amount"]).toBe(9_500);
    });

    it("flags structuring after enough sub-threshold payments from the same payer", () => {
      // 5 payments at $1k each from same payer in <1d → fires structuring on
      // whichever evaluation pushes the rolling count past the threshold (4).
      const fired: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount: 1_000,
          sequence: i,
        });
        const res = evaluatePayment(db, { payment: getPayment(db, id) });
        for (const a of res.alerts) fired.push(a.rule);
      }
      expect(fired).toContain("structuring");
      const allAlerts = listAlerts(db, { merchantId });
      const structAlerts = allAlerts.filter((a) => a.rule === "structuring");
      expect(structAlerts).toHaveLength(1);
      expect(structAlerts[0]!.severity).toBe("high");
    });

    it("does not double-fire structuring for the same payer in the same window", () => {
      for (let i = 0; i < 5; i += 1) {
        const id = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount: 1_000,
          sequence: i,
        });
        evaluatePayment(db, { payment: getPayment(db, id) });
      }
      // Sixth payment — should NOT add another structuring alert.
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 1_000,
        sequence: 99,
      });
      const result = evaluatePayment(db, { payment: getPayment(db, id) });
      const structAlerts = result.alerts.filter(
        (a) => a.rule === "structuring",
      );
      expect(structAlerts).toHaveLength(0);
    });

    it("flags rapid_repeat_payer at 10+ payments in 5 minutes", () => {
      let last: ReturnType<typeof evaluatePayment> | null = null;
      for (let i = 0; i < 10; i += 1) {
        const id = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount: 5,
          sequence: i,
        });
        last = evaluatePayment(db, { payment: getPayment(db, id) });
      }
      const rapid = last!.alerts.find((a) => a.rule === "rapid_repeat_payer");
      expect(rapid).toBeDefined();
      expect(rapid?.severity).toBe("medium");
    });

    it("flags round_amount_pattern when 3+ round-figure payments stack up", () => {
      let last: ReturnType<typeof evaluatePayment> | null = null;
      for (let i = 0; i < 3; i += 1) {
        const id = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount: 1_000,
          sequence: i,
        });
        last = evaluatePayment(db, { payment: getPayment(db, id) });
      }
      const round = last!.alerts.find((a) => a.rule === "round_amount_pattern");
      expect(round).toBeDefined();
      expect(round?.severity).toBe("low");
    });

    it("does not trigger round_amount_pattern for non-round amounts", () => {
      let last: ReturnType<typeof evaluatePayment> | null = null;
      for (let i = 0; i < 4; i += 1) {
        const id = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount: 999.99,
          sequence: i,
        });
        last = evaluatePayment(db, { payment: getPayment(db, id) });
      }
      const round = last!.alerts.find((a) => a.rule === "round_amount_pattern");
      expect(round).toBeUndefined();
    });

    it("flags sanctioned_wallet when payer is on the denylist", () => {
      const config: AmlMonitorConfig = {
        ...DEFAULT_AML_CONFIG,
        sanctionedWallets: new Set([payerWallet]),
      };
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 5,
        sequence: 1,
      });
      const result = evaluatePayment(
        db,
        { payment: getPayment(db, id) },
        config,
      );
      const sanctioned = result.alerts.find(
        (a) => a.rule === "sanctioned_wallet",
      );
      expect(sanctioned).toBeDefined();
      expect(sanctioned?.severity).toBe("critical");
      expect(sanctioned?.score).toBe(100);
    });

    it("flags velocity_spike when merchant inbound exceeds threshold in window", () => {
      // 6 payments × $5k = $30k > $25k threshold (per default config).
      let last: ReturnType<typeof evaluatePayment> | null = null;
      for (let i = 0; i < 6; i += 1) {
        const wallet = newWallet();
        const id = insertCompleted(db, {
          merchantId,
          payerWallet: wallet,
          amount: 5_000,
          sequence: i,
        });
        last = evaluatePayment(db, { payment: getPayment(db, id) });
      }
      const spike = last!.alerts.find((a) => a.rule === "velocity_spike");
      expect(spike).toBeDefined();
    });

    it("appends an audit entry for every alert it fires", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      evaluatePayment(db, { payment: getPayment(db, id) });
      const entries = listAuditEntries(db, { event: "aml.alert.created" });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const payload = entries[0]!.payload as Record<string, unknown>;
      expect(payload["rule"]).toBe("high_amount");
      expect(payload["paymentId"]).toBe(id);
    });

    it("evaluatePaymentById returns empty result for unknown payment", () => {
      const result = evaluatePaymentById(db, { paymentId: "pay_does_not_exist" });
      expect(result.alerts).toHaveLength(0);
    });
  });

  describe("alert review workflow", () => {
    it("transitions an open alert to reviewed and audits the change", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, { payment: getPayment(db, id) });
      const alert = alerts[0]!;
      const updated = reviewAlert(db, {
        alertId: alert.id,
        merchantId,
        status: "reviewed",
        reviewedBy: "compliance@zettapay.io",
        notes: "False positive — known whale customer",
      });
      expect(updated.status).toBe("reviewed");
      expect(updated.reviewedBy).toBe("compliance@zettapay.io");
      expect(updated.reviewedAt).not.toBeNull();
      const audit = listAuditEntries(db, { event: "aml.alert.reviewed" });
      expect(audit.length).toBe(1);
    });

    it("rejects review back to 'open'", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, { payment: getPayment(db, id) });
      const alert = alerts[0]!;
      expect(() =>
        reviewAlert(db, {
          alertId: alert.id,
          merchantId,
          status: "open",
          reviewedBy: "compliance@zettapay.io",
        }),
      ).toThrow(HttpError);
    });

    it("rejects review across merchants (tenant isolation)", () => {
      const other = registerMerchant(db, {
        name: "Other",
        walletAddress: newWallet(),
        email: "other@example.com",
        webhookUrl: null,
      });
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, { payment: getPayment(db, id) });
      const alert = alerts[0]!;
      let caught: HttpError | null = null;
      try {
        reviewAlert(db, {
          alertId: alert.id,
          merchantId: other.id,
          status: "reviewed",
          reviewedBy: "x@y.z",
        });
      } catch (err) {
        caught = err as HttpError;
      }
      expect(caught?.status).toBe(404);
    });

    it("listAlerts filters by status and tenant", () => {
      const id = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      evaluatePayment(db, { payment: getPayment(db, id) });
      const open = listAlerts(db, { merchantId, status: "open" });
      const dismissed = listAlerts(db, { merchantId, status: "dismissed" });
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(dismissed.length).toBe(0);
    });
  });

  describe("SAR generation", () => {
    function seedAlerts(count: number, amount = 9_500) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const paymentId = insertCompleted(db, {
          merchantId,
          payerWallet,
          amount,
          sequence: i,
        });
        const { alerts } = evaluatePayment(db, {
          payment: getPayment(db, paymentId),
        });
        // Take the high_amount alert (deterministic per payment).
        const a = alerts.find((x) => x.rule === "high_amount");
        if (a) ids.push(a.id);
      }
      return ids;
    }

    it("creates a draft SAR with frozen alert snapshot and audit entry", () => {
      const alertIds = seedAlerts(2);
      const sar = generateSar(db, {
        merchantId,
        alertIds,
        narrative: "Repeated high-value payments from same payer over 24h",
        filedBy: "compliance@zettapay.io",
      });
      expect(sar.status).toBe("draft");
      expect(sar.reference).toMatch(/^SAR-\d{4}-/);
      expect(sar.alertCount).toBe(2);
      expect(sar.totalAmountUsdc).toBe(19_000);
      expect(sar.subjectWallet).toBe(payerWallet);
      const audits = listAuditEntries(db, { event: "aml.sar.drafted" });
      expect(audits.length).toBe(1);
    });

    it("flips referenced open alerts to escalated and stamps sar_id", () => {
      const alertIds = seedAlerts(1);
      const sar = generateSar(db, {
        merchantId,
        alertIds,
        narrative: "n",
        filedBy: "x@y.z",
      });
      const alert = getAlert(db, merchantId, alertIds[0]!);
      expect(alert.status).toBe("escalated");
      expect(alert.sarId).toBe(sar.id);
    });

    it("rejects SAR with empty alertIds", () => {
      expect(() =>
        generateSar(db, {
          merchantId,
          alertIds: [],
          narrative: "n",
          filedBy: "x@y.z",
        }),
      ).toThrow(HttpError);
    });

    it("rejects SAR referencing alerts from other merchants", () => {
      const other = registerMerchant(db, {
        name: "Other",
        walletAddress: newWallet(),
        email: "other-sar@example.com",
        webhookUrl: null,
      });
      const alertIds = seedAlerts(1);
      let caught: HttpError | null = null;
      try {
        generateSar(db, {
          merchantId: other.id,
          alertIds,
          narrative: "n",
          filedBy: "x@y.z",
        });
      } catch (err) {
        caught = err as HttpError;
      }
      expect(caught?.status).toBe(404);
    });

    it("dedupes duplicate alertIds in input", () => {
      const alertIds = seedAlerts(1);
      const sar = generateSar(db, {
        merchantId,
        alertIds: [alertIds[0]!, alertIds[0]!, alertIds[0]!],
        narrative: "n",
        filedBy: "x@y.z",
      });
      expect(sar.alertCount).toBe(1);
    });

    it("infers subjectWallet only when all alerts share the same payer", () => {
      const alertIds = seedAlerts(1);
      // Add a second alert from a different payer.
      const otherPayer = newWallet();
      const otherPaymentId = insertCompleted(db, {
        merchantId,
        payerWallet: otherPayer,
        amount: 9_500,
        sequence: 999,
      });
      const { alerts } = evaluatePayment(db, {
        payment: getPayment(db, otherPaymentId),
      });
      alertIds.push(alerts.find((a) => a.rule === "high_amount")!.id);
      const sar = generateSar(db, {
        merchantId,
        alertIds,
        narrative: "Multi-payer pattern",
        filedBy: "x@y.z",
      });
      expect(sar.subjectWallet).toBeNull();
    });
  });

  describe("fileSar", () => {
    it("transitions a draft SAR to filed and audits the filing", () => {
      const paymentId = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, {
        payment: getPayment(db, paymentId),
      });
      const sar = generateSar(db, {
        merchantId,
        alertIds: [alerts[0]!.id],
        narrative: "n",
        filedBy: "compliance@zettapay.io",
      });
      const filed = fileSar(db, {
        merchantId,
        sarId: sar.id,
        filedBy: "compliance@zettapay.io",
        externalFilingId: "FINCEN-2026-12345",
      });
      expect(filed.status).toBe("filed");
      expect(filed.filedAt).not.toBeNull();
      expect(filed.externalFilingId).toBe("FINCEN-2026-12345");
      const audits = listAuditEntries(db, { event: "aml.sar.filed" });
      expect(audits.length).toBe(1);
    });

    it("refuses to file an already-filed SAR", () => {
      const paymentId = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, {
        payment: getPayment(db, paymentId),
      });
      const sar = generateSar(db, {
        merchantId,
        alertIds: [alerts[0]!.id],
        narrative: "n",
        filedBy: "x@y.z",
      });
      fileSar(db, {
        merchantId,
        sarId: sar.id,
        filedBy: "x@y.z",
        externalFilingId: null,
      });
      let caught: HttpError | null = null;
      try {
        fileSar(db, {
          merchantId,
          sarId: sar.id,
          filedBy: "x@y.z",
          externalFilingId: null,
        });
      } catch (err) {
        caught = err as HttpError;
      }
      expect(caught?.status).toBe(409);
    });

    it("listSars + getSar honor tenant isolation", () => {
      const paymentId = insertCompleted(db, {
        merchantId,
        payerWallet,
        amount: 9_500,
        sequence: 1,
      });
      const { alerts } = evaluatePayment(db, {
        payment: getPayment(db, paymentId),
      });
      const sar = generateSar(db, {
        merchantId,
        alertIds: [alerts[0]!.id],
        narrative: "n",
        filedBy: "x@y.z",
      });
      const sars = listSars(db, { merchantId });
      expect(sars.length).toBe(1);

      const other = registerMerchant(db, {
        name: "Other",
        walletAddress: newWallet(),
        email: "other-tenant@example.com",
        webhookUrl: null,
      });
      const otherSars = listSars(db, { merchantId: other.id });
      expect(otherSars.length).toBe(0);

      let caught: HttpError | null = null;
      try {
        getSar(db, other.id, sar.id);
      } catch (err) {
        caught = err as HttpError;
      }
      expect(caught?.status).toBe(404);
    });
  });

  describe("loadAmlConfigFromEnv", () => {
    it("returns default config when env var unset", () => {
      const cfg = loadAmlConfigFromEnv({});
      expect(cfg.sanctionedWallets.size).toBe(0);
      expect(cfg.highAmountThreshold).toBe(DEFAULT_AML_CONFIG.highAmountThreshold);
    });

    it("parses comma-separated denylist into a Set", () => {
      const cfg = loadAmlConfigFromEnv({
        AML_SANCTIONED_WALLETS: " AAA111 , BBB222,CCC333 ",
      });
      expect(cfg.sanctionedWallets.size).toBe(3);
      expect(cfg.sanctionedWallets.has("AAA111")).toBe(true);
      expect(cfg.sanctionedWallets.has("BBB222")).toBe(true);
      expect(cfg.sanctionedWallets.has("CCC333")).toBe(true);
    });

    it("ignores empty entries", () => {
      const cfg = loadAmlConfigFromEnv({ AML_SANCTIONED_WALLETS: ",,,AAA,," });
      expect(cfg.sanctionedWallets.size).toBe(1);
    });
  });
});
