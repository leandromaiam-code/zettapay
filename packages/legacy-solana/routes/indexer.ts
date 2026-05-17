import { Router, type RequestHandler } from "express";
import type { Database as Db } from "better-sqlite3";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  countOnChainPayments,
  findOnChainPaymentByPda,
  findOnChainPaymentBySignature,
  listOnChainPayments,
  type OnChainPaymentRecord,
} from "../db/onchain_payments.js";
import { HttpError } from "../lib/errors.js";
import type { OnChainPaymentIndexer, IngestStats } from "../services/onchain_indexer.js";

const AUTH_HEADER = "x-indexer-auth";
const MIN_KEY_LENGTH = 24;

/**
 * Z9.5 — Helius/Geyser webhook surface + read API for the on-chain payment
 * mirror.
 *
 * Three surfaces:
 *   - POST /indexer/onchain/payments/webhook : push ingestion. Auth: shared
 *     secret in `x-indexer-auth`. Body accepts the canonical generic shape
 *     `{ events: [{ pda, data?, slot? }] }` and the Helius "account webhook"
 *     shape `[ { accountData: [{ account }], slot } ]` — for the Helius shape
 *     we re-fetch the account via RPC since their webhook payload omits the
 *     bytes themselves.
 *   - POST /indexer/onchain/payments/backfill : pulls every Payment account
 *     for the program (or one merchant binding) via getProgramAccounts and
 *     upserts into the mirror. Same shared-secret auth.
 *   - GET  /indexer/onchain/payments         : public read of the mirror.
 *     The data is on-chain public; merchant scoping is via querystring
 *     `merchantBinding`, not via API key.
 */
export interface IndexerRouterOptions {
  /** Shared webhook secret. When undefined, blank, or shorter than 24 chars,
   *  the webhook + backfill routes refuse every call with config_error. The
   *  read route remains accessible (the mirror itself is public-by-design). */
  webhookAuthKey: string | null | undefined;
  /** Indexer instance. When omitted the webhook + backfill routes return 503,
   *  letting the read API stay live in environments without an RPC connection
   *  (e.g. tests that only seed the mirror directly). */
  indexer?: OnChainPaymentIndexer;
}

const RawEventSchema = z.object({
  pda: z.string().min(32).max(64),
  data: z.string().min(1).optional(),
  slot: z.number().int().nonnegative().optional(),
});

const GenericPayloadSchema = z.object({
  events: z.array(RawEventSchema).min(1).max(200),
});

const HeliusEnvelopeSchema = z
  .array(
    z.object({
      slot: z.number().int().nonnegative().optional(),
      accountData: z
        .array(z.object({ account: z.string().min(32).max(64) }))
        .optional(),
    }),
  )
  .min(1)
  .max(200);

const BackfillBodySchema = z
  .object({
    merchantBinding: z.string().min(32).max(64).optional(),
  })
  .optional();

