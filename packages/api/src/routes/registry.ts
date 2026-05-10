import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantByApiKey } from "../db/merchants.js";
import {
  deleteRegistryTool,
  findRegistryToolById,
  findRegistryToolBySlug,
  insertRegistryTool,
  listRegistryTools,
  updateRegistryTool,
  type RegistryToolStatus,
} from "../db/registry_tools.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { idempotency } from "../middleware/idempotency.js";
import {
  optionalRecord,
  optionalString,
  requireString,
} from "../lib/validate.js";

const API_KEY_HEADER = "x-zettapay-api-key";
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;
const ALLOWED_STATUS: ReadonlySet<RegistryToolStatus> = new Set([
  "draft",
  "published",
  "suspended",
]);
const PUBLIC_LIST_LIMIT = 50;
const PUBLIC_LIST_LIMIT_MAX = 200;

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

function parseHttpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw HttpError.badRequest(`Field "${field}" must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw HttpError.badRequest(`Field "${field}" must use https://`);
  }
  return parsed.toString();
}

function parseStringTags(body: Record<string, unknown>): string[] {
  const raw = body.tags;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw HttpError.badRequest('Field "tags" must be an array of strings');
  }
  const tags: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw HttpError.badRequest('Field "tags" must contain non-empty strings');
    }
    if (v.length > 32) {
      throw HttpError.badRequest('Each tag must be ≤32 characters');
    }
    tags.push(v.trim().toLowerCase());
  }
  if (tags.length > 10) {
    throw HttpError.badRequest('Field "tags" allows up to 10 entries');
  }
  return Array.from(new Set(tags));
}

function parsePriceUsdc(body: Record<string, unknown>): number {
  const raw = body.priceUsdc;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw HttpError.badRequest(
      'Field "priceUsdc" must be a non-negative number',
    );
  }
  if (raw > 10_000) {
    throw HttpError.badRequest('Field "priceUsdc" must be ≤ 10000');
  }
  // 6-decimal precision matches USDC mint atomic units.
  return Math.round(raw * 1_000_000) / 1_000_000;
}

function parseStatus(value: string | null): RegistryToolStatus {
  if (value === null) return "draft";
  if (!ALLOWED_STATUS.has(value as RegistryToolStatus)) {
    throw HttpError.badRequest(
      'Field "status" must be one of: draft, published, suspended',
    );
  }
  return value as RegistryToolStatus;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, parsed);
}

