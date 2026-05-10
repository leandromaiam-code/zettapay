import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../lib/errors.js";
import type {
  AccessTokenInput,
  AccessTokenResult,
  CreateApplicantInput,
  CreateApplicantResult,
  KycProviderClient,
  WebhookVerifyResult,
} from "./provider.js";

const SUMSUB_DEFAULT_HOST = "https://api.sumsub.com";
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Sumsub signs every webhook body with HMAC-SHA{1,256,384,512} keyed by the
 * webhook secret. The digest is sent in `x-payload-digest`, the algo in
 * `x-payload-digest-alg` (HMAC_SHA256_HEX is canon — older HMAC_SHA1_HEX is
 * still seen on legacy tenants).
 *
 * Reference: https://docs.sumsub.com/reference/about-webhooks
 */
const SUMSUB_DIGEST_HEADER = "x-payload-digest";
const SUMSUB_DIGEST_ALG_HEADER = "x-payload-digest-alg";

const ALG_TO_NODE: Record<string, string> = {
  HMAC_SHA1_HEX: "sha1",
  HMAC_SHA256_HEX: "sha256",
  HMAC_SHA384_HEX: "sha384",
  HMAC_SHA512_HEX: "sha512",
};

export interface SumsubConfig {
  appToken: string;
  secretKey: string;
  /** Webhook secret — separate from API secret on Sumsub. */
  webhookSecret: string;
  baseUrl?: string;
  /** Test seam — replaces global fetch in unit tests. */
  fetchImpl?: typeof fetch;
}

export function createSumsubClient(config: SumsubConfig): KycProviderClient {
  const baseUrl = (config.baseUrl ?? SUMSUB_DEFAULT_HOST).replace(/\/+$/, "");
  const httpFetch = config.fetchImpl ?? fetch;

  return {
    name: "sumsub",

    async createApplicant(input: CreateApplicantInput): Promise<CreateApplicantResult> {
      const path = `/resources/applicants?levelName=${encodeURIComponent(input.levelName)}`;
      const body = JSON.stringify({
        externalUserId: input.externalUserId,
        ...(input.email ? { email: input.email } : {}),
      });
      const res = await sumsubRequest(httpFetch, baseUrl, config, "POST", path, body);
      const json = (await res.json()) as { id?: string };
      if (!json.id) {
        throw HttpError.upstream("Sumsub createApplicant returned no id", json);
      }
      return { applicantId: json.id };
    },

    async issueAccessToken(input: AccessTokenInput): Promise<AccessTokenResult> {
      const ttl = input.ttlSeconds ?? 600;
      const path =
        `/resources/accessTokens?userId=${encodeURIComponent(input.externalUserId)}` +
        `&levelName=${encodeURIComponent(input.levelName)}` +
        `&ttlInSecs=${ttl}`;
      const res = await sumsubRequest(httpFetch, baseUrl, config, "POST", path, "");
      const json = (await res.json()) as { token?: string; userId?: string };
      if (!json.token || !json.userId) {
        throw HttpError.upstream("Sumsub accessTokens response malformed", json);
      }
      return {
        token: json.token,
        userId: json.userId,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
    },

    verifyWebhook({ rawBody, headers }): WebhookVerifyResult {
      return verifySumsubWebhook({
        rawBody,
        headers,
        secret: config.webhookSecret,
      });
    },
  };
}

interface VerifySumsubWebhookInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
}

export function verifySumsubWebhook(
  input: VerifySumsubWebhookInput,
): WebhookVerifyResult {
  const provided = pickHeader(input.headers, SUMSUB_DIGEST_HEADER);
  if (!provided) {
    return { valid: false, reason: "missing_digest" };
  }
  if (!HEX_RE.test(provided)) {
    return { valid: false, reason: "malformed_digest" };
  }

  const algRaw = pickHeader(input.headers, SUMSUB_DIGEST_ALG_HEADER);
  const algKey = (algRaw ?? "HMAC_SHA256_HEX").toUpperCase();
  const nodeAlg = ALG_TO_NODE[algKey];
  if (!nodeAlg) {
    return { valid: false, reason: "unsupported_alg" };
  }

  const expected = createHmac(nodeAlg, input.secret)
    .update(input.rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided.toLowerCase(), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toUpperCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() ?? null;
  if (typeof raw === "string") return raw.trim();
  return null;
}

async function sumsubRequest(
  httpFetch: typeof fetch,
  baseUrl: string,
  config: SumsubConfig,
  method: string,
  path: string,
  body: string,
): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", config.secretKey)
    .update(ts + method + path + body)
    .digest("hex");

  const res = await httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-App-Token": config.appToken,
      "X-App-Access-Sig": signature,
      "X-App-Access-Ts": ts,
    },
    ...(body ? { body } : {}),
  });

  if (!res.ok) {
    const errBody = await safeReadText(res);
    throw HttpError.upstream(
      `Sumsub ${method} ${path} failed with ${res.status}`,
      { status: res.status, body: errBody },
    );
  }
  return res;
}

async function safeReadText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Maps a Sumsub `applicantReviewed` webhook payload to our internal status.
 * Sumsub sends `reviewResult.reviewAnswer` ∈ {GREEN, RED} on terminal events;
 * pending/in-review events come without a verdict.
 */
export interface SumsubReviewPayload {
  type?: string;
  applicantId?: string;
  externalUserId?: string;
  reviewStatus?: string;
  reviewResult?: {
    reviewAnswer?: string;
    reviewRejectType?: string;
    rejectLabels?: string[];
    moderationComment?: string;
  };
}

export interface MappedSumsubVerdict {
  status: "pending" | "in_review" | "approved" | "rejected" | "blocked";
  reviewAnswer: string | null;
  reviewReason: string | null;
}

export function mapSumsubReview(payload: SumsubReviewPayload): MappedSumsubVerdict {
  const type = payload.type ?? "";
  const answer = payload.reviewResult?.reviewAnswer ?? null;
  const rejectType = payload.reviewResult?.reviewRejectType ?? null;
  const reason =
    payload.reviewResult?.moderationComment ??
    (payload.reviewResult?.rejectLabels?.length
      ? payload.reviewResult.rejectLabels.join(",")
      : null);

  if (type === "applicantReviewed") {
    if (answer === "GREEN") {
      return { status: "approved", reviewAnswer: answer, reviewReason: reason };
    }
    if (answer === "RED") {
      // Sumsub uses FINAL for hard rejections, RETRY for fixable issues.
      const status = rejectType === "FINAL" ? "blocked" : "rejected";
      return { status, reviewAnswer: answer, reviewReason: reason };
    }
  }
  if (type === "applicantPending" || payload.reviewStatus === "pending") {
    return { status: "in_review", reviewAnswer: answer, reviewReason: reason };
  }
  if (type === "applicantOnHold") {
    return { status: "blocked", reviewAnswer: answer, reviewReason: reason };
  }
  return { status: "pending", reviewAnswer: answer, reviewReason: reason };
}
