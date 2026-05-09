import {
  getOrCreateAssociatedTokenAccount,
  getMint,
  transferChecked,
  type Mint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";
import { HttpError } from "../lib/errors.js";

export interface SolanaConfig {
  rpcUrl: string;
  commitment: Commitment;
  usdcMintAddress: string;
  payerSecretKey: string | null;
}

export interface TransferUsdcParams {
  recipientOwner: PublicKey;
  amountUsdc: number;
}

export interface TransferUsdcResult {
  signature: string;
  payerWallet: string;
  recipientWallet: string;
  amountAtomic: bigint;
  decimals: number;
}

/**
 * Wraps the Solana RPC connection plus a hot facilitator keypair used to sign
 * SPL transfers. On devnet/testnet the facilitator IS the payer; on mainnet
 * this same client can be reused with a pre-signed transaction flow.
 */
export class SolanaService {
  private readonly connection: Connection;
  private readonly usdcMint: PublicKey;
  private readonly payer: Keypair | null;
  private mintInfo: Mint | null = null;

  constructor(config: SolanaConfig) {
    this.connection = new Connection(config.rpcUrl, config.commitment);
    this.usdcMint = new PublicKey(config.usdcMintAddress);
    this.payer = config.payerSecretKey
      ? loadKeypair(config.payerSecretKey)
      : null;
  }

  getConnection(): Connection {
    return this.connection;
  }

  getUsdcMintAddress(): string {
    return this.usdcMint.toBase58();
  }

  getPayerPublicKey(): PublicKey {
    if (!this.payer) {
      throw HttpError.config(
        "PAYER_SECRET_KEY is not configured — cannot sign transfers",
      );
    }
    return this.payer.publicKey;
  }

  async getMintDecimals(): Promise<number> {
    const info = await this.getMintInfo();
    return info.decimals;
  }

  /**
   * Transfer USDC from the configured payer ATA → recipient owner ATA.
   * Returns the confirmed transaction signature.
   */
  async transferUsdc(params: TransferUsdcParams): Promise<TransferUsdcResult> {
    if (!this.payer) {
      throw HttpError.config(
        "PAYER_SECRET_KEY is not configured — cannot sign transfers",
      );
    }
    const mintInfo = await this.getMintInfo();
    const amountAtomic = toAtomicAmount(params.amountUsdc, mintInfo.decimals);

    const payerAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      this.usdcMint,
      this.payer.publicKey,
    );

    if (payerAta.amount < amountAtomic) {
      throw HttpError.paymentFailed(
        "Insufficient USDC balance in payer ATA",
        {
          required: amountAtomic.toString(),
          available: payerAta.amount.toString(),
        },
      );
    }

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.payer,
      this.usdcMint,
      params.recipientOwner,
    );

    const signature = await transferChecked(
      this.connection,
      this.payer,
      payerAta.address,
      this.usdcMint,
      recipientAta.address,
      this.payer,
      amountAtomic,
      mintInfo.decimals,
    );

    return {
      signature,
      payerWallet: this.payer.publicKey.toBase58(),
      recipientWallet: params.recipientOwner.toBase58(),
      amountAtomic,
      decimals: mintInfo.decimals,
    };
  }

  private async getMintInfo(): Promise<Mint> {
    if (!this.mintInfo) {
      this.mintInfo = await getMint(this.connection, this.usdcMint);
    }
    return this.mintInfo;
  }
}

function loadKeypair(secret: string): Keypair {
  try {
    if (secret.trim().startsWith("[")) {
      const arr = JSON.parse(secret) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(secret.trim()));
  } catch (err) {
    throw HttpError.config(
      `Failed to load PAYER_SECRET_KEY: ${(err as Error).message}`,
    );
  }
}

/**
 * Converts a decimal USDC amount (e.g. 12.34) to atomic units (10^decimals).
 * Avoids JS float drift by routing through a fixed-precision string.
 */
export function toAtomicAmount(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw HttpError.badRequest("amountUsdc must be a positive finite number");
  }
  const fixed = amount.toFixed(decimals);
  const [whole, fraction = ""] = fixed.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const atomicStr = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(atomicStr === "" ? "0" : atomicStr);
  if (value <= 0n) {
    throw HttpError.badRequest(
      "amountUsdc resolves to zero atomic units — increase the amount",
    );
  }
  return value;
}
