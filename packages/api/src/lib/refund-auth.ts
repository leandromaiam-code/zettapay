import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";

/**
 * Z13.5 — refund flow authorization. Refunding a settled payment is a
 * sensitive, hard-to-revert action: in V1 it triggers an on-chain reversal
 * of an already-confirmed USDC transfer back to the original payer. We
 * therefore require the merchant to sign a fresh, single-use intent with the
 * private key that owns their on-chain wallet — the same key that received
 * the funds. API-key auth alone is not enough: a leaked API key would
 * otherwise drain the merchant's wallet through manufactured refunds.
 *
 * The signed message embeds the payment id, the refund amount, the reason,
 * and an issuedAt timestamp, all of which are rebuilt server-side from
 * trusted state. Tampering with any field after signing breaks verification.
 * The TTL window (default ±5 min) bounds the blast radius of a leaked sig.
 */
export const REFUND_SCHEMA_VERSION = "ZETTAPAY-REFUND-V1";

export const DEFAULT_REFUND_INTENT_TTL_MS = 5 * 60 * 1000;

export const REFUND_REASON_MAX_LENGTH = 500;

const ED25519_PUBKEY_LENGTH = 32;
const ED25519_SIG_LENGTH = 64;
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type RefundAuthErrorCode =
  | "invalid_public_key"
  | "invalid_signature"
  | "wallet_mismatch"
  | "issued_at_invalid"
  | "issued_at_expired"
  | "reason_too_long";

export class RefundAuthError extends Error {
  constructor(
    public readonly code: RefundAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RefundAuthError";
  }
}

export interface RefundIntent {
  paymentId: string;
  merchantWallet: string;
  amount: number;
  currency: string;
  reason: string;
  /** ISO-8601 timestamp the merchant wallet stamped into the message before
   * signing. Verified against `now ± ttlMs` so a captured signature cannot
   * be replayed days later. */
  issuedAt: string;
}

export function buildRefundIntentMessage(intent: RefundIntent): Buffer {
  if (intent.reason.length > REFUND_REASON_MAX_LENGTH) {
    throw new RefundAuthError(
      "reason_too_long",
      `reason exceeds ${REFUND_REASON_MAX_LENGTH} chars`,
    );
  }
  // Canonical, line-oriented format. amount is normalized to a fixed-precision
  // string so 10 and 10.0 produce identical bytes; reason is JSON-encoded so
  // newlines or '=' inside the human text never break the parser.
  const lines = [
    REFUND_SCHEMA_VERSION,
    `paymentId=${intent.paymentId}`,
    `merchantWallet=${intent.merchantWallet}`,
    `amount=${normalizeAmount(intent.amount)}`,
    `currency=${intent.currency}`,
    `reason=${JSON.stringify(intent.reason)}`,
    `issuedAt=${intent.issuedAt}`,
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function normalizeAmount(value: number): string {
  // Six decimals matches USDC atomic precision — finer differences are not
  // representable on-chain anyway.
  return value.toFixed(6);
}

function decodeEd25519Pubkey(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new RefundAuthError(
      "invalid_public_key",
      "publicKey must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_PUBKEY_LENGTH) {
    throw new RefundAuthError(
      "invalid_public_key",
      `publicKey must decode to ${ED25519_PUBKEY_LENGTH} bytes`,
    );
  }
  return raw;
}

function decodeEd25519Signature(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new RefundAuthError(
      "invalid_signature",
      "signature must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_SIG_LENGTH) {
    throw new RefundAuthError(
      "invalid_signature",
      `signature must decode to ${ED25519_SIG_LENGTH} bytes`,
    );
  }
  return raw;
}

function ed25519Verify(
  pubKey: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  try {
    const der = Buffer.concat([ED25519_DER_PREFIX, pubKey]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

export interface VerifyRefundIntentInput {
  intent: RefundIntent;
  publicKey: string;
  signature: string;
  /** Server clock at the moment of verification — passed in so tests pin a
   * deterministic time and production callers use `Date.now()`. */
  now?: number;
  ttlMs?: number;
}

/**
 * Verify a merchant's signed refund authorization. The publicKey must equal
 * the merchant's on-chain wallet (binds the API request to the wallet that
 * actually received the funds); the signature must validate against the
 * canonical message rebuilt from server-trusted intent fields; and issuedAt
 * must be within `ttlMs` of `now`.
 */
export function verifyRefundIntent(input: VerifyRefundIntentInput): void {
  if (input.publicKey !== input.intent.merchantWallet) {
    throw new RefundAuthError(
      "wallet_mismatch",
      "publicKey does not match merchant wallet",
    );
  }
  const issuedAtMs = Date.parse(input.intent.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new RefundAuthError(
      "issued_at_invalid",
      "issuedAt must be a valid ISO-8601 timestamp",
    );
  }
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_REFUND_INTENT_TTL_MS;
  if (Math.abs(now - issuedAtMs) > ttl) {
    throw new RefundAuthError(
      "issued_at_expired",
      "issuedAt is outside the accepted replay window",
    );
  }
  const pubKey = decodeEd25519Pubkey(input.publicKey);
  const sig = decodeEd25519Signature(input.signature);
  const message = buildRefundIntentMessage(input.intent);
  if (!ed25519Verify(pubKey, message, sig)) {
    throw new RefundAuthError(
      "invalid_signature",
      "refund signature did not verify against the intent",
    );
  }
}
