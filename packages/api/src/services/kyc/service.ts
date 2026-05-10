import type { Database as Db } from "better-sqlite3";
import {
  findKycVerificationByApplicantId,
  findKycVerificationByExternalId,
  findKycVerificationByMerchantId,
  insertKycDocument,
  insertKycVerification,
  listKycDocumentsByVerificationId,
  updateKycStatus,
  type KycDocument,
  type KycProvider,
  type KycVerification,
} from "../../db/kyc.js";
import { findMerchantById } from "../../db/merchants.js";
import { appendAudit } from "../../db/audit_journal.js";
import { HttpError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import type { KycProviderClient } from "./provider.js";
import { mapSumsubReview, type SumsubReviewPayload } from "./sumsub.js";

const MIN_FILE_NAME = 1;
const MAX_FILE_NAME = 256;
const MAX_DOC_TYPE = 64;
const MAX_DOC_SUBTYPE = 64;
const MAX_MIME = 128;
const MAX_REF = 256;

export interface StartKycInput {
  merchantId: string;
  levelName?: string;
}

export interface StartKycResult {
  verification: KycVerification;
  accessToken: {
    token: string;
    expiresAt: string;
    userId: string;
  };
}

/**
 * Lazily provision a verification record + a provider access token. Re-callable —
 * subsequent calls return a fresh access token but reuse the existing
 * applicant on the provider side (Sumsub keys off externalUserId = merchantId).
 */
export async function startKyc(
  db: Db,
  provider: KycProviderClient,
  input: StartKycInput,
): Promise<StartKycResult> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  const levelName = input.levelName ?? defaultLevelName(provider.name);

  let verification = findKycVerificationByMerchantId(db, input.merchantId);
  let applicantId = verification?.applicantId ?? null;

  if (!verification) {
    const created = await provider.createApplicant({
      externalUserId: input.merchantId,
      levelName,
      email: merchant.email,
    });
    applicantId = created.applicantId;
    verification = insertKycVerification(db, {
      id: newId("kyc"),
      merchantId: input.merchantId,
      provider: provider.name,
      externalId: input.merchantId,
      applicantId,
      levelName,
    });
    appendAudit(db, {
      actor: `merchant:${input.merchantId}`,
      event: "kyc.verification.created",
      payload: {
        verificationId: verification.id,
        provider: provider.name,
        applicantId,
        levelName,
      },
    });
  }

  const accessToken = await provider.issueAccessToken({
    externalUserId: input.merchantId,
    levelName: verification.levelName ?? levelName,
  });

  appendAudit(db, {
    actor: `merchant:${input.merchantId}`,
    event: "kyc.access_token.issued",
    payload: {
      verificationId: verification.id,
      provider: provider.name,
      expiresAt: accessToken.expiresAt,
    },
  });

  return { verification, accessToken };
}

export interface RecordDocumentInput {
  merchantId: string;
  docType: string;
  docSubtype?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  externalRef?: string | null;
}

export interface RecordDocumentResult {
  verification: KycVerification;
  document: KycDocument;
}

/**
 * Records that a document was submitted via the provider's WebSDK.
 *
 * Premissa #20 (zero secrets), #14 (no custody) and the broader principle of
 * minimizing PII surface drive this design: we don't proxy raw document bytes
 * through our backend. The merchant uploads to Sumsub directly via the WebSDK
 * (using the access token from `startKyc`) and posts a metadata record here so
 * we can index "what was submitted" without ever holding the file.
 */
export function recordDocument(
  db: Db,
  input: RecordDocumentInput,
): RecordDocumentResult {
  const verification = findKycVerificationByMerchantId(db, input.merchantId);
  if (!verification) {
    throw HttpError.badRequest(
      `Merchant ${input.merchantId} has not started KYC — call /kyc/start first`,
    );
  }
  if (verification.status === "approved" || verification.status === "blocked") {
    throw HttpError.conflict(
      `KYC verification is ${verification.status}; further document submissions are not accepted`,
    );
  }

  const docType = trimAndCheck(input.docType, "docType", 1, MAX_DOC_TYPE);
  const docSubtype = optionalTrimAndCheck(
    input.docSubtype,
    "docSubtype",
    MAX_DOC_SUBTYPE,
  );
  const fileName = optionalTrimAndCheck(
    input.fileName,
    "fileName",
    MAX_FILE_NAME,
    MIN_FILE_NAME,
  );
  const mimeType = optionalTrimAndCheck(input.mimeType, "mimeType", MAX_MIME);
  const externalRef = optionalTrimAndCheck(
    input.externalRef,
    "externalRef",
    MAX_REF,
  );
  const sizeBytes = input.sizeBytes ?? null;
  if (sizeBytes !== null) {
    if (
      typeof sizeBytes !== "number" ||
      !Number.isFinite(sizeBytes) ||
      !Number.isInteger(sizeBytes) ||
      sizeBytes < 0
    ) {
      throw HttpError.badRequest(
        `"sizeBytes" must be a non-negative integer when provided`,
      );
    }
  }

  const document = insertKycDocument(db, {
    id: newId("kycdoc"),
    verificationId: verification.id,
    docType,
    docSubtype,
    fileName,
    mimeType,
    sizeBytes,
    externalRef,
  });

  // First document submission flips status from `pending` to `in_review` —
  // subsequent uploads are no-ops on status. Webhook authoritatively overrides.
  let updated = verification;
  if (verification.status === "pending") {
    updated = updateKycStatus(db, verification.id, {
      status: "in_review",
      reviewAnswer: verification.reviewAnswer,
      reviewReason: verification.reviewReason,
    });
  }

  appendAudit(db, {
    actor: `merchant:${input.merchantId}`,
    event: "kyc.document.recorded",
    payload: {
      verificationId: verification.id,
      documentId: document.id,
      docType,
      ...(externalRef ? { externalRef } : {}),
    },
  });

  return { verification: updated, document };
}

