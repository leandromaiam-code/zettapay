import type { Database as Db } from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";
import { findMerchantById } from "../db/merchants.js";
import {
  findBridgeIntent,
  findBridgeIntentBySourceTx,
  getBridgeIntent,
  insertBridgeIntent,
  markBridgeIntentCompleted,
  markBridgeIntentFailed,
  recordBridgeSourceTx,
  updateBridgeAttestation,
  type BridgeIntent,
} from "../db/bridge_intents.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import {
  getDestinationConfig,
  getSourceChainConfig,
  networkForCluster,
  type Network,
  type SourceChain,
  type DestinationChainConfig,
  type SourceChainConfig,
} from "./chains.js";
import { BRIDGE_FEE_BPS, computeBridgeFee } from "./fee.js";
import type {
  AttestationClient,
  AttestationRecord,
} from "./attestation.js";
import type { Cluster, Currency } from "../lib/currencies.js";

export interface CreateBridgeIntentInput {
  merchantId: string;
  sourceChain: SourceChain;
  sourceCurrency: Currency;
  amount: number;
  recipientWallet: string;
  metadata: Record<string, unknown> | null;
}

export interface BridgeQuote {
  intent: BridgeIntent;
  source: SourceChainConfig;
  destination: DestinationChainConfig;
  /** Hex of the recipient wallet padded to 32 bytes — input to depositForBurn. */
  mintRecipientBytes32: string;
  /**
   * Rough wall-clock estimate for the user. Mainnet CCTP routes typically
   * settle in 13-19 minutes (Ethereum finality is the long pole; L2 finality
   * is faster). Testnet is a few seconds. Tweak via env if upstream changes.
   */
  estimatedSeconds: number;
}

const ESTIMATED_SECONDS: Record<Network, number> = {
  mainnet: 19 * 60,
  testnet: 30,
};

/**
 * Quote + create a pending bridge intent. The merchant must exist; we never
 * custody funds — the intent records what the source-chain burn must look
 * like and where the recipient on Solana should be. The caller is expected
 * to perform `depositForBurn` on the source chain, then submit the resulting
 * tx hash via {@link recordBridgeSourceTransaction}.
 *
 * Premissa I.14: NOT custodying USDC. The recipient is whatever Solana wallet
 * the caller passed in (typically the merchant's wallet, but may be the AI
 * agent / user wallet for x402 flows).
 */
export function quoteBridgeIntent(
  db: Db,
  input: CreateBridgeIntentInput,
  cluster: Cluster,
): BridgeQuote {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  validateRecipient(input.recipientWallet);
  if (input.sourceCurrency !== "USDC") {
    throw HttpError.badRequest(
      `Bridge currency "${input.sourceCurrency}" is not supported in V1 — USDC only via CCTP`,
    );
  }

  const network = networkForCluster(cluster);
  const source = getSourceChainConfig(input.sourceChain, network);
  const destination = getDestinationConfig(network);

  const fee = computeBridgeFee(input.amount);
  const intent = insertBridgeIntent(db, {
    id: newId("brg"),
    merchantId: merchant.id,
    sourceChain: input.sourceChain,
    sourceNetwork: network,
    sourceCurrency: input.sourceCurrency,
    destinationCurrency: "USDC",
    recipientWallet: input.recipientWallet,
    amountUsdc: fee.amountUsdc,
    feeUsdc: fee.feeUsdc,
    netUsdc: fee.netUsdc,
    feeBps: BRIDGE_FEE_BPS,
    metadata: input.metadata,
  });

  return {
    intent,
    source,
    destination,
    mintRecipientBytes32: solanaWalletToBytes32(input.recipientWallet),
    estimatedSeconds: ESTIMATED_SECONDS[network],
  };
}

/**
 * Record the source-chain burn tx hash against an existing intent. Idempotent
 * for the same hash. Re-submitting a different hash for an already-burned
 * intent fails with 409 — bridge intents are bound to a single source tx.
 */
