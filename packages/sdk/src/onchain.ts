/**
 * ZettaPay on-chain helpers — PDA derivation + Anchor-encoded instruction
 * builders for the merchant binding program (Z9).
 *
 * The encoding is hand-rolled (8-byte sha-derived discriminator + Borsh
 * args) so the SDK does not pull in `@coral-xyz/anchor` as a runtime
 * dependency — that package weighs ~1.5MB and is a non-trivial cost for
 * agent-side callers that only ever invoke two instructions.
 *
 * Mirrors `programs/zettapay/src/lib.rs` byte-for-byte. Drift in seeds,
 * discriminators, or argument ordering would silently produce
 * unexecutable transactions.
 */
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Connection,
  type Signer,
} from '@solana/web3.js';
import { ZETTAPAY_IDL } from './idl/zettapay.js';

export const ZETTAPAY_PROGRAM_ID = new PublicKey(ZETTAPAY_IDL.address);

export const MERCHANT_HANDLE_MIN_LEN = 3;
export const MERCHANT_HANDLE_MAX_LEN = 32;
export const PAYMENT_ID_LEN = 32;
export const TX_SIGNATURE_LEN = 64;

const HANDLE_FIRST = /^[a-z0-9]$/;
const HANDLE_TAIL = /^[a-z0-9_-]+$/;

export function isValidMerchantHandle(handle: string): boolean {
  if (handle.length < MERCHANT_HANDLE_MIN_LEN) return false;
  if (handle.length > MERCHANT_HANDLE_MAX_LEN) return false;
  const first = handle[0];
  if (!first || !HANDLE_FIRST.test(first)) return false;
  return HANDLE_TAIL.test(handle);
}

export interface PdaAddress {
  pda: PublicKey;
  bump: number;
}

/**
 * Derive the immutable merchant binding PDA. Seeds match the Rust
 * `RegisterMerchant` accounts struct: `[handle_bytes, owner_bytes]`.
 */
export function deriveMerchantBindingPda(
  merchantHandle: string,
  owner: PublicKey,
  programId: PublicKey = ZETTAPAY_PROGRAM_ID,
): PdaAddress {
  if (!isValidMerchantHandle(merchantHandle)) {
    throw new Error(
      `merchant handle "${merchantHandle}" violates on-chain constraints`,
    );
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(merchantHandle, 'utf8'), owner.toBuffer()],
    programId,
  );
  return { pda, bump };
}

/**
 * Derive the immutable payment receipt PDA from the merchant binding
 * address and a 32-byte payment id. Seeds match `RecordPayment` in
 * `programs/zettapay/src/lib.rs`.
 */
export function derivePaymentPda(
  merchantBinding: PublicKey,
  paymentId: Uint8Array,
  programId: PublicKey = ZETTAPAY_PROGRAM_ID,
): PdaAddress {
  if (paymentId.length !== PAYMENT_ID_LEN) {
    throw new Error(
      `payment_id must be exactly ${PAYMENT_ID_LEN} bytes, got ${paymentId.length}`,
    );
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [merchantBinding.toBuffer(), Buffer.from(paymentId)],
    programId,
  );
  return { pda, bump };
}

function encodeBorshString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function encodeBorshU64(value: bigint | number): Buffer {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) throw new Error('u64 value must be non-negative');
  if (big > 0xffffffffffffffffn) throw new Error('u64 value exceeds 2^64-1');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(big, 0);
  return buf;
}

function discriminator(disc: ReadonlyArray<number>): Buffer {
  return Buffer.from(disc);
}

export interface BuildRegisterMerchantParams {
  /** The wallet that will own the on-chain binding. Must sign. */
  owner: PublicKey;
  /** Rent payer. Decoupled from `owner` so a facilitator can sponsor account creation. */
  payer: PublicKey;
  /** Lowercase merchant handle (3-32 chars, alphanumeric + `-_`). */
  merchantHandle: string;
  /** USDC associated token account that receives merchant payouts. */
  usdcTokenAccount: PublicKey;
  /** Override for non-default deployments (e.g. localnet/devnet bytecode forks). */
  programId?: PublicKey;
}

/**
 * Build the `register_merchant` instruction. Returns a single
 * `TransactionInstruction` ready to add to a `Transaction`. The PDA is
 * derived from `(merchantHandle, owner)` — re-registering the same pair
 * is rejected on-chain.
 */
