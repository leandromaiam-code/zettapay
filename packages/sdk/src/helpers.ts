/**
 * High-level SDK helpers — no backend dependency. Everything here speaks
 * directly to a Solana RPC via `@solana/web3.js` and `@solana/spl-token`.
 *
 * Mission Z27.1: createMerchant, createInvoice, getInvoiceStatus,
 * listenPaymentEvents, sweep.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Commitment,
  type ConfirmOptions,
  type Signer,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { randomBytes } from 'node:crypto';
import {
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  USDC_MINT,
  ZETTAPAY_PROGRAM_ID,
  buildRegisterMerchantInstruction,
  deriveInvoiceUsdcAddress,
  deriveMerchantBindingPda,
  derivePaymentPda,
  type DeriveInvoiceUsdcAddressParams,
  type InvoiceUsdcAddress,
} from './onchain.js';
import { ZETTAPAY_IDL } from './idl/zettapay.js';

/** Canonical USDC mint on Solana mainnet-beta (alias of `USDC_MINT['mainnet-beta']`). */
export const USDC_MAINNET_MINT = USDC_MINT['mainnet-beta'];
/** Canonical USDC mint published by Circle on devnet (alias of `USDC_MINT.devnet`). */
export const USDC_DEVNET_MINT = USDC_MINT.devnet;
/** USDC decimals — fixed at 6 (Circle spec). */
export const USDC_DECIMALS = 6;

const PAYMENT_DISCRIMINATOR = Buffer.from(
  ZETTAPAY_IDL.accounts.Payment.discriminator,
);

// ---------------------------------------------------------------------------
// createMerchant
// ---------------------------------------------------------------------------

export interface CreateMerchantParams {
  connection: Connection;
  /** Wallet that will own the immutable merchant binding. Must sign. */
  owner: Signer;
  /** Lowercase handle (3-32 chars, `[a-z0-9][a-z0-9_-]*`). */
  merchantHandle: string;
  /**
   * USDC mint that pay-outs settle to. Defaults to mainnet USDC. Pass
   * {@link USDC_DEVNET_MINT} for devnet, or any SPL mint for tests.
   */
  mint?: PublicKey;
  /**
   * Existing token account that receives merchant pay-outs. When omitted
   * we derive the ATA for `(mint, owner)` and create it in the same
   * transaction if it does not yet exist on-chain.
   */
  payoutTokenAccount?: PublicKey;
  /** Separate rent payer. Defaults to `owner` if not provided. */
  payer?: Signer;
  programId?: PublicKey;
  confirmOptions?: ConfirmOptions;
}

export interface CreateMerchantResult {
  signature: string;
  /** Immutable merchant binding PDA = [handle, owner]. */
  merchantBinding: PublicKey;
  bump: number;
  /** ATA the program recorded as the merchant's payout destination. */
  payoutTokenAccount: PublicKey;
  /** True when the ATA was created as part of this transaction. */
  createdPayoutAta: boolean;
}

/**
 * Register a merchant on-chain. Creates the merchant binding PDA and,
 * if necessary, the USDC ATA that will receive future payments. Returns
 * the signature, the binding PDA, and the resolved payout token
 * account. No backend hop.
 */
export async function createMerchant(
  params: CreateMerchantParams,
): Promise<CreateMerchantResult> {
  const programId = params.programId ?? ZETTAPAY_PROGRAM_ID;
  const mint = params.mint ?? USDC_MAINNET_MINT;
  const payer = params.payer ?? params.owner;

  const payoutAta =
    params.payoutTokenAccount ??
    getAssociatedTokenAddressSync(mint, params.owner.publicKey);

  const tx = new Transaction();
  let createdPayoutAta = false;
  if (!params.payoutTokenAccount) {
    const info = await params.connection.getAccountInfo(payoutAta);
    if (info === null) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          payoutAta,
          params.owner.publicKey,
          mint,
        ),
      );
      createdPayoutAta = true;
    }
  }

  tx.add(
    buildRegisterMerchantInstruction({
      owner: params.owner.publicKey,
      payer: payer.publicKey,
      merchantHandle: params.merchantHandle,
      usdcTokenAccount: payoutAta,
      programId,
    }),
  );

  const signers = uniqueSigners([params.owner, payer]);
  const signature = await sendAndConfirmTransaction(
    params.connection,
    tx,
    signers,
    params.confirmOptions,
  );

  const { pda: merchantBinding, bump } = deriveMerchantBindingPda(
    params.merchantHandle,
    params.owner.publicKey,
    programId,
  );

  return {
    signature,
    merchantBinding,
    bump,
    payoutTokenAccount: payoutAta,
    createdPayoutAta,
  };
}