export function indexerRouter(
  db: Db,
  options: IndexerRouterOptions,
): Router {
  const router = Router();
  const auth = makeAuthMiddleware(options.webhookAuthKey);

  router.post(
    "/indexer/onchain/payments/webhook",
    auth,
    async (req, res, next) => {
      try {
        const indexer = options.indexer;
        if (!indexer) {
          throw HttpError.config(
            "indexer_disabled — OnChainPaymentIndexer is not wired into this process",
          );
        }
        const body = req.body as unknown;
        const generic = GenericPayloadSchema.safeParse(body);
        let stats: IngestStats;
        if (generic.success) {
          const events = generic.data.events;
          const withData = events.filter(
            (e): e is { pda: string; data: string; slot?: number } =>
              typeof e.data === "string" && e.data.length > 0,
          );
          stats = indexer.ingestRawAccounts(withData);
          // Events without inline data go through ingestByPda (RPC fetch).
          for (const event of events) {
            if (typeof event.data === "string" && event.data.length > 0) continue;
            try {
              const result = await indexer.ingestByPda(event.pda);
              if (result) {
                stats.ingested += 1;
                if (result.inserted) stats.inserted += 1;
              } else {
                stats.skipped += 1;
              }
            } catch (err) {
              stats.errors.push({
                pda: event.pda,
                reason: (err as Error).message,
              });
            }
          }
        } else {
          const helius = HeliusEnvelopeSchema.safeParse(body);
          if (!helius.success) {
            throw HttpError.badRequest(
              "Unsupported webhook payload shape — expected { events: [...] } or Helius account webhook envelope",
              { generic: generic.error.issues, helius: helius.error.issues },
            );
          }
          stats = { ingested: 0, inserted: 0, skipped: 0, errors: [] };
          for (const tx of helius.data) {
            for (const account of tx.accountData ?? []) {
              try {
                const result = await indexer.ingestByPda(account.account);
                if (result) {
                  stats.ingested += 1;
                  if (result.inserted) stats.inserted += 1;
                } else {
                  stats.skipped += 1;
                }
              } catch (err) {
                stats.errors.push({
                  pda: account.account,
                  reason: (err as Error).message,
                });
              }
            }
          }
        }
        res.json(stats);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/indexer/onchain/payments/backfill",
    auth,
    async (req, res, next) => {
      try {
        const indexer = options.indexer;
        if (!indexer) {
          throw HttpError.config(
            "indexer_disabled — OnChainPaymentIndexer is not wired into this process",
          );
        }
        const parsed = BackfillBodySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw HttpError.badRequest("Invalid backfill body", parsed.error.issues);
        }
        const stats = await indexer.backfill(parsed.data ?? {});
        res.json(stats);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/indexer/onchain/payments", (req, res, next) => {
    try {
      const merchantBinding = optionalString(req.query.merchantBinding);
      const txSignature = optionalString(req.query.txSignature);
      if (txSignature) {
        const row = findOnChainPaymentBySignature(db, txSignature);
        if (!row) {
          throw HttpError.notFound("on-chain payment not found");
        }
        res.json({ payments: [serializeRecord(row)], cursor: null });
        return;
      }
      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const rows = listOnChainPayments(db, {
        ...(merchantBinding ? { merchantBinding } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const payments = rows.map(serializeRecord);
      const nextCursor =
        rows.length === (limit ?? 50) ? rows[rows.length - 1]!.recordedAt : null;
      const total = countOnChainPayments(db, {
        ...(merchantBinding ? { merchantBinding } : {}),
      });
      res.json({ payments, cursor: nextCursor, total });
    } catch (err) {
      next(err);
    }
  });

  router.get("/indexer/onchain/payments/:pda", (req, res, next) => {
    try {
      const pda = String(req.params.pda ?? "").trim();
      if (pda.length === 0 || pda.length > 64) {
        throw HttpError.badRequest("path param 'pda' must be 1-64 chars");
      }
      const row = findOnChainPaymentByPda(db, pda);
      if (!row) {
        throw HttpError.notFound(`on-chain payment ${pda} not found`);
      }
      res.json({ payment: serializeRecord(row) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function makeAuthMiddleware(rawKey: string | null | undefined): RequestHandler {
  const expected = (rawKey ?? "").trim();
  if (expected.length < MIN_KEY_LENGTH) {
    return (_req, _res, next) => {
      next(
        HttpError.config(
          "ZETTAPAY_INDEXER_WEBHOOK_KEY is not configured (min 24 chars)",
        ),
      );
    };
  }
  return (req, _res, next) => {
    const presented = extractCredential(req);
    if (!presented || !safeEquals(presented, expected)) {
      next(HttpError.unauthorized("indexer webhook auth invalid or missing"));
      return;
    }
    next();
  };
}

function extractCredential(req: import("express").Request): string | null {
  const headerKey = req.header(AUTH_HEADER);
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.length > 0) return token;
  }
  return null;
}

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function serializeRecord(record: OnChainPaymentRecord): {
  pda: string;
  merchantBinding: string;
  paymentIdHex: string;
  amount: string;
  txSignature: string;
  recordedAt: number;
  slot: number | null;
  ingestedAt: string;
} {
  return {
    pda: record.pda,
    merchantBinding: record.merchantBinding,
    paymentIdHex: record.paymentIdHex,
    amount: record.amount.toString(),
    txSignature: record.txSignature,
    recordedAt: record.recordedAt,
    slot: record.slot,
    ingestedAt: record.ingestedAt,
  };
}

function optionalString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function parseCursor(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