export function recordBridgeSourceTransaction(
  db: Db,
  intentId: string,
  sourceTxHash: string,
): BridgeIntent {
  const existing = findBridgeIntentBySourceTx(db, sourceTxHash);
  if (existing && existing.id !== intentId) {
    throw HttpError.conflict(
      `Source tx ${sourceTxHash} already bound to bridge intent ${existing.id}`,
    );
  }
  const intent = findBridgeIntent(db, intentId);
  if (!intent) {
    throw HttpError.notFound(`Bridge intent ${intentId} not found`);
  }
  if (intent.status === "completed" || intent.status === "failed") {
    throw HttpError.conflict(
      `Bridge intent ${intentId} is ${intent.status} and cannot accept a new source tx`,
    );
  }
  try {
    return recordBridgeSourceTx(db, intentId, sourceTxHash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw HttpError.conflict(msg);
  }
}

/**
 * Poll the attestation client (Circle iris by default) and project the result
 * onto the intent's status field. Calling this on an intent without a source
 * tx, or already in a terminal state, returns the intent unchanged.
 */
export async function syncBridgeIntent(
  db: Db,
  client: AttestationClient,
  intentId: string,
): Promise<BridgeIntent> {
  const intent = getBridgeIntent(db, intentId);
  if (!intent.sourceTxHash) {
    throw HttpError.badRequest(
      `Bridge intent ${intentId} has no source tx hash yet — call /source-tx first`,
    );
  }
  if (intent.status === "completed" || intent.status === "failed") {
    return intent;
  }

  const network = intent.sourceNetwork as Network;
  const source = getSourceChainConfig(
    intent.sourceChain as SourceChain,
    network,
  );

  let record: AttestationRecord;
  try {
    record = await client.fetchAttestation({
      sourceDomain: source.cctpDomain,
      transactionHash: intent.sourceTxHash,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return markBridgeIntentFailed(db, intentId, message);
  }

  if (record.status === "failed") {
    return markBridgeIntentFailed(
      db,
      intentId,
      "Circle attestation reported failed status",
    );
  }
  if (record.status === "complete") {
    return updateBridgeAttestation(db, intentId, {
      attestationStatus: "complete",
      attestationHash: record.attestation,
      status: "attested",
    });
  }
  return updateBridgeAttestation(db, intentId, {
    attestationStatus: "pending_confirmations",
    attestationHash: null,
    status: "burned",
  });
}

/**
 * Mark an intent as redeemed once the destination-chain receiveMessage tx is
 * confirmed. The redemption itself is signed by the recipient (or a relayer)
 * — ZettaPay never holds the private key, so we just record the resulting
 * Solana signature for audit.
 */
export function completeBridgeIntent(
  db: Db,
  intentId: string,
  redemptionSignature: string,
  paymentId: string | null = null,
): BridgeIntent {
  const intent = getBridgeIntent(db, intentId);
  if (intent.status !== "attested" && intent.status !== "burned") {
    throw HttpError.badRequest(
      `Bridge intent ${intentId} is ${intent.status} — only attested/burned intents can be completed`,
    );
  }
  return markBridgeIntentCompleted(
    db,
    intentId,
    redemptionSignature,
    paymentId,
  );
}

function validateRecipient(wallet: string): void {
  try {
    new PublicKey(wallet);
  } catch {
    throw HttpError.badRequest(
      `recipientWallet "${wallet}" is not a valid base58 Solana public key`,
    );
  }
}

/**
 * CCTP `depositForBurn` accepts a 32-byte mint recipient, formatted as the
 * raw destination address left-padded with zeros. For Solana that's just the
 * 32-byte ed25519 pubkey hex-encoded.
 */
export function solanaWalletToBytes32(wallet: string): string {
  const bytes = new PublicKey(wallet).toBytes();
  return `0x${Buffer.from(bytes).toString("hex")}`;
}
