import type { Database as Db } from "better-sqlite3";
import type { PixKeyType, PixProvider } from "../pix/client.js";

export interface MerchantRow {
  id: string;
  name: string;
  wallet_address: string;
  email: string;
  api_key: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  coinflow_enabled: number;
  coinflow_auto_settle: number;
  coinflow_merchant_id: string | null;
  coinflow_bank_account_id: string | null;
  velocity_max_payments_per_minute: number;
  velocity_max_amount_per_hour: number;
  pix_enabled: number;
  pix_auto_settle: number;
  pix_provider: PixProvider | null;
  pix_provider_merchant_id: string | null;
  pix_key: string | null;
  pix_key_type: PixKeyType | null;
  deleted_at: string | null;
  fraud_block_threshold: number;
  fraud_review_threshold: number;
  created_at: string;
}

export interface CoinflowSettlementSettings {
  enabled: boolean;
  autoSettle: boolean;
  coinflowMerchantId: string | null;
  bankAccountId: string | null;
}

export interface VelocityLimits {
  maxPaymentsPerMinute: number;
  maxAmountPerHour: number;
export interface PixSettlementSettings {
  enabled: boolean;
  autoSettle: boolean;
  provider: PixProvider | null;
  providerMerchantId: string | null;
  pixKey: string | null;
  pixKeyType: PixKeyType | null;
}

export interface Merchant {
  id: string;
  name: string;
  walletAddress: string;
  email: string;
  apiKey: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  coinflow: CoinflowSettlementSettings;
  velocity: VelocityLimits;
  pix: PixSettlementSettings;
  deletedAt: string | null;
  /** Z13.3: anomaly score (0-100) at or above which a payment is rejected.
   * `0` (default) = monitor-only — anomalies are still audited but never blocked. */
  fraudBlockThreshold: number;
  fraudReviewThreshold: number;
  createdAt: string;
}

export interface CreateMerchantInput {
  id: string;
  name: string;
  walletAddress: string;
  email: string;
  apiKey: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
}

export interface UpdateCoinflowInput {
  enabled: boolean;
  autoSettle: boolean;
  coinflowMerchantId: string | null;
  bankAccountId: string | null;
}

export interface UpdateVelocityInput {
  maxPaymentsPerMinute: number;
  maxAmountPerHour: number;
export interface UpdatePixInput {
  enabled: boolean;
  autoSettle: boolean;
  provider: PixProvider | null;
  providerMerchantId: string | null;
  pixKey: string | null;
  pixKeyType: PixKeyType | null;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    walletAddress: row.wallet_address,
    email: row.email,
    apiKey: row.api_key,
    webhookUrl: row.webhook_url,
    webhookSecret: row.webhook_secret,
    coinflow: {
      enabled: row.coinflow_enabled === 1,
      autoSettle: row.coinflow_auto_settle === 1,
      coinflowMerchantId: row.coinflow_merchant_id,
      bankAccountId: row.coinflow_bank_account_id,
    },
    velocity: {
      maxPaymentsPerMinute: row.velocity_max_payments_per_minute,
      maxAmountPerHour: row.velocity_max_amount_per_hour,
    pix: {
      enabled: row.pix_enabled === 1,
      autoSettle: row.pix_auto_settle === 1,
      provider: row.pix_provider,
      providerMerchantId: row.pix_provider_merchant_id,
      pixKey: row.pix_key,
      pixKeyType: row.pix_key_type,
    },
    deletedAt: row.deleted_at,
    fraudBlockThreshold: row.fraud_block_threshold ?? 0,
    fraudReviewThreshold: row.fraud_review_threshold,
    createdAt: row.created_at,
  };
}

export function insertMerchant(db: Db, input: CreateMerchantInput): Merchant {
  const stmt = db.prepare<
    [string, string, string, string, string, string | null, string | null]
  >(
    `INSERT INTO merchants (id, name, wallet_address, email, api_key, webhook_url, webhook_secret)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    input.id,
    input.name,
    input.walletAddress,
    input.email,
    input.apiKey,
    input.webhookUrl,
    input.webhookSecret,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE id = ?")
    .get(input.id) as MerchantRow | undefined;
  if (!row) {
    throw new Error("merchant inserted but not retrievable");
  }
  return toMerchant(row);
}

export function findMerchantById(db: Db, id: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE id = ?")
    .get(id) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByEmail(db: Db, email: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE email = ?")
    .get(email) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByWallet(db: Db, walletAddress: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE wallet_address = ?")
    .get(walletAddress) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByApiKey(db: Db, apiKey: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE api_key = ?")
    .get(apiKey) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function updateMerchantCoinflow(
  db: Db,
  id: string,
  input: UpdateCoinflowInput,
): Merchant {
  const stmt = db.prepare<
    [number, number, string | null, string | null, string]
  >(
    `UPDATE merchants
       SET coinflow_enabled = ?,
           coinflow_auto_settle = ?,
           coinflow_merchant_id = ?,
           coinflow_bank_account_id = ?
       WHERE id = ?`,
  );
  const result = stmt.run(
    input.enabled ? 1 : 0,
    input.autoSettle ? 1 : 0,
    input.coinflowMerchantId,
    input.bankAccountId,
    id,
  );
  if (result.changes === 0) {
    throw new Error(`merchant ${id} not found`);
  }
  const merchant = findMerchantById(db, id);
  if (!merchant) {
    throw new Error(`merchant ${id} disappeared after update`);
  }
  return merchant;
}

export interface RedactMerchantInput {
  redactedName: string;
  redactedEmail: string;
  redactedApiKey: string;
  redactedAt: string;
}

/**
 * LGPD/GDPR right-to-erasure. Anonymizes the merchant's PII fields in place
 * (name, email, webhook URL/secret, api key) and stamps `deleted_at`. The
 * merchant ID and wallet_address are retained because the `payments` table
 * has FK references to merchant_id and the on-chain wallet is already public
 * — financial-record retention obligations override erasure for these fields
 * (LGPD Art. 16 II / GDPR Art. 17(3)(b)).
 */
export function redactMerchant(
  db: Db,
  id: string,
  input: RedactMerchantInput,
): Merchant {
  const stmt = db.prepare<[string, string, string, string, string]>(
    `UPDATE merchants
       SET name = ?,
           email = ?,
           api_key = ?,
           webhook_url = NULL,
           webhook_secret = NULL,
           deleted_at = ?
       WHERE id = ?`,
  );
  const result = stmt.run(
    input.redactedName,
    input.redactedEmail,
    input.redactedApiKey,
    input.redactedAt,
    id,
  );
export function updateMerchantFraudThreshold(
  db: Db,
  id: string,
  threshold: number,
): Merchant {
  const result = db
    .prepare<[number, string]>(
      `UPDATE merchants SET fraud_review_threshold = ? WHERE id = ?`,
    )
    .run(threshold, id);
  if (result.changes === 0) {
    throw new Error(`merchant ${id} not found`);
  }
  const merchant = findMerchantById(db, id);
  if (!merchant) {
    throw new Error(`merchant ${id} disappeared after redaction`);
    throw new Error(`merchant ${id} disappeared after update`);
  }
  return merchant;
}

export function updateMerchantVelocity(
  db: Db,
  id: string,
  input: UpdateVelocityInput,
): Merchant {
  const stmt = db.prepare<[number, number, string]>(
    `UPDATE merchants
       SET velocity_max_payments_per_minute = ?,
           velocity_max_amount_per_hour = ?
       WHERE id = ?`,
  );
  const result = stmt.run(
    input.maxPaymentsPerMinute,
    input.maxAmountPerHour,
export function updateMerchantPix(
  db: Db,
  id: string,
  input: UpdatePixInput,
): Merchant {
  const stmt = db.prepare<
    [
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ]
  >(
    `UPDATE merchants
       SET pix_enabled = ?,
           pix_auto_settle = ?,
           pix_provider = ?,
           pix_provider_merchant_id = ?,
           pix_key = ?,
           pix_key_type = ?
       WHERE id = ?`,
  );
  const result = stmt.run(
    input.enabled ? 1 : 0,
    input.autoSettle ? 1 : 0,
    input.provider,
    input.providerMerchantId,
    input.pixKey,
    input.pixKeyType,
    id,
  );
  if (result.changes === 0) {
    throw new Error(`merchant ${id} not found`);
  }
  const merchant = findMerchantById(db, id);
  if (!merchant) {
    throw new Error(`merchant ${id} disappeared after update`);
  }
  return merchant;
}

export function updateMerchantFraudBlockThreshold(
  db: Db,
  id: string,
  threshold: number,
): Merchant {
  const stmt = db.prepare<[number, string]>(
    `UPDATE merchants SET fraud_block_threshold = ? WHERE id = ?`,
  );
  const result = stmt.run(threshold, id);
  if (result.changes === 0) {
    throw new Error(`merchant ${id} not found`);
  }
  const merchant = findMerchantById(db, id);
  if (!merchant) {
    throw new Error(`merchant ${id} disappeared after update`);
  }
  return merchant;
}