function parseOffset(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseMaxPrice(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function registryRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/registry/tools",
    idempotency(db, { scope: "POST /registry/tools" }),
    (req, res, next) => {
      try {
        const merchant = authMerchant(db, req.header(API_KEY_HEADER));
        const body = (req.body ?? {}) as Record<string, unknown>;

        const slug = requireString(body, "slug", { maxLength: 64 });
        if (!SLUG_PATTERN.test(slug)) {
          throw HttpError.badRequest(
            'Field "slug" must match [a-z][a-z0-9-]{1,62}[a-z0-9] — lowercase, hyphens, no leading/trailing hyphen',
          );
        }
        if (findRegistryToolBySlug(db, slug)) {
          throw HttpError.conflict(`Tool with slug "${slug}" already exists`);
        }

        const name = requireString(body, "name", { maxLength: 120 });
        const description = requireString(body, "description", {
          maxLength: 1000,
        });
        const category = requireString(body, "category", { maxLength: 64 });
        const endpointUrlRaw = requireString(body, "endpointUrl", {
          maxLength: 512,
        });
        const endpointUrl = parseHttpsUrl(endpointUrlRaw, "endpointUrl");

        const priceUsdc = parsePriceUsdc(body);
        const currency = (
          optionalString(body, "currency", { maxLength: 16 }) ?? "USDC"
        ).toUpperCase();

        const inputSchemaRaw = optionalRecord(body, "inputSchema");
        const inputSchema: Record<string, unknown> = inputSchemaRaw ?? {
          type: "object",
          properties: {},
          additionalProperties: true,
        };

        const homepageUrlRaw = optionalString(body, "homepageUrl", {
          maxLength: 512,
        });
        const docsUrlRaw = optionalString(body, "docsUrl", { maxLength: 512 });
        const iconUrlRaw = optionalString(body, "iconUrl", { maxLength: 512 });

        const tool = insertRegistryTool(db, {
          id: newId("mcp"),
          merchantId: merchant.id,
          slug,
          name,
          description,
          category: category.toLowerCase(),
          endpointUrl,
          priceUsdc,
          currency,
          inputSchema,
          tags: parseStringTags(body),
          homepageUrl: homepageUrlRaw
            ? parseHttpsUrl(homepageUrlRaw, "homepageUrl")
            : null,
          docsUrl: docsUrlRaw ? parseHttpsUrl(docsUrlRaw, "docsUrl") : null,
          iconUrl: iconUrlRaw ? parseHttpsUrl(iconUrlRaw, "iconUrl") : null,
          status: parseStatus(
            optionalString(body, "status", { maxLength: 16 }),
          ),
        });
        res.status(201).json({ tool });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/registry/tools", (req, res, next) => {
    try {
      const tools = listRegistryTools(db, {
        status: "published",
        ...(typeof req.query.category === "string"
          ? { category: req.query.category.toLowerCase() }
          : {}),
        ...(typeof req.query.q === "string" ? { query: req.query.q } : {}),
        ...(parseMaxPrice(req.query.maxPriceUsdc) !== undefined
          ? { maxPriceUsdc: parseMaxPrice(req.query.maxPriceUsdc) as number }
          : {}),
        limit: parseLimit(
          req.query.limit,
          PUBLIC_LIST_LIMIT,
          PUBLIC_LIST_LIMIT_MAX,
        ),
        offset: parseOffset(req.query.offset),
      });
      res.json({ tools, count: tools.length });
    } catch (err) {
      next(err);
    }
  });

  router.get("/registry/tools/mine", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const tools = listRegistryTools(db, {
        merchantId: merchant.id,
        limit: parseLimit(req.query.limit, 100, PUBLIC_LIST_LIMIT_MAX),
        offset: parseOffset(req.query.offset),
      });
      res.json({ tools, count: tools.length });
    } catch (err) {
      next(err);
    }
  });

  router.get("/registry/tools/:slug", (req, res, next) => {
    try {
      const slug = req.params.slug;
      const tool = findRegistryToolBySlug(db, slug);
      if (!tool || tool.status !== "published") {
        throw HttpError.notFound(`Tool "${slug}" not found`);
      }
      res.json({ tool });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/registry/tools/:slug", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const existing = findRegistryToolBySlug(db, req.params.slug);
      if (!existing || existing.merchantId !== merchant.id) {
        throw HttpError.notFound(`Tool "${req.params.slug}" not found`);
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof updateRegistryTool>[2] = {};

      if (body.name !== undefined) {
        patch.name = requireString(body, "name", { maxLength: 120 });
      }
      if (body.description !== undefined) {
        patch.description = requireString(body, "description", {
          maxLength: 1000,
        });
      }
      if (body.category !== undefined) {
        patch.category = requireString(body, "category", {
          maxLength: 64,
        }).toLowerCase();
      }
      if (body.endpointUrl !== undefined) {
        const raw = requireString(body, "endpointUrl", { maxLength: 512 });
        patch.endpointUrl = parseHttpsUrl(raw, "endpointUrl");
      }
      if (body.priceUsdc !== undefined) {
        patch.priceUsdc = parsePriceUsdc(body);
      }
      if (body.currency !== undefined) {
        patch.currency = requireString(body, "currency", {
          maxLength: 16,
        }).toUpperCase();
      }
      if (body.inputSchema !== undefined) {
        const rec = optionalRecord(body, "inputSchema");
        if (!rec) {
          throw HttpError.badRequest(
            'Field "inputSchema" must be a JSON object',
          );
        }
        patch.inputSchema = rec;
      }
      if (body.tags !== undefined) {
        patch.tags = parseStringTags(body);
      }
      if (body.homepageUrl !== undefined) {
        const raw = optionalString(body, "homepageUrl", { maxLength: 512 });
        patch.homepageUrl = raw ? parseHttpsUrl(raw, "homepageUrl") : null;
      }
      if (body.docsUrl !== undefined) {
        const raw = optionalString(body, "docsUrl", { maxLength: 512 });
        patch.docsUrl = raw ? parseHttpsUrl(raw, "docsUrl") : null;
      }
      if (body.iconUrl !== undefined) {
        const raw = optionalString(body, "iconUrl", { maxLength: 512 });
        patch.iconUrl = raw ? parseHttpsUrl(raw, "iconUrl") : null;
      }
      if (body.status !== undefined) {
        patch.status = parseStatus(
          optionalString(body, "status", { maxLength: 16 }),
        );
      }

      const tool = updateRegistryTool(db, existing.id, patch);
      res.json({ tool });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/registry/tools/:slug", (req, res, next) => {
    try {
      const merchant = authMerchant(db, req.header(API_KEY_HEADER));
      const existing = findRegistryToolBySlug(db, req.params.slug);
      if (!existing || existing.merchantId !== merchant.id) {
        throw HttpError.notFound(`Tool "${req.params.slug}" not found`);
      }
      deleteRegistryTool(db, existing.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export { findRegistryToolById };
