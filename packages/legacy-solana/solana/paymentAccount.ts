import {
  Connection,
  PublicKey,
  type GetProgramAccountsFilter,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  PAYMENT_ACCOUNT_SIZE,
  PAYMENT_DISCRIMINATOR,
  PAYMENT_ID_BYTES,
  PAYMENT_OFFSETS,
  PAYMENT_TX_SIGNATURE_BYTES,
} from "./idl.js";
import { ZETTAPAY_PROGRAM_ID } from "./merchantBinding.js";

/**
 * Decoded `Payment` receipt account. Mirrors the on-chain `Payment` struct in
 * `programs/zettapay/src/lib.rs` (Z9). Pubkeys are normalised to base58, the
 * 32-byte payment_id to lowercase hex, and the 64-byte tx_signature to base58
 * (Solana canonical signature encoding) so callers don't have to import
 * `PublicKey`/`Buffer` to consume an indexed row.
 */
export interface PaymentAccountRecord {
  pda: string;
  bump: number;
  merchantBinding: string;
  paymentIdHex: string;
  amount: bigint;
  txSignature: string;
  recordedAt: number;
}

export class PaymentAccountDecodeError extends Error {
  constructor(reason: string, public readonly pda?: string) {
    super(`failed to decode Payment${pda ? ` ${pda}` : ""}: ${reason}`);
    this.name = "PaymentAccountDecodeError";
  }
}

/**
 * Borsh-style decode of a Z9 `Payment` receipt account. The layout is fixed
 * (153 bytes total) so this is a pure offset read — no length prefixes, no
 * variable-width fields.
 */
export function decodePaymentAccount(
  data: Buffer,
  pda?: PublicKey,
): PaymentAccountRecord {
  const pdaStr = pda?.toBase58();
  if (data.length < PAYMENT_ACCOUNT_SIZE) {
    throw new PaymentAccountDecodeError(
      `account too small (${data.length}B < ${PAYMENT_ACCOUNT_SIZE}B)`,
      pdaStr,
    );
  }

  for (let i = 0; i < PAYMENT_DISCRIMINATOR.length; i++) {
    if (data[i] !== PAYMENT_DISCRIMINATOR[i]) {
      throw new PaymentAccountDecodeError(
        "discriminator mismatch — not a Payment account",
        pdaStr,
      );
    }
  }

  const bump = data.readUInt8(PAYMENT_OFFSETS.bump);
  const merchantBinding = new PublicKey(
    data.subarray(
      PAYMENT_OFFSETS.merchantBinding,
      PAYMENT_OFFSETS.merchantBinding + 32,
    ),
  );
  const paymentIdHex = data
    .subarray(PAYMENT_OFFSETS.paymentId, PAYMENT_OFFSETS.paymentId + PAYMENT_ID_BYTES)
    .toString("hex");
  const amount = data.readBigUInt64LE(PAYMENT_OFFSETS.amount);
  const txSignature = bs58.encode(
    data.subarray(
      PAYMENT_OFFSETS.txSignature,
      PAYMENT_OFFSETS.txSignature + PAYMENT_TX_SIGNATURE_BYTES,
    ),
  );
  const recordedAt = Number(data.readBigInt64LE(PAYMENT_OFFSETS.recordedAt));
  if (!Number.isFinite(recordedAt)) {
    throw new PaymentAccountDecodeError("recorded_at is not finite", pdaStr);
  }

  return {
    pda: pdaStr ?? "",
    bump,
    merchantBinding: merchantBinding.toBase58(),
    paymentIdHex,
    amount,
    txSignature,
    recordedAt,
  };
}

/**
 * `getProgramAccounts` reader narrowed to the Z9 `Payment` discriminator. Used
 * by the indexer's backfill path to seed (and re-reconcile) the local mirror
 * from the chain. RPC providers cap result sizes per request, so callers
 * supplying a `merchantBinding` filter dramatically reduce wire weight.
 */
export class OnChainPaymentReader {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey = ZETTAPAY_PROGRAM_ID,
  ) {}

  async fetchByPda(pda: PublicKey): Promise<PaymentAccountRecord | null> {
    const account = await this.connection.getAccountInfo(pda);
    if (!account) return null;
    if (!account.owner.equals(this.programId)) return null;
    return decodePaymentAccount(account.data, pda);
  }

  async fetchByMerchantBinding(
    merchantBinding: PublicKey,
  ): Promise<PaymentAccountRecord[]> {
    return this.queryProgram([
      memcmpFilter(PAYMENT_OFFSETS.merchantBinding, merchantBinding.toBase58()),
    ]);
  }

  async fetchAll(): Promise<PaymentAccountRecord[]> {
    return this.queryProgram([]);
  }

  private async queryProgram(
    extraFilters: GetProgramAccountsFilter[],
  ): Promise<PaymentAccountRecord[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: PAYMENT_ACCOUNT_SIZE },
        memcmpFilter(
          PAYMENT_OFFSETS.discriminator,
          Buffer.from(PAYMENT_DISCRIMINATOR),
        ),
        ...extraFilters,
      ],
    });
    const out: PaymentAccountRecord[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        out.push(decodePaymentAccount(account.data, pubkey));
      } catch {
        // Skip accounts that pass the disc filter but fail to decode (forward
        // compat — a future Payment v2 layout would surface here as decode
        // failures rather than silently corrupting the mirror).
      }
    }
    out.sort((a, b) => b.recordedAt - a.recordedAt);
    return out;
  }
}

function memcmpFilter(
  offset: number,
  bytes: string | Buffer,
): GetProgramAccountsFilter {
  return {
    memcmp: {
      offset,
      bytes: typeof bytes === "string" ? bytes : bytes.toString("base64"),
      ...(typeof bytes === "string" ? {} : { encoding: "base64" as const }),
    },
  };
}