// ---------------------------------------------------------------------------
// createInvoice
// ---------------------------------------------------------------------------

export interface CreateInvoiceParams {
  /** Merchant handle to settle against. */
  merchantHandle: string;
  /** On-chain owner of the merchant binding. */
  merchantOwner: PublicKey;
  /** Amount in 6-decimal USDC base units (1.5 USDC == 1_500_000n). */
  amount: bigint | number;
  /**
   * Optional pre-generated 32-byte invoice id. Use when the caller wants
   * a deterministic id (e.g. hash of an external system's order id).
   * Defaults to 32 random bytes.
   */
  invoiceId?: Uint8Array;
  /** Optional expiry as a unix epoch in seconds. Advisory — not enforced on-chain. */
  expiresAt?: number;
  /** Optional memo to surface in client UX (max 566 bytes per memo program spec). */
  memo?: string;
  programId?: PublicKey;
}

export interface Invoice {
  /** 32-byte invoice id, hex-encoded for transport. */
  invoiceIdHex: string;
  /** Raw 32-byte invoice id. */
  invoiceId: Uint8Array;
  /** Merchant binding PDA = [handle, owner]. */
  merchantBinding: string;
  /** Payment receipt PDA = [binding, invoiceId]. Watch this address to detect settlement. */
  paymentPda: string;
  merchantHandle: string;
  merchantOwner: string;
  amount: string;
  expiresAt: number | null;
  memo: string | null;
}

/**
 * Build an off-chain invoice descriptor for a future on-chain payment.
 * Pure CPU work — no RPC call. The returned `paymentPda` is the address
 * the payer must write to settle the invoice, and the address callers
 * watch via {@link getInvoiceStatus} or {@link listenPaymentEvents}.
 */
export function createInvoice(params: CreateInvoiceParams): Invoice {
  const programId = params.programId ?? ZETTAPAY_PROGRAM_ID;
  const amount =
    typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount);
  if (amount <= 0n) {
    throw new Error('createInvoice: amount must be strictly greater than zero');
  }

  let invoiceId: Uint8Array;
  if (params.invoiceId) {
    if (params.invoiceId.length !== PAYMENT_ID_LEN) {
      throw new Error(
        `createInvoice: invoiceId must be exactly ${PAYMENT_ID_LEN} bytes, got ${params.invoiceId.length}`,
      );
    }
    invoiceId = params.invoiceId;
  } else {
    invoiceId = new Uint8Array(randomBytes(PAYMENT_ID_LEN));
  }

  const { pda: binding } = deriveMerchantBindingPda(
    params.merchantHandle,
    params.merchantOwner,
    programId,
  );
  const { pda: paymentPda } = derivePaymentPda(binding, invoiceId, programId);

  return {
    invoiceIdHex: Buffer.from(invoiceId).toString('hex'),
    invoiceId,
    merchantBinding: binding.toBase58(),
    paymentPda: paymentPda.toBase58(),
    merchantHandle: params.merchantHandle,
    merchantOwner: params.merchantOwner.toBase58(),
    amount: amount.toString(),
    expiresAt: params.expiresAt ?? null,
    memo: params.memo ?? null,
  };
}

// ---------------------------------------------------------------------------
// getInvoiceStatus
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'pending' | 'paid' | 'expired';

export interface InvoiceStatusReceipt {
  /** 32-byte payment id encoded as hex. Mirrors the `paymentId` seed. */
  paymentIdHex: string;
  /** Amount in 6-decimal base units. */
  amount: bigint;
  /** ed25519 signature of the underlying SPL transfer, as base58. */
  txSignature: string;
  /** Solana slot the receipt was anchored at. */
  slot: number;
}

export interface InvoiceStatusResult {
  status: InvoiceStatus;
  paymentPda: string;
  /** Populated only when `status === 'paid'`. */
  receipt: InvoiceStatusReceipt | null;
}

export interface GetInvoiceStatusParams {
  connection: Connection;
  /** Invoice returned by {@link createInvoice}, or any structurally compatible value. */
  invoice: Pick<Invoice, 'paymentPda' | 'expiresAt' | 'invoiceIdHex'>;
  commitment?: Commitment;
  /** Override the unix-second clock — primarily for tests. */
  now?: number;
}

