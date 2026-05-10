import type { Database as Db } from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  findMerchantById,
  redactMerchant,
  type Merchant,
} from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";
import {
  currentConsentStateForSubject,
  insertConsentRecord,
  listConsentRecordsForSubject,
  type ConsentRecord,
  type ConsentSubjectType,
} from "../db/consent_records.js";
import { listSubscriptionsByMerchant } from "../db/subscriptions.js";
import { newId } from "../lib/id.js";
import { HttpError } from "../lib/errors.js";

// LGPD/GDPR data export (right of access). Includes everything we hold about
// the merchant data subject, plus pointers to financial records that survive
// erasure. Payments themselves are summarized rather than dumped wholesale to
// keep the response bounded — full audit detail lives in /audit endpoints.
export interface MerchantPrivacyExport {
  exportedAt: string;
  merchant: {
    id: string;
    name: string;
    email: string;
    walletAddress: string;
    webhookUrl: string | null;
    createdAt: string;
    deletedAt: string | null;
  };
  payments: {
    total: number;
    completed: number;
    failed: number;
    earliestCreatedAt: string | null;
    latestCreatedAt: string | null;
  };
  subscriptions: Array<{
    id: string;
    customerWallet: string;
    amount: number;
    currency: string;
    interval: string;
    status: string;
    createdAt: string;
  }>;
  consents: ConsentRecord[];
  retainedForLegalObligations: {
    payments: string;
    auditJournal: string;
    kycVerifications: string;
  };
}

const RETENTION_NOTES = {
  payments:
    "Financial transaction records are retained per LGPD Art. 16 II / GDPR Art. 17(3)(b) (legal obligation, financial-record retention).",
  auditJournal:
    "Append-only audit_journal entries are retained for compliance investigation per LGPD Art. 16 II / GDPR Art. 17(3)(e).",
  kycVerifications:
    "KYC/AML verification records (when present) are retained 5+ years per regulatory obligation, even after erasure.",
} as const;

export function exportMerchantData(
  db: Db,
  merchantId: string,
): MerchantPrivacyExport {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }

  const paymentStats = db
    .prepare<[string]>(
      `SELECT
         COUNT(*)                                                   AS total,
         COUNT(CASE WHEN status = 'completed' THEN 1 END)           AS completed,
         COUNT(CASE WHEN status = 'failed'    THEN 1 END)           AS failed,
         MIN(created_at)                                            AS earliest,
         MAX(created_at)                                            AS latest
       FROM payments WHERE merchant_id = ?`,
    )
    .get(merchantId) as {
    total: number;
    completed: number;
    failed: number;
    earliest: string | null;
    latest: string | null;
  };

  const subscriptions = listSubscriptionsByMerchant(db, merchantId, 1000).map(
    (s) => ({
      id: s.id,
      customerWallet: s.customerWallet,
      amount: s.amount,
      currency: s.currency,
      interval: s.interval,
      status: s.status,
      createdAt: s.createdAt,
    }),
  );

  const consents = listConsentRecordsForSubject(db, "merchant", merchantId);

  appendAudit(db, {
    actor: `merchant:${merchantId}`,
    event: "privacy.data_exported",
    entityType: "merchant",
    entityId: merchantId,
    reason: "LGPD/GDPR right of access — data export",
    payload: {
      paymentTotal: paymentStats.total,
      subscriptionCount: subscriptions.length,
      consentCount: consents.length,
    },
  });

  return {
    exportedAt: new Date().toISOString(),
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      walletAddress: merchant.walletAddress,
      webhookUrl: merchant.webhookUrl,
      createdAt: merchant.createdAt,
      deletedAt: merchant.deletedAt,
    },
    payments: {
      total: paymentStats.total,
      completed: paymentStats.completed,
      failed: paymentStats.failed,
      earliestCreatedAt: paymentStats.earliest,
      latestCreatedAt: paymentStats.latest,
    },
    subscriptions,
    consents,
    retainedForLegalObligations: { ...RETENTION_NOTES },
  };
}

