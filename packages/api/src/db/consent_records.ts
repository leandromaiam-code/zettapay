import type { Database as Db } from "better-sqlite3";

// LGPD Art. 8 / GDPR Art. 6+7 — explicit, purpose-bound, withdrawable consent.
// `subject_type` distinguishes who consented:
//   - "merchant" → merchant_id (operator of the integration)
//   - "wallet"   → payer wallet base58 (data subject who used the merchant)
// `purpose` is the canonical reason (e.g. "marketing", "analytics",
// "data_processing"). The same (subject, purpose) pair can be re-granted after
// withdrawal — the latest row wins. Old rows are retained as the proof trail
// (LGPD Art. 8 §6 requires evidence of consent for the duration of treatment).
export type ConsentSubjectType = "merchant" | "wallet";

export interface ConsentRecordRow {
  id: string;
  subject_type: ConsentSubjectType;
  subject_id: string;
  purpose: string;
  granted: number;
  granted_at: string | null;
  withdrawn_at: string | null;
  source: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface ConsentRecord {
  id: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  purpose: string;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordConsentInput {
  id: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  purpose: string;
  granted: boolean;
  source: string | null;
  metadata: Record<string, unknown> | null;
}

function toRecord(row: ConsentRecordRow): ConsentRecord {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    purpose: row.purpose,
    granted: row.granted === 1,
    grantedAt: row.granted_at,
    withdrawnAt: row.withdrawn_at,
    source: row.source,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
  };
}

export function insertConsentRecord(
  db: Db,
  input: RecordConsentInput,
): ConsentRecord {
  const grantedFlag = input.granted ? 1 : 0;
  const grantedAt = input.granted ? new Date().toISOString() : null;
  const withdrawnAt = input.granted ? null : new Date().toISOString();
  db.prepare<
    [
      string,
      ConsentSubjectType,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO consent_records
       (id, subject_type, subject_id, purpose, granted, granted_at, withdrawn_at, source, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.subjectType,
    input.subjectId,
    input.purpose,
    grantedFlag,
    grantedAt,
    withdrawnAt,
    input.source,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM consent_records WHERE id = ?")
    .get(input.id) as ConsentRecordRow | undefined;
  if (!row) {
    throw new Error("consent record inserted but not retrievable");
  }
  return toRecord(row);
}

export function listConsentRecordsForSubject(
  db: Db,
  subjectType: ConsentSubjectType,
  subjectId: string,
): ConsentRecord[] {
  const rows = db
    .prepare<[ConsentSubjectType, string]>(
      `SELECT * FROM consent_records
         WHERE subject_type = ? AND subject_id = ?
         ORDER BY created_at DESC`,
    )
    .all(subjectType, subjectId) as ConsentRecordRow[];
  return rows.map(toRecord);
}

// Latest decision per purpose. Returned in stable order keyed by purpose so
// downstream callers (export, audit) get deterministic output.
export function currentConsentStateForSubject(
  db: Db,
  subjectType: ConsentSubjectType,
  subjectId: string,
): ConsentRecord[] {
  const rows = db
    .prepare<[ConsentSubjectType, string, ConsentSubjectType, string]>(
      `SELECT cr.* FROM consent_records cr
         INNER JOIN (
           SELECT purpose, MAX(created_at) AS latest
             FROM consent_records
             WHERE subject_type = ? AND subject_id = ?
             GROUP BY purpose
         ) latest_by_purpose
           ON latest_by_purpose.purpose = cr.purpose
          AND latest_by_purpose.latest  = cr.created_at
         WHERE cr.subject_type = ? AND cr.subject_id = ?
         ORDER BY cr.purpose ASC`,
    )
    .all(subjectType, subjectId, subjectType, subjectId) as ConsentRecordRow[];
  return rows.map(toRecord);
}