/**
 * Resolve the on-chain status of an invoice by polling the payment
 * receipt PDA. Returns `paid` with parsed receipt fields if the PDA
 * exists, `expired` if the invoice's advisory expiry has elapsed and
 * no receipt was found, otherwise `pending`.
 */
export async function getInvoiceStatus(
  params: GetInvoiceStatusParams,
): Promise<InvoiceStatusResult> {
  const pda = new PublicKey(params.invoice.paymentPda);
  const info = await params.connection.getAccountInfoAndContext(
    pda,
    params.commitment ?? 'confirmed',
  );

  if (info.value !== null) {
    const data = info.value.data;
    const receipt = decodePaymentReceipt(data);
    return {
      status: 'paid',
      paymentPda: pda.toBase58(),
      receipt: {
        ...receipt,
        slot: info.context.slot,
      },
    };
  }

  if (isInvoiceExpired(params.invoice, params.now)) {
    return { status: 'expired', paymentPda: pda.toBase58(), receipt: null };
  }
  return { status: 'pending', paymentPda: pda.toBase58(), receipt: null };
}

/**
 * Pure predicate — `true` once an invoice's advisory `expiresAt` is
 * strictly in the past. Returns `false` when `expiresAt` is missing or
 * `null` (the SDK convention for "no expiry").
 *
 * Mirrors the Rust `state::is_invoice_expired` helper so the SDK and the
 * on-chain crate agree on the boundary (`now >= expiresAt`, exclusive
 * inside the on-chain check) — drift here would let dashboard and
 * SPV-monitor surfaces disagree about whether an invoice is still
 * payable.
 */
export function isInvoiceExpired(
  invoice: Pick<Invoice, 'expiresAt'>,
  now?: number,
): boolean {
  const expiresAt = invoice.expiresAt;
  if (expiresAt === null || expiresAt === undefined) return false;
  const ts = now ?? Math.floor(Date.now() / 1000);
  return ts >= expiresAt;
}

// ---------------------------------------------------------------------------
// ensureInvoiceUsdcAta — Z28.5 edge: ATA missing
// ---------------------------------------------------------------------------

export interface EnsureInvoiceUsdcAtaParams extends DeriveInvoiceUsdcAddressParams {
  connection: Connection;
  /**
   * Wallet that pays for the ATA creation rent. Required only when the
   * ATA is missing — when the ATA already exists, the returned
   * instruction is `null` and no signer is consumed.
   */
  payer: PublicKey;
  commitment?: Commitment;
}

export interface EnsureInvoiceUsdcAtaResult extends InvoiceUsdcAddress {
  /** `true` when the ATA already exists on-chain — no instruction needed. */
  exists: boolean;
  /**
   * Idempotent `createAssociatedTokenAccount` instruction the caller
   * prepends to their settlement transaction. `null` when `exists === true`.
   *
   * The instruction is the idempotent variant so a race with another
   * payer's identical instruction will not error: SPL idempotent-create
   * silently no-ops if the ATA already exists by the time the tx lands.
   */
  createInstruction: TransactionInstruction | null;
}

/**
 * Guard the "ATA missing at payment time" edge: derive the invoice's
 * USDC ATA, check whether it already exists on-chain, and return a
 * ready-to-prepend idempotent-create instruction when it does not.
 *
 * The native `zettapay-core` program never creates ATAs itself
 * (premise 14: no custody, so the SDK / payer is responsible for the
 * token-account scaffolding). Without this guard, a payment landing
 * against an invoice whose USDC ATA was never created would silently
 * fail at the SPL token program — the merchant would see the payment
 * tx rejected and the customer would have an unrecoverable timeout.
 */
export async function ensureInvoiceUsdcAta(
  params: EnsureInvoiceUsdcAtaParams,
): Promise<EnsureInvoiceUsdcAtaResult> {
  const derived = deriveInvoiceUsdcAddress(params);
  const info = await params.connection.getAccountInfo(
    derived.usdcAta,
    params.commitment ?? 'confirmed',
  );
  if (info !== null) {
    return { ...derived, exists: true, createInstruction: null };
  }
  const createInstruction = createAssociatedTokenAccountIdempotentInstruction(
    params.payer,
    derived.usdcAta,
    derived.invoicePda,
    derived.usdcMint,
  );
  return { ...derived, exists: false, createInstruction };
}