export interface DeletionResult {
  merchantId: string;
  deletedAt: string;
  retained: {
    payments: number;
    auditJournalEntries: number;
  };
}

// Right-to-erasure. Anonymizes the merchant row, cancels active subscriptions
// (no future side effects against an erased merchant), and writes the audit
// proof. Does NOT delete payments — they are retained under the financial
// obligation carve-out and the merchant FK still points at the redacted row.
export function deleteMerchantData(
  db: Db,
  merchantId: string,
): DeletionResult {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  if (merchant.deletedAt) {
    throw HttpError.conflict(
      `Merchant ${merchantId} already redacted at ${merchant.deletedAt}`,
    );
  }

  const now = new Date().toISOString();
  const idHash = createHash("sha256").update(merchantId).digest("hex").slice(0, 16);
  const redacted = redactMerchant(db, merchantId, {
    redactedName: "[redacted]",
    redactedEmail: `redacted+${idHash}@privacy.zettapay.invalid`,
    redactedApiKey: `revoked_${idHash}`,
    redactedAt: now,
  });

  const cancelResult = db
    .prepare<[string]>(
      `UPDATE subscriptions
         SET status = 'canceled',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE merchant_id = ? AND status != 'canceled'`,
    )
    .run(merchantId);

  const paymentCount = db
    .prepare<[string]>(`SELECT COUNT(*) AS n FROM payments WHERE merchant_id = ?`)
    .get(merchantId) as { n: number };

  const auditCount = db
    .prepare<[string, string]>(
      `SELECT COUNT(*) AS n FROM audit_journal WHERE entity_type = ? AND entity_id = ?`,
    )
    .get("merchant", merchantId) as { n: number };

  appendAudit(db, {
    actor: `merchant:${merchantId}`,
    event: "privacy.data_deleted",
    entityType: "merchant",
    entityId: merchantId,
    reason: "LGPD/GDPR right to erasure — merchant PII redacted",
    payload: {
      deletedAt: redacted.deletedAt,
      subscriptionsCanceled: cancelResult.changes,
      retainedPayments: paymentCount.n,
      retainedAuditEntries: auditCount.n + 1,
    },
  });

  return {
    merchantId: redacted.id,
    deletedAt: redacted.deletedAt ?? now,
    retained: {
      payments: paymentCount.n,
      auditJournalEntries: auditCount.n + 1,
    },
  };
}

export interface RecordConsentDecision {
  subjectType: ConsentSubjectType;
  subjectId: string;
  purpose: string;
  granted: boolean;
  source: string | null;
  metadata: Record<string, unknown> | null;
  actor: string;
}

export function recordConsentDecision(
  db: Db,
  input: RecordConsentDecision,
): ConsentRecord {
  // Defensive: if the subject is a merchant, ensure the row exists and is not
  // already redacted. Recording new consents against a redacted merchant
  // would resurrect the proof trail under bogus terms.
  if (input.subjectType === "merchant") {
    const merchant = findMerchantById(db, input.subjectId);
    if (!merchant) {
      throw HttpError.notFound(`Merchant ${input.subjectId} not found`);
    }
    if (merchant.deletedAt) {
      throw HttpError.conflict(
        `Merchant ${input.subjectId} is redacted — consent cannot be recorded`,
      );
    }
  }

  const record = insertConsentRecord(db, {
    id: newId("cnsnt"),
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    purpose: input.purpose,
    granted: input.granted,
    source: input.source,
    metadata: input.metadata,
  });

  appendAudit(db, {
    actor: input.actor,
    event: input.granted ? "privacy.consent_granted" : "privacy.consent_withdrawn",
    entityType: "consent_record",
    entityId: record.id,
    reason: `LGPD/GDPR consent ${input.granted ? "granted" : "withdrawn"} for purpose "${input.purpose}"`,
    payload: {
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      purpose: record.purpose,
      source: record.source,
    },
  });

  return record;
}

export function getCurrentConsents(
  db: Db,
  subjectType: ConsentSubjectType,
  subjectId: string,
): ConsentRecord[] {
  return currentConsentStateForSubject(db, subjectType, subjectId);
}
