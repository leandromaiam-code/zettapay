import type { Database as Db } from "better-sqlite3";

export type KycProvider = "sumsub" | "persona";
export type KycStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected"
  | "blocked";

export interface KycVerificationRow {
  id: string;
  merchant_id: string;
  provider: KycProvider;
  external_id: string | null;
  applicant_id: string | null;
  level_name: string | null;
  status: KycStatus;
  review_answer: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface KycVerification {
  id: string;
  merchantId: string;
  provider: KycProvider;
  externalId: string | null;
  applicantId: string | null;
  levelName: string | null;
  status: KycStatus;
  reviewAnswer: string | null;
  reviewReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKycVerificationInput {
  id: string;
  merchantId: string;
  provider: KycProvider;
  externalId: string | null;
  applicantId: string | null;
  levelName: string | null;
}

export interface UpdateKycStatusInput {
  status: KycStatus;
  reviewAnswer: string | null;
  reviewReason: string | null;
  applicantId?: string | null;
}

export interface KycDocumentRow {
  id: string;
  verification_id: string;
  doc_type: string;
  doc_subtype: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  external_ref: string | null;
  created_at: string;
}

export interface KycDocument {
  id: string;
  verificationId: string;
  docType: string;
  docSubtype: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  externalRef: string | null;
  createdAt: string;
}

export interface CreateKycDocumentInput {
  id: string;
  verificationId: string;
  docType: string;
  docSubtype: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  externalRef: string | null;
}

function toVerification(row: KycVerificationRow): KycVerification {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    provider: row.provider,
    externalId: row.external_id,
    applicantId: row.applicant_id,
    levelName: row.level_name,
    status: row.status,
    reviewAnswer: row.review_answer,
    reviewReason: row.review_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocument(row: KycDocumentRow): KycDocument {
  return {
    id: row.id,
    verificationId: row.verification_id,
    docType: row.doc_type,
    docSubtype: row.doc_subtype,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    externalRef: row.external_ref,
    createdAt: row.created_at,
  };
}

export function insertKycVerification(
  db: Db,
  input: CreateKycVerificationInput,
): KycVerification {
  db.prepare<
    [string, string, KycProvider, string | null, string | null, string | null]
  >(
    `INSERT INTO kyc_verifications
       (id, merchant_id, provider, external_id, applicant_id, level_name, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.id,
    input.merchantId,
    input.provider,
    input.externalId,
    input.applicantId,
    input.levelName,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM kyc_verifications WHERE id = ?")
    .get(input.id) as KycVerificationRow | undefined;
  if (!row) {
    throw new Error("kyc verification inserted but not retrievable");
  }
  return toVerification(row);
}

export function findKycVerificationByMerchantId(
  db: Db,
  merchantId: string,
): KycVerification | null {
  const row = db
    .prepare<[string]>(
      "SELECT * FROM kyc_verifications WHERE merchant_id = ?",
    )
    .get(merchantId) as KycVerificationRow | undefined;
  return row ? toVerification(row) : null;
}

export function findKycVerificationByApplicantId(
  db: Db,
  provider: KycProvider,
  applicantId: string,
): KycVerification | null {
  const row = db
    .prepare<[KycProvider, string]>(
      "SELECT * FROM kyc_verifications WHERE provider = ? AND applicant_id = ?",
    )
    .get(provider, applicantId) as KycVerificationRow | undefined;
  return row ? toVerification(row) : null;
}

export function findKycVerificationByExternalId(
  db: Db,
  provider: KycProvider,
  externalId: string,
): KycVerification | null {
  const row = db
    .prepare<[KycProvider, string]>(
      "SELECT * FROM kyc_verifications WHERE provider = ? AND external_id = ?",
    )
    .get(provider, externalId) as KycVerificationRow | undefined;
  return row ? toVerification(row) : null;
}

/**
 * Idempotent state transition. Status only moves when the new value differs;
 * the row's `updated_at` is touched on every call so callers can audit
 * webhook-triggered no-ops separately.
 */
export function updateKycStatus(
  db: Db,
  id: string,
  input: UpdateKycStatusInput,
): KycVerification {
  const nowIso = new Date().toISOString();
  if (input.applicantId !== undefined) {
    db.prepare<[KycStatus, string | null, string | null, string | null, string, string]>(
      `UPDATE kyc_verifications
          SET status         = ?,
              review_answer  = ?,
              review_reason  = ?,
              applicant_id   = COALESCE(applicant_id, ?),
              updated_at     = ?
        WHERE id = ?`,
    ).run(
      input.status,
      input.reviewAnswer,
      input.reviewReason,
      input.applicantId,
      nowIso,
      id,
    );
  } else {
    db.prepare<[KycStatus, string | null, string | null, string, string]>(
      `UPDATE kyc_verifications
          SET status        = ?,
              review_answer = ?,
              review_reason = ?,
              updated_at    = ?
        WHERE id = ?`,
    ).run(input.status, input.reviewAnswer, input.reviewReason, nowIso, id);
  }
  const row = db
    .prepare<[string]>("SELECT * FROM kyc_verifications WHERE id = ?")
    .get(id) as KycVerificationRow | undefined;
  if (!row) {
    throw new Error(`kyc verification ${id} disappeared after update`);
  }
  return toVerification(row);
}

export function insertKycDocument(
  db: Db,
  input: CreateKycDocumentInput,
): KycDocument {
  db.prepare<
    [
      string,
      string,
      string,
      string | null,
      string | null,
      string | null,
      number | null,
      string | null,
    ]
  >(
    `INSERT INTO kyc_documents
       (id, verification_id, doc_type, doc_subtype, file_name, mime_type, size_bytes, external_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.verificationId,
    input.docType,
    input.docSubtype,
    input.fileName,
    input.mimeType,
    input.sizeBytes,
    input.externalRef,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM kyc_documents WHERE id = ?")
    .get(input.id) as KycDocumentRow | undefined;
  if (!row) {
    throw new Error("kyc document inserted but not retrievable");
  }
  return toDocument(row);
}

export function listKycDocumentsByVerificationId(
  db: Db,
  verificationId: string,
): KycDocument[] {
  const rows = db
    .prepare<[string]>(
      "SELECT * FROM kyc_documents WHERE verification_id = ? ORDER BY created_at ASC",
    )
    .all(verificationId) as KycDocumentRow[];
  return rows.map(toDocument);
}