export interface KycStatusView {
  verification: KycVerification;
  documents: KycDocument[];
}

export function getKycStatus(db: Db, merchantId: string): KycStatusView | null {
  const verification = findKycVerificationByMerchantId(db, merchantId);
  if (!verification) return null;
  const documents = listKycDocumentsByVerificationId(db, verification.id);
  return { verification, documents };
}

export interface ApplyWebhookInput {
  provider: KycProvider;
  payload: SumsubReviewPayload;
}

export interface ApplyWebhookResult {
  verification: KycVerification | null;
  changed: boolean;
}

/**
 * Apply a verified webhook payload to the local KYC state. The webhook
 * dispatcher is responsible for signature verification before this is called.
 *
 * Premissa #9 (Stripe-grade webhooks) — duplicate deliveries are a no-op
 * because the payload-derived state is idempotent: we update to the same value
 * the webhook implies, regardless of how many times it arrives.
 */
export function applyWebhookEvent(
  db: Db,
  input: ApplyWebhookInput,
): ApplyWebhookResult {
  if (input.provider !== "sumsub") {
    throw HttpError.badRequest(
      `Webhook provider "${input.provider}" is not yet supported`,
    );
  }

  const applicantId = input.payload.applicantId?.trim();
  const externalUserId = input.payload.externalUserId?.trim();
  if (!applicantId && !externalUserId) {
    throw HttpError.badRequest(
      "Webhook payload is missing applicantId and externalUserId — cannot route",
    );
  }

  let verification: KycVerification | null = null;
  if (applicantId) {
    verification = findKycVerificationByApplicantId(db, "sumsub", applicantId);
  }
  if (!verification && externalUserId) {
    verification = findKycVerificationByExternalId(db, "sumsub", externalUserId);
  }
  if (!verification) {
    // Webhook for an unknown applicant — log it but don't 500. Sumsub will
    // stop retrying after a 2xx and these are usually duplicates from
    // sandbox/test runs the merchant didn't tell us about.
    appendAudit(db, {
      actor: "provider:sumsub",
      event: "kyc.webhook.unknown_applicant",
      payload: { applicantId, externalUserId, type: input.payload.type },
    });
    return { verification: null, changed: false };
  }

  const verdict = mapSumsubReview(input.payload);
  const before = verification.status;

  const updated = updateKycStatus(db, verification.id, {
    status: verdict.status,
    reviewAnswer: verdict.reviewAnswer,
    reviewReason: verdict.reviewReason,
    ...(applicantId && !verification.applicantId
      ? { applicantId }
      : {}),
  });

  const changed =
    before !== updated.status ||
    verification.reviewAnswer !== updated.reviewAnswer ||
    verification.reviewReason !== updated.reviewReason;

  appendAudit(db, {
    actor: "provider:sumsub",
    event: changed
      ? "kyc.verification.updated"
      : "kyc.webhook.replayed",
    payload: {
      verificationId: updated.id,
      merchantId: updated.merchantId,
      from: before,
      to: updated.status,
      type: input.payload.type ?? null,
    },
  });

  return { verification: updated, changed };
}

function defaultLevelName(provider: KycProviderClient["name"]): string {
  // Sumsub default level for merchant KYB. Override per-call when other
  // verification flows (individual KYC, enhanced due diligence) are needed.
  return provider === "sumsub" ? "basic-kyb-level" : "default";
}

function trimAndCheck(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw HttpError.badRequest(`"${field}" must be a string`);
  }
  const t = value.trim();
  if (t.length < min) {
    throw HttpError.badRequest(`"${field}" is required`);
  }
  if (t.length > max) {
    throw HttpError.badRequest(`"${field}" exceeds max length of ${max}`);
  }
  return t;
}

function optionalTrimAndCheck(
  value: unknown,
  field: string,
  max: number,
  min = 0,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw HttpError.badRequest(`"${field}" must be a string when provided`);
  }
  const t = value.trim();
  if (t.length === 0) return null;
  if (t.length < min) {
    throw HttpError.badRequest(`"${field}" must be at least ${min} chars`);
  }
  if (t.length > max) {
    throw HttpError.badRequest(`"${field}" exceeds max length of ${max}`);
  }
  return t;
}
