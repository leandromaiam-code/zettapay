import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  deleteMerchantData,
  exportMerchantData,
  getCurrentConsents,
  recordConsentDecision,
} from "../services/privacy.js";
import type { ConsentSubjectType } from "../db/consent_records.js";
import { HttpError } from "../lib/errors.js";
import { idempotency } from "../middleware/idempotency.js";
import {
  optionalRecord,
  optionalString,
  requireString,
} from "../lib/validate.js";

const API_KEY_HEADER = "x-zettapay-api-key";

const CONSENT_SUBJECT_TYPES: readonly ConsentSubjectType[] = [
  "merchant",
  "wallet",
] as const;

function isConsentSubjectType(value: string): value is ConsentSubjectType {
  return (CONSENT_SUBJECT_TYPES as readonly string[]).includes(value);
}

function authMerchant(db: Db, apiKey: string | undefined) {
  if (!apiKey) {
    throw HttpError.unauthorized(`"${API_KEY_HEADER}" header is required`);
  }
  const merchant = findMerchantByApiKey(db, apiKey.trim());
  if (!merchant) {
    throw HttpError.unauthorized("Invalid API key");
  }
  return merchant;
}

function requireBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") {
    throw HttpError.badRequest(
      `Field "${field}" is required and must be a boolean`,
    );
  }
  return value;
}

export function privacyRouter(db: Db): Router {
  const router = Router();

  // LGPD Art. 18 / GDPR Art. 15 — right of access. Authenticates via API key
  // so only the data subject (merchant operator) can pull their own dump.
  router.get("/privacy/export", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const dump = exportMerchantData(db, merchant.id);
      res.json(dump);
    } catch (err) {
      next(err);
    }
  });

  // LGPD Art. 18 VI / GDPR Art. 17 — right to erasure. Idempotent at the
  // request level (replay returns 409 from the service "already redacted"
  // check rather than re-anonymizing). Requires explicit confirmation string
  // to prevent a misrouted automation from nuking PII silently.
  router.post(
    "/privacy/deletion",
    idempotency(db, { scope: "POST /privacy/deletion" }),
    (req, res, next) => {
      try {
        const merchant = authMerchant(db, req.header(API_KEY_HEADER));
        const body = (req.body ?? {}) as Record<string, unknown>;
        const confirmation = requireString(body, "confirmation", {
          maxLength: 32,
        });
        if (confirmation !== "DELETE") {
          throw HttpError.badRequest(
            'Field "confirmation" must be the literal string "DELETE" to authorize erasure',
          );
        }
        const result = deleteMerchantData(db, merchant.id);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // LGPD Art. 8 / GDPR Art. 6+7 — record granted/withdrawn consent for a
  // purpose. Merchants can record consent for themselves OR for a wallet
  // (their checkout customer); the API key always identifies the actor.
  router.post("/privacy/consent", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const subjectTypeRaw = requireString(body, "subjectType", {
        maxLength: 16,
      });
      if (!isConsentSubjectType(subjectTypeRaw)) {
        throw HttpError.badRequest(
          `Field "subjectType" must be one of: ${CONSENT_SUBJECT_TYPES.join(", ")}`,
        );
      }
      const subjectType: ConsentSubjectType = subjectTypeRaw;
      const subjectId = requireString(body, "subjectId", { maxLength: 128 });
      const purpose = requireString(body, "purpose", { maxLength: 64 });
      const granted = requireBoolean(body, "granted");
      const source = optionalString(body, "source", { maxLength: 64 });
      const metadata = optionalRecord(body, "metadata");

      // A merchant cannot record consent against another merchant's id —
      // self-reported merchant consents must be the caller's own id.
      if (subjectType === "merchant" && subjectId !== merchant.id) {
        throw new HttpError(
          403,
          "unauthorized",
          "Merchant API key cannot record consent for a different merchant",
        );
      }

      const record = recordConsentDecision(db, {
        subjectType,
        subjectId,
        purpose,
        granted,
        source,
        metadata,
        actor: `merchant:${merchant.id}`,
      });
      res.status(201).json({ record });
    } catch (err) {
      next(err);
    }
  });

  // Returns latest decision per purpose. Older rows remain queryable through
  // the audit_journal proof trail; this endpoint is the operational view.
  router.get("/privacy/consent", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const rawSubjectType = req.query.subjectType;
      const rawSubjectId = req.query.subjectId;
      const subjectType: ConsentSubjectType =
        typeof rawSubjectType === "string" && isConsentSubjectType(rawSubjectType)
          ? rawSubjectType
          : "merchant";
      const subjectId =
        typeof rawSubjectId === "string" && rawSubjectId.length > 0
          ? rawSubjectId
          : merchant.id;
      if (subjectType === "merchant" && subjectId !== merchant.id) {
        throw new HttpError(
          403,
          "unauthorized",
          "Merchant API key cannot read consent for a different merchant",
        );
      }
      const records = getCurrentConsents(db, subjectType, subjectId);
      res.json({ records });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
