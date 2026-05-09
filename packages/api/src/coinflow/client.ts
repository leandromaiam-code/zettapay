export type CoinflowEnvironment = "sandbox" | "production";

export interface CoinflowWithdrawalRequest {
  /** Coinflow merchant ID (issued during merchant onboarding on Coinflow). */
  coinflowMerchantId: string;
  /** Bank account ID registered with Coinflow for this merchant. */
  bankAccountId: string;
  /** Net USDC to settle (after ZettaPay fee deduction). */
  netUsdc: number;
  /** Idempotency key — Coinflow dedupes withdrawal requests by this token. */
  idempotencyKey: string;
  /** Free-form metadata (echoed back on Coinflow's webhook). */
  metadata?: Record<string, unknown>;
}

export interface CoinflowWithdrawalResponse {
  withdrawalId: string;
  status: "pending" | "processing" | "completed" | "failed";
  expectedSettlementAt?: string | null;
}

export interface CoinflowClient {
  createWithdrawal(
    req: CoinflowWithdrawalRequest,
  ): Promise<CoinflowWithdrawalResponse>;
}

export interface CoinflowConfig {
  apiKey: string;
  environment: CoinflowEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URLS: Record<CoinflowEnvironment, string> = {
  sandbox: "https://api-sandbox.coinflow.cash",
  production: "https://api.coinflow.cash",
};

const DEFAULT_TIMEOUT_MS = 15_000;

export class CoinflowApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody: string) {
    super(message);
    this.name = "CoinflowApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Thin HTTPS wrapper around Coinflow's withdraw API. The merchant retains
 * USDC custody — we only request that Coinflow initiate a settlement on the
 * merchant's behalf using credentials they previously authorized.
 */
export class HttpCoinflowClient implements CoinflowClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CoinflowConfig) {
    if (!config.apiKey) {
      throw new Error("CoinflowConfig.apiKey is required");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? DEFAULT_BASE_URLS[config.environment]
    ).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createWithdrawal(
    req: CoinflowWithdrawalRequest,
  ): Promise<CoinflowWithdrawalResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/withdraw`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "x-coinflow-merchant-id": req.coinflowMerchantId,
          "idempotency-key": req.idempotencyKey,
        },
        body: JSON.stringify({
          bankAccountId: req.bankAccountId,
          amountUsdc: req.netUsdc,
          metadata: req.metadata ?? {},
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new CoinflowApiError(
          res.status,
          `coinflow withdraw failed (HTTP ${res.status})`,
          text,
        );
      }

      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const withdrawalId =
        typeof body.withdrawalId === "string"
          ? body.withdrawalId
          : typeof body.id === "string"
            ? body.id
            : null;
      if (!withdrawalId) {
        throw new CoinflowApiError(
          res.status,
          "coinflow withdraw response missing withdrawalId",
          text,
        );
      }
      const status = typeof body.status === "string" ? body.status : "pending";
      return {
        withdrawalId,
        status: normalizeStatus(status),
        expectedSettlementAt:
          typeof body.expectedSettlementAt === "string"
            ? body.expectedSettlementAt
            : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeStatus(raw: string): CoinflowWithdrawalResponse["status"] {
  const lower = raw.toLowerCase();
  if (lower === "completed" || lower === "settled" || lower === "succeeded") {
    return "completed";
  }
  if (lower === "failed" || lower === "rejected" || lower === "cancelled") {
    return "failed";
  }
  if (lower === "processing" || lower === "in_progress") {
    return "processing";
  }
  return "pending";
}
