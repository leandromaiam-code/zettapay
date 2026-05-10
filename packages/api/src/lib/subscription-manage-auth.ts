import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";

/**
 * Z12.5 — customer-side subscription management. The customer signs a fresh,
 * timestamped intent message with their wallet to authorize cancel / pause /
 * resume. Unlike the permanent charge authorization (V1), each manage action
 * uses a single-use intent bound to a server-checked time window so a captured
 * cancel signature cannot be replayed days later. The customer wallet is the
 * sole authority — the merchant API key is not required, and merchants cannot
 * use this surface to act on behalf of a customer.
 */
export const SUBSCRIPTION_MANAGE_SCHEMA_VERSION =
  "ZETTAPAY-SUBSCRIPTION-MANAGE-V1";

export const SUBSCRIPTION_MANAGE_ACTIONS = ["cancel", "pause", "resume"] as const;
export type SubscriptionManageAction = (typeof SUBSCRIPTION_MANAGE_ACTIONS)[number];

/** Default replay window: a signed intent is honored within ±5 minutes of
 * server time. Long enough to absorb wall-clock skew and a slow user; short
 * enough that a leaked signature is not a durable cancel-anyone capability. */
export const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;

const ED25519_PUBKEY_LENGTH = 32;
const ED25519_SIG_LENGTH = 64;
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SubscriptionManageAuthErrorCode =
  | "invalid_action"
  | "invalid_public_key"
  | "invalid_signature"
  | "wallet_mismatch"
  | "issued_at_invalid"
  | "issued_at_expired";

export class SubscriptionManageAuthError extends Error {
  constructor(
    public readonly code: SubscriptionManageAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionManageAuthError";
  }
}

export interface SubscriptionManageIntent {
  action: SubscriptionManageAction;
  subscriptionId: string;
  customerWallet: string;
  /** ISO-8601 timestamp the customer (or the dashboard on their behalf) put
   * into the message before signing. The server validates it is within
   * `ttlMs` of `now` and rebuilds the canonical message from these fields,
   * so swapping the action or subscriptionId post-sign breaks verification. */
  issuedAt: string;
}

export function isSubscriptionManageAction(
  value: unknown,
): value is SubscriptionManageAction {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_MANAGE_ACTIONS as readonly string[]).includes(value)
  );
}

export function buildManageIntentMessage(
  intent: SubscriptionManageIntent,
): Buffer {
  if (!isSubscriptionManageAction(intent.action)) {
    throw new SubscriptionManageAuthError(
      "invalid_action",
      `action must be one of: ${SUBSCRIPTION_MANAGE_ACTIONS.join(", ")}`,
    );
  }
  const lines = [
    SUBSCRIPTION_MANAGE_SCHEMA_VERSION,
    `action=${intent.action}`,
    `subscriptionId=${intent.subscriptionId}`,
    `customerWallet=${intent.customerWallet}`,
    `issuedAt=${intent.issuedAt}`,
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function decodeEd25519Pubkey(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new SubscriptionManageAuthError(
      "invalid_public_key",
      "publicKey must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_PUBKEY_LENGTH) {
    throw new SubscriptionManageAuthError(
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
    throw new SubscriptionManageAuthError(
      "invalid_signature",
      "signature must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_SIG_LENGTH) {
    throw new SubscriptionManageAuthError(
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

export interface VerifyManageIntentInput {
  intent: SubscriptionManageIntent;
  publicKey: string;
  signature: string;
  /** Server clock at the moment of verification — passed in so tests can pin
   * a deterministic time and the production caller uses `Date.now()`. */
  now?: number;
  /** Override the default replay window. Mostly for tests. */
  ttlMs?: number;
}

/**
 * Verify a customer's intent to cancel / pause / resume a subscription. The
 * publicKey must equal the subscription's customerWallet (the merchant cannot
 * sign on behalf of the customer); the signature must validate against the
 * canonical message rebuilt from the server-trusted intent fields; and
 * issuedAt must be within `ttlMs` of `now` so a replayed signature from days
 * earlier — or one minted for the future — is rejected.
 */
export function verifySubscriptionManageIntent(
  input: VerifyManageIntentInput,
): void {
  if (input.publicKey !== input.intent.customerWallet) {
    throw new SubscriptionManageAuthError(
      "wallet_mismatch",
      "publicKey does not match subscription customer wallet",
    );
  }
  const issuedAtMs = Date.parse(input.intent.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw new SubscriptionManageAuthError(
      "issued_at_invalid",
      "issuedAt must be a valid ISO-8601 timestamp",
    );
  }
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? DEFAULT_INTENT_TTL_MS;
  if (Math.abs(now - issuedAtMs) > ttl) {
    throw new SubscriptionManageAuthError(
      "issued_at_expired",
      "issuedAt is outside the accepted replay window",
    );
  }
  const pubKey = decodeEd25519Pubkey(input.publicKey);
  const sig = decodeEd25519Signature(input.signature);
  const message = buildManageIntentMessage(input.intent);
  if (!ed25519Verify(pubKey, message, sig)) {
    throw new SubscriptionManageAuthError(
      "invalid_signature",
      "manage signature did not verify against the intent",
    );
  }
}
