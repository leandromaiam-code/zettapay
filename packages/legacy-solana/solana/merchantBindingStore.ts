import {
  Connection,
  PublicKey,
  type GetProgramAccountsFilter,
} from "@solana/web3.js";
import {
  MERCHANT_BINDING_DISCRIMINATOR,
  MERCHANT_BINDING_OFFSETS,
} from "./idl.js";
import {
  ZETTAPAY_PROGRAM_ID,
  deriveMerchantBindingPda,
  isValidMerchantHandle,
} from "./merchantBinding.js";

/**
 * Decoded `MerchantBinding` account. Field shapes mirror
 * `programs/zettapay/src/lib.rs` so callers can treat this as the authoritative
 * (handle → owner, USDC payout account) record. Values are normalised to
 * base58 / number primitives so the store can be consumed without leaking
 * `PublicKey` / `BN` types upstream.
 */
export interface MerchantBindingRecord {
  pda: string;
  bump: number;
  owner: string;
  usdcTokenAccount: string;
  merchantHandle: string;
  registeredAt: number;
}

export class MerchantBindingDecodeError extends Error {
  constructor(reason: string, public readonly pda?: string) {
    super(`failed to decode MerchantBinding${pda ? ` ${pda}` : ""}: ${reason}`);
    this.name = "MerchantBindingDecodeError";
  }
}

/**
 * Z9.4 — Z9 swept the `merchants` SQLite table off the wallet-binding hot path.
 * The chain is now the source of truth: this store reads `MerchantBinding`
 * PDAs through `getProgramAccounts` + IDL-driven Borsh decode. Lookups by
 * `(handle, owner)` short-circuit through `getAccountInfo` since the PDA is
 * deterministic; lookups by `owner` use `memcmp` so we don't pull every
 * account in the program down the wire.
 */
export class OnChainMerchantBindingStore {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey = ZETTAPAY_PROGRAM_ID,
  ) {}

  async findByPda(pda: PublicKey): Promise<MerchantBindingRecord | null> {
    const account = await this.connection.getAccountInfo(pda);
    if (!account) return null;
    if (!account.owner.equals(this.programId)) return null;
    return decodeMerchantBinding(account.data, pda);
  }

  async findByHandleAndOwner(
    handle: string,
    owner: PublicKey,
  ): Promise<MerchantBindingRecord | null> {
    if (!isValidMerchantHandle(handle)) {
      throw new Error(`merchant handle "${handle}" violates on-chain constraints`);
    }
    const { pda } = deriveMerchantBindingPda(handle, owner, this.programId);
    return this.findByPda(pda);
  }

  async findByOwner(owner: PublicKey): Promise<MerchantBindingRecord[]> {
    return this.queryProgram([
      memcmpFilter(MERCHANT_BINDING_OFFSETS.owner, owner.toBase58()),
    ]);
  }

  async findByUsdcTokenAccount(
    usdcTokenAccount: PublicKey,
  ): Promise<MerchantBindingRecord[]> {
    return this.queryProgram([
      memcmpFilter(
        MERCHANT_BINDING_OFFSETS.usdcTokenAccount,
        usdcTokenAccount.toBase58(),
      ),
    ]);
  }

  async list(): Promise<MerchantBindingRecord[]> {
    return this.queryProgram([]);
  }

  private async queryProgram(
    extraFilters: GetProgramAccountsFilter[],
  ): Promise<MerchantBindingRecord[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        memcmpFilter(
          MERCHANT_BINDING_OFFSETS.discriminator,
          Buffer.from(MERCHANT_BINDING_DISCRIMINATOR),
        ),
        ...extraFilters,
      ],
    });
    const out: MerchantBindingRecord[] = [];
    for (const { pubkey, account } of accounts) {
      const decoded = tryDecode(account.data, pubkey);
      if (decoded) out.push(decoded);
    }
    out.sort((a, b) => b.registeredAt - a.registeredAt);
    return out;
  }
}

function tryDecode(
  data: Buffer,
  pda: PublicKey,
): MerchantBindingRecord | null {
  try {
    return decodeMerchantBinding(data, pda);
  } catch {
    return null;
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

/**
 * IDL-driven Borsh decode of a `MerchantBinding` account. Mirrors the field
 * order in `programs/zettapay/src/lib.rs`. Callers should treat any thrown
 * `MerchantBindingDecodeError` as "this account is not a current-version
 * MerchantBinding" and skip it.
 */
export function decodeMerchantBinding(
  data: Buffer,
  pda?: PublicKey,
): MerchantBindingRecord {
  const pdaStr = pda?.toBase58();
  const minLen = MERCHANT_BINDING_OFFSETS.merchantHandleStart + 8;
  if (data.length < minLen) {
    throw new MerchantBindingDecodeError(
      `account too small (${data.length}B < ${minLen}B)`,
      pdaStr,
    );
  }

  for (let i = 0; i < MERCHANT_BINDING_DISCRIMINATOR.length; i++) {
    if (data[i] !== MERCHANT_BINDING_DISCRIMINATOR[i]) {
      throw new MerchantBindingDecodeError(
        "discriminator mismatch — not a MerchantBinding account",
        pdaStr,
      );
    }
  }

  const bump = data.readUInt8(MERCHANT_BINDING_OFFSETS.bump);
  const owner = new PublicKey(
    data.subarray(
      MERCHANT_BINDING_OFFSETS.owner,
      MERCHANT_BINDING_OFFSETS.owner + 32,
    ),
  );
  const usdcTokenAccount = new PublicKey(
    data.subarray(
      MERCHANT_BINDING_OFFSETS.usdcTokenAccount,
      MERCHANT_BINDING_OFFSETS.usdcTokenAccount + 32,
    ),
  );

  const handleLen = data.readUInt32LE(MERCHANT_BINDING_OFFSETS.merchantHandleLen);
  if (handleLen > 32) {
    throw new MerchantBindingDecodeError(
      `merchant_handle length ${handleLen} exceeds program max (32)`,
      pdaStr,
    );
  }
  const handleEnd = MERCHANT_BINDING_OFFSETS.merchantHandleStart + handleLen;
  if (data.length < handleEnd + 8) {
    throw new MerchantBindingDecodeError(
      "account truncated before registered_at",
      pdaStr,
    );
  }
  const merchantHandle = data
    .subarray(MERCHANT_BINDING_OFFSETS.merchantHandleStart, handleEnd)
    .toString("utf8");

  const registeredAt = Number(data.readBigInt64LE(handleEnd));
  if (!Number.isFinite(registeredAt)) {
    throw new MerchantBindingDecodeError("registered_at is not finite", pdaStr);
  }

  return {
    pda: pdaStr ?? "",
    bump,
    owner: owner.toBase58(),
    usdcTokenAccount: usdcTokenAccount.toBase58(),
    merchantHandle,
    registeredAt,
  };
}
