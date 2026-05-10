import { HttpError } from "../lib/errors.js";

export type AttestationEnvironment = "sandbox" | "production";

/**
 * Status reported by Circle's iris attestation API. `pending_confirmations`
 * means the source-chain burn is waiting for finality + Guardian quorum;
 * `complete` means the message + signed attestation are ready for redemption
 * on the destination chain (Solana). `failed` is emitted on terminal errors.
 */
export type AttestationStatus =
  | "pending_confirmations"
  | "complete"
  | "failed";

export interface AttestationRecord {
  status: AttestationStatus;
  /** Hex-encoded Circle/Wormhole message body (input to receiveMessage). */
  message: string | null;
  /** Hex-encoded Guardian / Circle attestation signature bundle. */
  attestation: string | null;
  eventNonce: string | null;
}

export interface AttestationLookup {
  /** CCTP source domain — see chains.ts (Base=6, Polygon=7, ...). */
  sourceDomain: number;
  /** EVM source-chain transaction hash that emitted the burn message. */
  transactionHash: string;
}

export interface AttestationClient {
  fetchAttestation(lookup: AttestationLookup): Promise<AttestationRecord>;
}

export interface AttestationConfig {
  environment: AttestationEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URLS: Record<AttestationEnvironment, string> = {
  sandbox: "https://iris-api-sandbox.circle.com",
  production: "https://iris-api.circle.com",
};

const DEFAULT_TIMEOUT_MS = 15_000;

export class AttestationApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody: string) {
    super(message);
    this.name = "AttestationApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/**
 * Thin wrapper around Circle's iris API — the canonical attestation source
 * for native USDC routes (the same endpoint Wormhole Connect SDK polls when
 * routing USDC). We never custody funds here: the attestation is ultimately
 * redeemed by the recipient on Solana, we only surface its status.
 */
export class HttpAttestationClient implements AttestationClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AttestationConfig) {
    this.baseUrl = (
      config.baseUrl ?? DEFAULT_BASE_URLS[config.environment]
    ).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async fetchAttestation(
    lookup: AttestationLookup,
  ): Promise<AttestationRecord> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(lookup.transactionHash)) {
      throw HttpError.badRequest(
        `Invalid transactionHash "${lookup.transactionHash}" — expected 0x-prefixed 32-byte hex`,
      );
    }
    const url = `${this.baseUrl}/v1/messages/${lookup.sourceDomain}/${lookup.transactionHash}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AttestationApiError(
          504,
          `Circle attestation timed out after ${this.timeoutMs}ms`,
          "",
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const body = await response.text();
    if (response.status === 404) {
      // Source tx not yet observed — treat as pending so callers can keep polling.
      return {
        status: "pending_confirmations",
        message: null,
        attestation: null,
        eventNonce: null,
      };
    }
    if (!response.ok) {
      throw new AttestationApiError(
        response.status,
        `Circle attestation API responded ${response.status}`,
        body,
      );
    }
    const parsed = parseBody(body);
    return parsed;
  }
}

interface IrisResponseShape {
  messages?: Array<{
    message?: string | null;
    attestation?: string | null;
    eventNonce?: string | null;
    status?: string | null;
  }>;
}

function parseBody(raw: string): AttestationRecord {
  let parsed: IrisResponseShape;
  try {
    parsed = JSON.parse(raw) as IrisResponseShape;
  } catch {
    throw new AttestationApiError(
      502,
      "Circle attestation API returned non-JSON body",
      raw,
    );
  }
  const first = parsed.messages?.[0];
  if (!first) {
    return {
      status: "pending_confirmations",
      message: null,
      attestation: null,
      eventNonce: null,
    };
  }
  const status = normalizeStatus(first.status);
  const ready =
    status === "complete" &&
    typeof first.message === "string" &&
    first.message.length > 0 &&
    typeof first.attestation === "string" &&
    first.attestation.length > 0 &&
    !first.attestation.startsWith("PENDING");
  return {
    status: ready ? "complete" : status === "failed" ? "failed" : "pending_confirmations",
    message: ready ? (first.message ?? null) : null,
    attestation: ready ? (first.attestation ?? null) : null,
    eventNonce: first.eventNonce ?? null,
  };
}

function normalizeStatus(raw: string | null | undefined): AttestationStatus {
  if (!raw) return "pending_confirmations";
  const lower = raw.toLowerCase();
  if (lower === "complete") return "complete";
  if (lower === "failed" || lower === "error") return "failed";
  return "pending_confirmations";
}
