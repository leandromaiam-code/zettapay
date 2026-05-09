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
import { UpstreamError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getConnection, getFeePayer } from "./connection.js";
import { buildMemoInstruction, encodeMemoPayload, type MemoBindingPayload } from "./memo.js";

export interface RegisterBindingParams {
  ownerWallet: PublicKey;
  merchantId: string;
}

export interface RegisterBindingResult {
  ataAddress: string;
  ataCreated: boolean;
  txSignature: string;
  memoPayload: string;
  feePayer: string;
}

/**
 * Idempotently creates the merchant's USDC ATA and emits a memo program
 * instruction binding the merchant id to the wallet on-chain. Both
 * instructions run inside a single tx so the binding is atomic with rent.
 */
export async function registerOnchainBinding(
  params: RegisterBindingParams,
): Promise<RegisterBindingResult> {
  const cfg = getConfig();
  const connection = getConnection();
  const feePayer: Keypair = getFeePayer();

  const usdcMint = new PublicKey(cfg.solana.usdcMint);
  const ata = getAssociatedTokenAddressSync(
    usdcMint,
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
      usdcMint,
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
      signature,
    });
    return {
      ataAddress: ata.toBase58(),
      ataCreated,
      txSignature: signature,
      memoPayload: encoded,
      feePayer: feePayer.publicKey.toBase58(),
    };
  } catch (err) {
    throw new UpstreamError("Failed to broadcast merchant binding transaction", {
      cause: (err as Error).message,
    });
  }
}