/**
 * Decode a `Payment` account written by `record_payment`. Layout:
 *   8  bytes discriminator (anchor `account:Payment`)
 *  32  bytes merchant binding pubkey
 *  32  bytes payment_id
 *   8  bytes u64 amount (little-endian)
 *  64  bytes tx_signature
 *   8  bytes i64 created_at (little-endian, unix seconds — present but unused here)
 *   1  byte  bump
 */
function decodePaymentReceipt(
  data: Buffer | Uint8Array,
): Omit<InvoiceStatusReceipt, 'slot'> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 8 + 32 + PAYMENT_ID_LEN + 8 + TX_SIGNATURE_LEN) {
    throw new Error(
      `payment receipt is shorter than the minimum layout (${buf.length} bytes)`,
    );
  }
  if (!buf.subarray(0, 8).equals(PAYMENT_DISCRIMINATOR)) {
    throw new Error('payment receipt discriminator mismatch');
  }
  let offset = 8 + 32;
  const paymentId = buf.subarray(offset, offset + PAYMENT_ID_LEN);
  offset += PAYMENT_ID_LEN;
  const amount = buf.readBigUInt64LE(offset);
  offset += 8;
  const txSignature = buf.subarray(offset, offset + TX_SIGNATURE_LEN);
  return {
    paymentIdHex: Buffer.from(paymentId).toString('hex'),
    amount,
    txSignature: base58Encode(txSignature),
  };
}

// ---------------------------------------------------------------------------
// listenPaymentEvents
// ---------------------------------------------------------------------------

export interface PaymentEvent {
  /** Payment receipt PDA address. */
  paymentPda: string;
  paymentIdHex: string;
  /** Hex-encoded merchant binding (matches the value embedded in the receipt). */
  merchantBinding: string;
  amount: bigint;
  /** ed25519 signature of the SPL transfer, base58-encoded. */
  txSignature: string;
  slot: number;
}

export interface ListenPaymentEventsParams {
  connection: Connection;
  /** Merchant binding PDA to filter receipts by. */
  merchantBinding: PublicKey;
  onEvent: (event: PaymentEvent) => void;
  onError?: (err: unknown) => void;
  commitment?: Commitment;
  programId?: PublicKey;
}

export interface PaymentSubscription {
  /** Solana websocket subscription id. */
  id: number;
  /** Tear down the subscription. Idempotent. */
  close: () => Promise<void>;
}

/**
 * Subscribe to new payment receipts for a specific merchant. Uses the
 * RPC's program-account subscription with a memcmp filter pinned to the
 * receipt's discriminator + embedded merchant binding so the RPC only
 * pushes accounts that belong to this merchant.
 */
