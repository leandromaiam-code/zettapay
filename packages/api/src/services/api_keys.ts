import type { Database as Db } from "better-sqlite3";
import { insertApiKey, type ApiKey } from "../db/api_keys.js";
import { findMerchantById } from "../db/merchants.js";
import {
  generateKeyPair,
  hashSecret,
  type ApiKeyPair,
} from "../lib/api-keys.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";

export interface IssuedApiKey {
  apiKey: ApiKey;
  /** Plaintext secret — present only on the response that minted the key. */
  secret: string;
}

export interface IssueApiKeyInput {
  merchantId: string;
  label?: string | null;
}

/**
 * Mint a new key pair for the given merchant, persist `sha256(secret)`, and
 * return the secret to the caller exactly once. Subsequent reads only ever
 * surface the public half + hash.
 */
export function issueApiKey(
  db: Db,
  input: IssueApiKeyInput,
): IssuedApiKey {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant "${input.merchantId}" not found`);
  }

  const pair: ApiKeyPair = generateKeyPair();
  const apiKey = insertApiKey(db, {
    id: newId("apikey"),
    merchantId: merchant.id,
    publicKey: pair.public,
    secretHash: hashSecret(pair.secret),
    label: input.label ?? null,
  });
  return { apiKey, secret: pair.secret };
}
