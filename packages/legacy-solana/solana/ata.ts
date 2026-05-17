import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getConfig } from "../config.js";
import {
  DEFAULT_CURRENCY,
  type Currency,
  resolveMint,
} from "../lib/currencies.js";
import { UpstreamError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getConnection, getFeePayer } from "./connection.js";
import { buildMemoInstruction, encodeMemoPayload, type MemoBindingPayload } from "./memo.js";

export interface RegisterBindingParams {
  ownerWallet: PublicKey;
  merchantId: string;
  currency?: Currency;
}

export interface RegisterBindingResult {
  ataAddress: string;
  ataCreated: boolean;
  txSignature: string;
  memoPayload: string;
  feePayer: string;
  currency: Currency;
  mintAddress: string;
}

/**
 * Idempotently creates the merchant's ATA for the requested currency and
 * emits a memo program instruction binding the merchant id to the wallet
 * on-chain. Both instructions run inside a single tx so the binding is
 * atomic with rent. Defaults to USDC for backward compatibility — pass an
 * explicit `currency` to provision a different SPL ATA.
 */
export async function registerOnchainBinding(
  params: RegisterBindingParams,
): Promise<RegisterBindingResult> {
  const cfg = getConfig();
  const connection = getConnection();
  const feePayer: Keypair = getFeePayer();

  const currency = params.currency ?? DEFAULT_CURRENCY;
  const overrides = cfg.solana.usdcMint
    ? ({ USDC: cfg.solana.usdcMint } as Partial<Record<Currency, string>>)
    : undefined;
  const resolved = resolveMint(currency, {
    cluster: cfg.solana.cluster,
    overrides,
  });
  const mintPubkey = new PublicKey(resolved.mintAddress);

  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    params.ownerWallet,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const existing = await connection.getAccountInfo(ata, cfg.solana.commitment);
  const ataCreated = existing === null;

  const memoPayload: MemoBindingPayload = {
    namespace: cfg.binding.memoNamespace,
    merchantId: params.merchantId,
    wallet: params.ownerWallet.toBase58(),
    ata: ata.toBase58(),
    ts: Math.floor(Date.now() / 1000),
  };
  const encoded = encodeMemoPayload(memoPayload);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer.publicKey,
      ata,
      params.ownerWallet,
      mintPubkey,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    buildMemoInstruction(encoded, [feePayer.publicKey]),
  ];

  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer.publicKey;

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [feePayer], {
      commitment: cfg.solana.commitment,
      skipPreflight: false,
      maxRetries: 3,
    });
    logger.info("merchant_binding_confirmed", {
      merchantId: params.merchantId,
      wallet: params.ownerWallet.toBase58(),
      ata: ata.toBase58(),
      ataCreated,
      currency,
      mint: resolved.mintAddress,
      signature,
    });
    return {
      ataAddress: ata.toBase58(),
      ataCreated,
      txSignature: signature,
      memoPayload: encoded,
      feePayer: feePayer.publicKey.toBase58(),
      currency,
      mintAddress: resolved.mintAddress,
    };
  } catch (err) {
    throw new UpstreamError("Failed to broadcast merchant binding transaction", {
      cause: (err as Error).message,
    });
  }
}

