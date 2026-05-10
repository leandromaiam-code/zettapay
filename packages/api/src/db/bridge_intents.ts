import type { Database as Db } from "better-sqlite3";

export type BridgeIntentStatus =
  | "pending"
  | "burned"
  | "attested"
  | "completed"
  | "failed";

export interface BridgeIntentRow {
  id: string;
  merchant_id: string;
  source_chain: string;
  source_network: string;
  source_currency: string;
  destination_currency: string;
  recipient_wallet: string;
  amount_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  fee_bps: number;
  source_tx_hash: string | null;
  attestation_hash: string | null;
  attestation_status: string | null;
  redemption_signature: string | null;
  payment_id: string | null;
  status: BridgeIntentStatus;
  error_message: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface BridgeIntent {
  id: string;
  merchantId: string;
  sourceChain: string;
  sourceNetwork: string;
  sourceCurrency: string;
  destinationCurrency: string;
  recipientWallet: string;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  sourceTxHash: string | null;
  attestationHash: string | null;
  attestationStatus: string | null;
  redemptionSignature: string | null;
  paymentId: string | null;
  status: BridgeIntentStatus;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBridgeIntentInput {
  id: string;
  merchantId: string;
  sourceChain: string;
  sourceNetwork: string;
  sourceCurrency: string;
  destinationCurrency: string;
  recipientWallet: string;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  metadata: Record<string, unknown> | null;
}

function toIntent(row: BridgeIntentRow): BridgeIntent {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    sourceChain: row.source_chain,
    sourceNetwork: row.source_network,
    sourceCurrency: row.source_currency,
    destinationCurrency: row.destination_currency,
    recipientWallet: row.recipient_wallet,
    amountUsdc: row.amount_usdc,
    feeUsdc: row.fee_usdc,
    netUsdc: row.net_usdc,
    feeBps: row.fee_bps,
    sourceTxHash: row.source_tx_hash,
    attestationHash: row.attestation_hash,
    attestationStatus: row.attestation_status,
    redemptionSignature: row.redemption_signature,
    paymentId: row.payment_id,
    status: row.status,
    errorMessage: row.error_message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertBridgeIntent(
  db: Db,
  input: CreateBridgeIntentInput,
): BridgeIntent {
  db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      string | null,
    ]
  >(
    `INSERT INTO bridge_intents
       (id, merchant_id, source_chain, source_network, source_currency,
        destination_currency, recipient_wallet, amount_usdc, fee_usdc, net_usdc,
        fee_bps, metadata_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.id,
    input.merchantId,
    input.sourceChain,
    input.sourceNetwork,
    input.sourceCurrency,
    input.destinationCurrency,
    input.recipientWallet,
    input.amountUsdc,
    input.feeUsdc,
    input.netUsdc,
    input.feeBps,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return getBridgeIntent(db, input.id);
}

export function getBridgeIntent(db: Db, id: string): BridgeIntent {
  const row = db
    .prepare<[string]>("SELECT * FROM bridge_intents WHERE id = ?")
    .get(id) as BridgeIntentRow | undefined;
  if (!row) {
    throw new Error(`bridge intent ${id} not found`);
  }
  return toIntent(row);
}

export function findBridgeIntent(
  db: Db,
  id: string,
): BridgeIntent | null {
  const row = db
    .prepare<[string]>("SELECT * FROM bridge_intents WHERE id = ?")
    .get(id) as BridgeIntentRow | undefined;
  return row ? toIntent(row) : null;
}

export function findBridgeIntentBySourceTx(
  db: Db,
  sourceTxHash: string,
): BridgeIntent | null {
  const row = db
    .prepare<[string]>(
      "SELECT * FROM bridge_intents WHERE source_tx_hash = ?",
    )
    .get(sourceTxHash) as BridgeIntentRow | undefined;
  return row ? toIntent(row) : null;
}

export function listBridgeIntentsByMerchant(
  db: Db,
  merchantId: string,
  limit = 50,
): BridgeIntent[] {
  const rows = db
    .prepare<[string, number]>(
      `SELECT * FROM bridge_intents
         WHERE merchant_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(merchantId, limit) as BridgeIntentRow[];
  return rows.map(toIntent);
}

/**
 * Move a pending intent to `burned`, recording the source-chain tx hash.
 * Idempotent at the (intent, hash) pair: re-submitting the same hash is a
 * no-op; submitting a different hash for the same intent throws.
 */
export function recordBridgeSourceTx(
  db: Db,
  id: string,
  sourceTxHash: string,
): BridgeIntent {
  const intent = getBridgeIntent(db, id);
  if (intent.sourceTxHash) {
    if (intent.sourceTxHash === sourceTxHash) return intent;
    throw new Error(
      `bridge intent ${id} already has source tx ${intent.sourceTxHash}`,
    );
  }
  db.prepare<[string, string]>(
    `UPDATE bridge_intents
       SET source_tx_hash = ?,
           status = 'burned',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(sourceTxHash, id);
  return getBridgeIntent(db, id);
}

export interface AttestationUpdate {
  attestationStatus: string;
  attestationHash: string | null;
  status: BridgeIntentStatus;
}

export function updateBridgeAttestation(
  db: Db,
  id: string,
  update: AttestationUpdate,
): BridgeIntent {
  db.prepare<[string, string | null, BridgeIntentStatus, string]>(
    `UPDATE bridge_intents
       SET attestation_status = ?,
           attestation_hash = ?,
           status = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(update.attestationStatus, update.attestationHash, update.status, id);
  return getBridgeIntent(db, id);
}

export function markBridgeIntentCompleted(
  db: Db,
  id: string,
  redemptionSignature: string,
  paymentId: string | null = null,
): BridgeIntent {
  db.prepare<[string, string | null, string]>(
    `UPDATE bridge_intents
       SET status = 'completed',
           redemption_signature = ?,
           payment_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(redemptionSignature, paymentId, id);
  return getBridgeIntent(db, id);
}

export function markBridgeIntentFailed(
  db: Db,
  id: string,
  errorMessage: string,
): BridgeIntent {
  db.prepare<[string, string]>(
    `UPDATE bridge_intents
       SET status = 'failed',
           error_message = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(errorMessage, id);
  return getBridgeIntent(db, id);
}
