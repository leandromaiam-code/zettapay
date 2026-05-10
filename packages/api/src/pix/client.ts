export type PixProvider = "bitpreco" | "transfero";
export type PixEnvironment = "sandbox" | "production";
export type PixKeyType = "cpf" | "cnpj" | "email" | "phone" | "random";

export const PIX_PROVIDERS: readonly PixProvider[] = ["bitpreco", "transfero"];
export const PIX_KEY_TYPES: readonly PixKeyType[] = [
  "cpf",
  "cnpj",
  "email",
  "phone",
  "random",
];

export interface PixWithdrawalRequest {
  /** Net USDC to settle (after ZettaPay fee deduction). Provider quotes BRL. */
  netUsdc: number;
  /** Beneficiary Pix key (CPF/CNPJ/email/phone/random UUID). */
  pixKey: string;
  /** Pix key type — required by every Brazilian payout API. */
  pixKeyType: PixKeyType;
  /** Idempotency key — provider dedupes payouts by this token. */
  idempotencyKey: string;
  /** Optional provider-side merchant ID (some providers gate payouts on this). */
  providerMerchantId?: string | null;
  /** Free-form metadata echoed back on the provider's webhook. */
  metadata?: Record<string, unknown>;
}

export interface PixWithdrawalResponse {
  withdrawalId: string;
  status: "pending" | "processing" | "completed" | "failed";
  provider: PixProvider;
  /** BRL amount quoted by the provider at settlement time (informational). */
  quotedBrl: number | null;
  expectedSettlementAt: string | null;
}

export interface PixClient {
  readonly provider: PixProvider;
  createWithdrawal(req: PixWithdrawalRequest): Promise<PixWithdrawalResponse>;
}

export interface PixConfig {
  apiKey: string;
  environment: PixEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const BITPRECO_BASE_URLS: Record<PixEnvironment, string> = {
  sandbox: "https://api-sandbox.bitpreco.com",
  production: "https://api.bitpreco.com",
};

const TRANSFERO_BASE_URLS: Record<PixEnvironment, string> = {
  sandbox: "https://api-sandbox.transfero.com",
  production: "https://api.transfero.com",
};

export class PixApiError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly provider: PixProvider;

  constructor(
    provider: PixProvider,
    status: number,
    message: string,
    responseBody: string,
  ) {
    super(message);
    this.name = "PixApiError";
    this.provider = provider;
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Bitpreço Pix payout adapter. Bitpreço is a Brazilian crypto exchange that
 * exposes an over-the-counter API to convert USDC into BRL and dispatch Pix
 * transfers to the merchant's registered Pix key. ZettaPay never custodies BRL
 * — we only request a payout on the merchant's behalf using credentials they
 * previously authorized on Bitpreço's dashboard.
 */
export class HttpBitprecoClient implements PixClient {
  readonly provider: PixProvider = "bitpreco";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PixConfig) {
    if (!config.apiKey) throw new Error("PixConfig.apiKey is required");
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? BITPRECO_BASE_URLS[config.environment]
    ).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createWithdrawal(
    req: PixWithdrawalRequest,
  ): Promise<PixWithdrawalResponse> {
    return performHttpRequest({
      provider: this.provider,
      url: `${this.baseUrl}/v1/payouts/pix`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "idempotency-key": req.idempotencyKey,
      },
      body: {
        amountUsdc: req.netUsdc,
        pixKey: req.pixKey,
        pixKeyType: req.pixKeyType,
        merchantId: req.providerMerchantId ?? undefined,
        metadata: req.metadata ?? {},
      },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

/**
 * Transfero Pix payout adapter. Transfero is a Brazilian fintech offering a
 * stablecoin-to-fiat off-ramp with explicit USDC → BRL Pix support. The shape
 * differs from Bitpreço (separate source/destination amounts and an x-api-key
 * header) but the abstraction surface is identical.
 */
export class HttpTransferoClient implements PixClient {
  readonly provider: PixProvider = "transfero";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PixConfig) {
    if (!config.apiKey) throw new Error("PixConfig.apiKey is required");
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? TRANSFERO_BASE_URLS[config.environment]
    ).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async createWithdrawal(
    req: PixWithdrawalRequest,
  ): Promise<PixWithdrawalResponse> {
    return performHttpRequest({
      provider: this.provider,
      url: `${this.baseUrl}/v1/withdraw/pix`,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": this.apiKey,
        "x-idempotency-key": req.idempotencyKey,
      },
      body: {
        sourceAmount: req.netUsdc,
        sourceCurrency: "USDC",
        destinationCurrency: "BRL",
        pixKey: req.pixKey,
        pixKeyType: req.pixKeyType.toUpperCase(),
        merchantId: req.providerMerchantId ?? undefined,
        metadata: req.metadata ?? {},
      },
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

export function createPixClient(
  provider: PixProvider,
  config: PixConfig,
): PixClient {
  switch (provider) {
    case "bitpreco":
      return new HttpBitprecoClient(config);
    case "transfero":
      return new HttpTransferoClient(config);
  }
}

interface HttpRequestSpec {
  provider: PixProvider;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

async function performHttpRequest(
  spec: HttpRequestSpec,
): Promise<PixWithdrawalResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    const res = await spec.fetchImpl(spec.url, {
      method: "POST",
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new PixApiError(
        spec.provider,
        res.status,
        `${spec.provider} payout failed (HTTP ${res.status})`,
        text,
      );
    }
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const withdrawalId = pickString(body, ["withdrawalId", "payoutId", "id"]);
    if (!withdrawalId) {
      throw new PixApiError(
        spec.provider,
        res.status,
        `${spec.provider} response missing withdrawalId`,
        text,
      );
    }
    const rawStatus = typeof body.status === "string" ? body.status : "pending";
    const quotedBrl = pickNumber(body, [
      "amountBrl",
      "brlAmount",
      "destinationAmount",
    ]);
    const expectedSettlementAt =
      typeof body.expectedSettlementAt === "string"
        ? body.expectedSettlementAt
        : null;
    return {
      withdrawalId,
      status: normalizeStatus(rawStatus),
      provider: spec.provider,
      quotedBrl,
      expectedSettlementAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pickString(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickNumber(
  body: Record<string, unknown>,
  fields: readonly string[],
): number | null {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeStatus(raw: string): PixWithdrawalResponse["status"] {
  const lower = raw.toLowerCase();
  if (
    lower === "completed" ||
    lower === "settled" ||
    lower === "succeeded" ||
    lower === "paid"
  ) {
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

export function isPixProvider(value: unknown): value is PixProvider {
  return (
    typeof value === "string" &&
    (PIX_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isPixKeyType(value: unknown): value is PixKeyType {
  return (
    typeof value === "string" &&
    (PIX_KEY_TYPES as readonly string[]).includes(value)
  );
}
