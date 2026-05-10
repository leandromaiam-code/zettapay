import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";

/**
 * Z12.4 — permanent subscription authorization. The customer signs ONE
 * canonical message at subscription time; the cron worker re-verifies that
 * signature on every charge cycle. No custody, no on-chain delegate: the
 * signature is the consent record. Tampering with any field of the binding
 * (amount, interval, merchant) invalidates the signature.
 */
export const SUBSCRIPTION_AUTH_SCHEMA_VERSION =
  "ZETTAPAY-SUBSCRIPTION-AUTH-V1";

const ED25519_PUBKEY_LENGTH = 32;
const ED25519_SIG_LENGTH = 64;
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SubscriptionAuthErrorCode =
  | "missing_authorization"
  | "invalid_public_key"
  | "invalid_signature"
  | "wallet_mismatch"
  | "binding_mismatch";

export class SubscriptionAuthError extends Error {
  constructor(
    public readonly code: SubscriptionAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionAuthError";
  }
}

export interface SubscriptionAuthBinding {
  subscriptionId: string;
  merchantId: string;
  customerWallet: string;
  amount: number;
  currency: string;
  interval: string;
}

export function buildAuthorizationMessage(
  binding: SubscriptionAuthBinding,
): Buffer {
  const lines = [
    SUBSCRIPTION_AUTH_SCHEMA_VERSION,
    `subscriptionId=${binding.subscriptionId}`,
    `merchantId=${binding.merchantId}`,
    `customerWallet=${binding.customerWallet}`,
    `amount=${binding.amount}`,
    `currency=${binding.currency}`,
    `interval=${binding.interval}`,
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

function decodeEd25519Pubkey(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new SubscriptionAuthError(
      "invalid_public_key",
      "publicKey must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_PUBKEY_LENGTH) {
    throw new SubscriptionAuthError(
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
    throw new SubscriptionAuthError(
      "invalid_signature",
      "signature must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_SIG_LENGTH) {
    throw new SubscriptionAuthError(
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

export interface VerifyAuthorizationInput {
  binding: SubscriptionAuthBinding;
  publicKey: string;
  signature: string;
}

/**
 * Verify the customer's signed authorization for a subscription. The
 * publicKey must match the customerWallet stored on the subscription row —
 * this prevents an authorization captured for one wallet being replayed
 * against another. The signature must validate against the canonical
 * message rebuilt from the live binding fields, so any UPDATE that mutates
 * amount/interval/merchant invalidates the consent.
 */
export function verifySubscriptionAuthorization(
  input: VerifyAuthorizationInput,
): void {
  if (input.publicKey !== input.binding.customerWallet) {
    throw new SubscriptionAuthError(
      "wallet_mismatch",
      "authorization publicKey does not match customer wallet",
    );
  }
  const pubKey = decodeEd25519Pubkey(input.publicKey);
  const sig = decodeEd25519Signature(input.signature);
  const message = buildAuthorizationMessage(input.binding);
  if (!ed25519Verify(pubKey, message, sig)) {
    throw new SubscriptionAuthError(
      "invalid_signature",
      "authorization signature did not verify against the binding",
    );
  }
}