export async function listenPaymentEvents(
  params: ListenPaymentEventsParams,
): Promise<PaymentSubscription> {
  const programId = params.programId ?? ZETTAPAY_PROGRAM_ID;
  const id = params.connection.onProgramAccountChange(
    programId,
    (keyedAccount, context) => {
      try {
        const data = keyedAccount.accountInfo.data;
        const decoded = decodePaymentReceipt(data);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const bindingFromData = new PublicKey(buf.subarray(8, 8 + 32));
        params.onEvent({
          paymentPda: keyedAccount.accountId.toBase58(),
          paymentIdHex: decoded.paymentIdHex,
          merchantBinding: bindingFromData.toBase58(),
          amount: decoded.amount,
          txSignature: decoded.txSignature,
          slot: context.slot,
        });
      } catch (err) {
        params.onError?.(err);
      }
    },
    {
      commitment: params.commitment ?? 'confirmed',
      filters: [
        { dataSize: 8 + 32 + PAYMENT_ID_LEN + 8 + TX_SIGNATURE_LEN + 8 + 1 },
        { memcmp: { offset: 0, bytes: base58Encode(PAYMENT_DISCRIMINATOR) } },
        {
          memcmp: {
            offset: 8,
            bytes: params.merchantBinding.toBase58(),
          },
        },
      ],
    },
  );

  let closed = false;
  return {
    id,
    close: async () => {
      if (closed) return;
      closed = true;
      await params.connection.removeProgramAccountChangeListener(id);
    },
  };
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepParams {
  connection: Connection;
  /** Wallet that controls the source ATA. Must sign. */
  owner: Signer;
  /** SPL mint to sweep. Defaults to mainnet USDC. */
  mint?: PublicKey;
  /** Destination wallet (the ATA is derived) or a specific token account address. */
  destination: PublicKey;
  /**
   * When true (the default) and `destination` is interpreted as a wallet,
   * create the destination ATA in the same transaction if it does not
   * already exist on-chain.
   */
  createDestinationAtaIfMissing?: boolean;
  /**
   * Treat `destination` as a raw SPL token account address rather than
   * the wallet that owns one. Skips ATA derivation entirely.
   */
  destinationIsTokenAccount?: boolean;
  /** Optional cap. Defaults to the full ATA balance. */
  amount?: bigint;
  /** Rent payer for an on-the-fly ATA creation. Defaults to `owner`. */
  payer?: Signer;
  confirmOptions?: ConfirmOptions;
}

export interface SweepResult {
  signature: string | null;
  /** Source ATA the transfer came from. */
  source: PublicKey;
  /** Resolved destination token account. */
  destinationTokenAccount: PublicKey;
  /** Amount transferred, in mint base units. */
  amount: bigint;
  createdDestinationAta: boolean;
  /**
   * When the source ATA is empty and the caller didn't pass an explicit
   * amount, we skip the transaction entirely and return `noop: true`.
   */
  noop: boolean;
}

/**
 * Sweep an SPL token balance from the owner's ATA to a destination
 * wallet (or an explicit token account). Uses `transferChecked` so the
 * decimals must match the mint — divergence would fail on-chain instead
 * of silently mis-scaling.
 */
export async function sweep(params: SweepParams): Promise<SweepResult> {
  const mint = params.mint ?? USDC_MAINNET_MINT;
  const payer = params.payer ?? params.owner;
  const source = getAssociatedTokenAddressSync(mint, params.owner.publicKey);

  const sourceInfo = await params.connection.getAccountInfo(source);
  if (sourceInfo === null) {
    throw new Error(
      `sweep: source ATA ${source.toBase58()} does not exist for owner ${params.owner.publicKey.toBase58()}`,
    );
  }

  const sourceAccount = await getAccount(params.connection, source);
  const sourceBalance = sourceAccount.amount;

  let destinationTokenAccount: PublicKey;
  let createdDestinationAta = false;
  const tx = new Transaction();

  if (params.destinationIsTokenAccount) {
    destinationTokenAccount = params.destination;
  } else {
    destinationTokenAccount = getAssociatedTokenAddressSync(
      mint,
      params.destination,
      true,
    );
    const destInfo = await params.connection.getAccountInfo(
      destinationTokenAccount,
    );
    if (destInfo === null) {
      if (params.createDestinationAtaIfMissing !== false) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            destinationTokenAccount,
            params.destination,
            mint,
          ),
        );
        createdDestinationAta = true;
      } else {
        throw new Error(
          `sweep: destination ATA ${destinationTokenAccount.toBase58()} does not exist (set createDestinationAtaIfMissing to opt in)`,
        );
      }
    }
  }

  const amount = params.amount ?? sourceBalance;
  if (amount < 0n) {
    throw new Error('sweep: amount must be non-negative');
  }
  if (amount > sourceBalance) {
    throw new Error(
      `sweep: requested ${amount} exceeds source balance ${sourceBalance}`,
    );
  }

  if (amount === 0n) {
    return {
      signature: null,
      source,
      destinationTokenAccount,
      amount: 0n,
      createdDestinationAta,
      noop: true,
    };
  }

  const decimals = await readMintDecimals(params.connection, mint);

  tx.add(
    createTransferCheckedInstruction(
      source,
      mint,
      destinationTokenAccount,
      params.owner.publicKey,
      amount,
      decimals,
    ),
  );

  const signers = uniqueSigners([params.owner, payer]);
  const signature = await sendAndConfirmTransaction(
    params.connection,
    tx,
    signers,
    params.confirmOptions,
  );

  return {
    signature,
    source,
    destinationTokenAccount,
    amount,
    createdDestinationAta,
    noop: false,
  };
}

async function readMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  if (mint.equals(USDC_MAINNET_MINT) || mint.equals(USDC_DEVNET_MINT)) {
    return USDC_DECIMALS;
  }
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`sweep: mint ${mint.toBase58()} not found`);
  // Mint layout: decimals byte lives at offset 44.
  return info.data[44] ?? USDC_DECIMALS;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function uniqueSigners(signers: Signer[]): Signer[] {
  const seen = new Set<string>();
  const out: Signer[] = [];
  for (const s of signers) {
    const key = s.publicKey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array | Buffer): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = '';
  for (let i = 0; i < zeros; i++) result += '1';
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i] as number];
  }
  return result;
}

export const __testing__ = {
  decodePaymentReceipt,
  base58Encode,
};
