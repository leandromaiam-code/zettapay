import type { Database as Db } from "better-sqlite3";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  upsertOnChainPayment,
  type OnChainPaymentRecord,
} from "../db/onchain_payments.js";
import { appendAudit } from "../db/audit_journal.js";
import {
  OnChainPaymentReader,
  PaymentAccountDecodeError,
  decodePaymentAccount,
  type PaymentAccountRecord,
} from "../solana/paymentAccount.js";
import { ZETTAPAY_PROGRAM_ID } from "../solana/merchantBinding.js";

/**
 * Z9.5 — payment receipt indexer.
 *
 * Two ingestion paths feed the same upsert:
 *
 *   1. Push: Helius/Geyser webhook → `ingestRawAccount` (account bytes are
 *      base64 in the event payload, decoded inline, no RPC round-trip).
 *   2. Pull: `ingestByPda` (one-shot RPC fetch when the webhook only carried
 *      the PDA) and `backfill` (full `getProgramAccounts` reconciliation,
 *      run on boot or via the admin endpoint).
 *
 * Both paths converge on `applyDecoded`, which writes the row through
 * `upsertOnChainPayment` — so any feed (and any combination of feeds) lands
 * in the same idempotent place. Divergent re-ingest (same PDA, different
 * fields) is hard-rejected at the DB layer; that signals a corrupted feed,
 * not a duplicate webhook fire.
 */
export interface IngestRawAccountInput {
  pda: string;
  /** Base64-encoded account data bytes. */
  data: string;
  slot?: number | null;
}

export interface IngestStats {
  ingested: number;
  inserted: number;
  skipped: number;
  errors: Array<{ pda: string; reason: string }>;
}

export class OnChainPaymentIndexer {
  private readonly reader: OnChainPaymentReader;

  constructor(
    private readonly db: Db,
    private readonly connection: Connection,
    private readonly programId: PublicKey = ZETTAPAY_PROGRAM_ID,
  ) {
    this.reader = new OnChainPaymentReader(connection, programId);
  }

  ingestRawAccount(input: IngestRawAccountInput): {
    record: OnChainPaymentRecord;
    inserted: boolean;
  } {
    const data = Buffer.from(input.data, "base64");
    const pdaPk = new PublicKey(input.pda);
    const decoded = decodePaymentAccount(data, pdaPk);
    return this.applyDecoded(decoded, input.slot ?? null);
  }

  ingestRawAccounts(inputs: IngestRawAccountInput[]): IngestStats {
    const stats: IngestStats = { ingested: 0, inserted: 0, skipped: 0, errors: [] };
    for (const input of inputs) {
      try {
        const result = this.ingestRawAccount(input);
        stats.ingested += 1;
        if (result.inserted) stats.inserted += 1;
      } catch (err) {
        if (err instanceof PaymentAccountDecodeError) {
          // Discriminator/length mismatch is expected — the same webhook may
          // carry binding-account updates or unrelated program accounts.
          // These do not count as ingestion errors.
          stats.skipped += 1;
          continue;
        }
        stats.errors.push({
          pda: input.pda,
          reason: (err as Error).message,
        });
      }
    }
    return stats;
  }

  async ingestByPda(pda: string): Promise<{
    record: OnChainPaymentRecord;
    inserted: boolean;
  } | null> {
    const pdaPk = new PublicKey(pda);
    const decoded = await this.reader.fetchByPda(pdaPk);
    if (!decoded) return null;
    return this.applyDecoded(decoded, null);
  }

  async backfill(
    options: { merchantBinding?: string } = {},
  ): Promise<IngestStats> {
    const stats: IngestStats = { ingested: 0, inserted: 0, skipped: 0, errors: [] };
    const accounts = options.merchantBinding
      ? await this.reader.fetchByMerchantBinding(
          new PublicKey(options.merchantBinding),
        )
      : await this.reader.fetchAll();
    for (const decoded of accounts) {
      try {
        const result = this.applyDecoded(decoded, null);
        stats.ingested += 1;
        if (result.inserted) stats.inserted += 1;
      } catch (err) {
        stats.errors.push({
          pda: decoded.pda,
          reason: (err as Error).message,
        });
      }
    }
    appendAudit(this.db, {
      actor: "indexer",
      event: "onchain_payments.backfill",
      entityType: "onchain_payments",
      entityId: options.merchantBinding ?? null,
      payload: {
        ingested: stats.ingested,
        inserted: stats.inserted,
        errors: stats.errors.length,
      },
    });
    return stats;
  }

  private applyDecoded(
    decoded: PaymentAccountRecord,
    slot: number | null,
  ): { record: OnChainPaymentRecord; inserted: boolean } {
    return upsertOnChainPayment(this.db, {
      pda: decoded.pda,
      merchantBinding: decoded.merchantBinding,
      paymentIdHex: decoded.paymentIdHex,
      amount: decoded.amount,
      txSignature: decoded.txSignature,
      recordedAt: decoded.recordedAt,
      slot,
    });
  }
}