export function buildRegisterMerchantInstruction(
  params: BuildRegisterMerchantParams,
): TransactionInstruction {
  const programId = params.programId ?? ZETTAPAY_PROGRAM_ID;
  const { pda: binding } = deriveMerchantBindingPda(
    params.merchantHandle,
    params.owner,
    programId,
  );

  const data = Buffer.concat([
    discriminator(ZETTAPAY_IDL.instructions.registerMerchant.discriminator),
    encodeBorshString(params.merchantHandle),
    params.usdcTokenAccount.toBuffer(),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: binding, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface BuildRecordPaymentParams {
  /** The merchant binding PDA — must already exist on-chain. */
  merchantBinding: PublicKey;
  /** Rent payer. Permissionless: any wallet may anchor a settled receipt. */
  payer: PublicKey;
  /** 32 raw bytes identifying the payment. Typically random or a hash of an external invoice id. */
  paymentId: Uint8Array;
  /** USDC amount in 6-decimal base units (1.5 USDC == 1_500_000n). Must be > 0. */
  amount: bigint | number;
  /** 64-byte ed25519 signature of the underlying USDC transfer transaction. */
  txSignature: Uint8Array;
  programId?: PublicKey;
}

/**
 * Build the `record_payment` instruction. The receipt PDA is derived
 * from `(merchantBinding, paymentId)` — re-recording the same pair is
 * rejected on-chain (idempotency by construction).
 */
export function buildRecordPaymentInstruction(
  params: BuildRecordPaymentParams,
): TransactionInstruction {
  if (params.paymentId.length !== PAYMENT_ID_LEN) {
    throw new Error(
      `payment_id must be exactly ${PAYMENT_ID_LEN} bytes, got ${params.paymentId.length}`,
    );
  }
  if (params.txSignature.length !== TX_SIGNATURE_LEN) {
    throw new Error(
      `tx_signature must be exactly ${TX_SIGNATURE_LEN} bytes, got ${params.txSignature.length}`,
    );
  }
  const amount = typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount);
  if (amount <= 0n) {
    throw new Error('amount must be strictly greater than zero');
  }

  const programId = params.programId ?? ZETTAPAY_PROGRAM_ID;
  const { pda: payment } = derivePaymentPda(
    params.merchantBinding,
    params.paymentId,
    programId,
  );

  const data = Buffer.concat([
    discriminator(ZETTAPAY_IDL.instructions.recordPayment.discriminator),
    Buffer.from(params.paymentId),
    encodeBorshU64(amount),
    Buffer.from(params.txSignature),
  ]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.merchantBinding, isSigner: false, isWritable: false },
      { pubkey: payment, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface SendOnChainResult {
  /** Solana transaction signature of the confirmed transaction. */
  signature: string;
  /** The PDA written/read by the instruction. */
  pda: PublicKey;
}

export interface RegisterMerchantOnChainParams extends BuildRegisterMerchantParams {
  connection: Connection;
  /** Signers covering `owner` + `payer`. May be the same `Keypair` if the merchant funds their own registration. */
  signers: Signer[];
}

/**
 * Build, sign, and confirm a `register_merchant` transaction.
 *
 * Returns the Solana signature plus the derived merchant binding PDA so
 * callers can persist the linkage without re-deriving it.
 */
export async function registerMerchantOnChain(
  params: RegisterMerchantOnChainParams,
): Promise<SendOnChainResult> {
  const { connection, signers, ...build } = params;
  const ix = buildRegisterMerchantInstruction(build);
  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, signers);
  const { pda } = deriveMerchantBindingPda(
    build.merchantHandle,
    build.owner,
    build.programId ?? ZETTAPAY_PROGRAM_ID,
  );
  return { signature, pda };
}

export interface RecordPaymentOnChainParams extends BuildRecordPaymentParams {
  connection: Connection;
  signers: Signer[];
}

/**
 * Build, sign, and confirm a `record_payment` transaction.
 *
 * Returns the Solana signature plus the derived payment receipt PDA.
 */
export async function recordPayment(
  params: RecordPaymentOnChainParams,
): Promise<SendOnChainResult> {
  const { connection, signers, ...build } = params;
  const ix = buildRecordPaymentInstruction(build);
  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, signers);
  const { pda } = derivePaymentPda(
    build.merchantBinding,
    build.paymentId,
    build.programId ?? ZETTAPAY_PROGRAM_ID,
  );
  return { signature, pda };
}
