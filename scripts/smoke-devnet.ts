/**
 * scripts/smoke-devnet.ts — Z25.5
 *
 * End-to-end devnet smoke test for `zettapay-core` (Z25). Reproducible:
 * every run provisions a fresh merchant master + customer keypair + (by
 * default) a fresh SPL test mint, so the test never collides with prior
 * state and never depends on an external faucet's liquidity. The
 * deployer keypair is the only thing the script reads from disk, and the
 * only thing that needs pre-funded SOL.
 *
 * Phases (mirrors mission spec):
 *
 *   1. setup          — load deployer, connect to RPC, fresh keypairs,
 *                       create test mint (or use SMOKE_USDC_MINT override)
 *   2. register       — RegisterMerchant tx (chains = [SOLANA])
 *   3. invoice ×5     — CreateInvoice tx ×5, indexes 0..4, USDC amounts
 *                       1 / 2 / 5 / 10 / 100 USDC (6-decimal base units)
 *   4. simulate pay   — mint USDC to customer ATA, then transferChecked
 *                       customer → each invoice ATA at the invoice amount
 *   5. sweep          — Sweep tx with [0,1,2,3,4]
 *   6. validate       — merchant.invoice_count == 5, every invoice is
 *                       Swept with non-zero swept_at, every invoice ATA
 *                       balance matches its invoice amount, sum is the
 *                       sum of the five denominations
 *
 * Invocation:
 *
 *   npm run smoke:devnet
 *
 * Environment:
 *
 *   ZETTAPAY_PROGRAM_ID   on-chain program (default: declare_id! constant)
 *   SOLANA_RPC_URL        devnet endpoint (default: api.devnet.solana.com)
 *   SOLANA_KEYPAIR_PATH   payer keypair JSON (default: ~/.config/solana/id.json)
 *   SMOKE_USDC_MINT       reuse an existing mint instead of creating one
 *   SMOKE_SKIP_AIRDROP    set to "1" to refuse the airdrop fallback
 *
 * Exit codes: 0 on full success, 1 on any failure (validation or RPC).
 * The script is loud on purpose — every phase prints `==>` headers + a
 * `... ok` line so a flake mid-way is obvious from CI logs.
 *
 * Premise alignment:
 *   • Premise 1 (Solana V1): chains = [CHAIN_SOLANA].
 *   • Premise 2 (USDC V1): currency = CURRENCY_USDC.
 *   • Premise 14 (no custody): the program flips invoice.status only;
 *     USDC stays in the per-invoice ATA. Validation reads ATA balances,
 *     not any program-owned vault.
 *   • Wallet-less hard rule: no wallet adapter / connect() — the script
 *     generates raw `Keypair`s and signs locally.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// --- on-chain constants (mirror programs/zettapay-core/src/*.rs) ---------

// Declared `program_id` baked into the placeholder Cargo build. Override
// with ZETTAPAY_PROGRAM_ID once a real devnet deploy assigns a fresh key.
const DEFAULT_PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

const TAG_REGISTER_MERCHANT = 0;
const TAG_CREATE_INVOICE = 1;
const TAG_SWEEP = 2;

const MERCHANT_SEED = Buffer.from("merchant");
const INVOICE_INDEX_SEED_LEN = 8;

const CURRENCY_USDC = 0;
const CHAIN_SOLANA = 0;

const MERCHANT_TAG = 1;
const INVOICE_TAG = 2;
const INVOICE_STATUS_OPEN = 0;
const INVOICE_STATUS_SWEPT = 1;

const USDC_DECIMALS = 6;

// Denominations in USDC base units (1 USDC = 1_000_000). The mix spans
// three orders of magnitude so a silent off-by-one in encoding/decoding
// (e.g. u64 vs i64, LE vs BE) shows up loudly in validation.
const INVOICE_AMOUNTS: readonly bigint[] = [
  1_000_000n,
  2_000_000n,
  5_000_000n,
  10_000_000n,
  100_000_000n,
] as const;
const INVOICE_COUNT = INVOICE_AMOUNTS.length;
const TOTAL_USDC: bigint = INVOICE_AMOUNTS.reduce((a, b) => a + b, 0n);

// --- env loading ----------------------------------------------------------

interface SmokeConfig {
  rpcUrl: string;
  programId: PublicKey;
  payer: Keypair;
  mintOverride: PublicKey | null;
  skipAirdrop: boolean;
}

function loadConfig(): SmokeConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const programIdStr = process.env.ZETTAPAY_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  const programId = new PublicKey(programIdStr);

  const keypairPath =
    process.env.SOLANA_KEYPAIR_PATH ??
    resolve(homedir(), ".config", "solana", "id.json");
  const payer = loadKeypair(keypairPath);

  const mintOverrideStr = process.env.SMOKE_USDC_MINT;
  const mintOverride = mintOverrideStr ? new PublicKey(mintOverrideStr) : null;

  const skipAirdrop = process.env.SMOKE_SKIP_AIRDROP === "1";

  return { rpcUrl, programId, payer, mintOverride, skipAirdrop };
}

function loadKeypair(path: string): Keypair {
  const raw = readFileSync(path, "utf8").trim();
  const bytes = JSON.parse(raw) as unknown;
  if (!Array.isArray(bytes) || !bytes.every((b) => typeof b === "number")) {
    throw new Error(`keypair at ${path} is not a JSON number[] (Solana CLI format)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

// --- pda derivation (mirrors programs/zettapay-core/src/pda.rs) ----------

function deriveMerchantPda(master: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MERCHANT_SEED, master.toBuffer()],
    programId,
  );
}

function deriveInvoicePda(
  master: PublicKey,
  invoiceIndex: bigint,
  programId: PublicKey,
): [PublicKey, number] {
  const idx = Buffer.alloc(INVOICE_INDEX_SEED_LEN);
  idx.writeBigUInt64LE(invoiceIndex, 0);
  return PublicKey.findProgramAddressSync(
    [master.toBuffer(), idx],
    programId,
  );
}

// --- borsh encoders (mirrors programs/zettapay-core/src/instructions.rs) -

function encodeRegisterMerchantArgs(masterPubkey: PublicKey, chains: number[]): Buffer {
  // Pubkey(32) + Vec<u8>{ u32-le len + bytes }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(chains.length, 0);
  return Buffer.concat([masterPubkey.toBuffer(), len, Buffer.from(chains)]);
}

function encodeCreateInvoiceArgs(amount: bigint, currency: number): Buffer {
  const buf = Buffer.alloc(9);
  buf.writeBigUInt64LE(amount, 0);
  buf.writeUInt8(currency, 8);
  return buf;
}

function encodeSweepArgs(indexes: bigint[]): Buffer {
  // Vec<u64>{ u32-le len + len * u64-le }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(indexes.length, 0);
  const body = Buffer.alloc(8 * indexes.length);
  indexes.forEach((idx, i) => body.writeBigUInt64LE(idx, i * 8));
  return Buffer.concat([len, body]);
}

// --- instruction builders -------------------------------------------------

function ixRegisterMerchant(params: {
  programId: PublicKey;
  master: PublicKey;
  payer: PublicKey;
  chains: number[];
}): TransactionInstruction {
  const [merchantPda] = deriveMerchantPda(params.master, params.programId);
  const data = Buffer.concat([
    Buffer.from([TAG_REGISTER_MERCHANT]),
    encodeRegisterMerchantArgs(params.master, params.chains),
  ]);
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: merchantPda, isSigner: false, isWritable: true },
      { pubkey: params.master, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixCreateInvoice(params: {
  programId: PublicKey;
  master: PublicKey;
  payer: PublicKey;
  invoiceIndex: bigint;
  amount: bigint;
  currency: number;
}): TransactionInstruction {
  const [merchantPda] = deriveMerchantPda(params.master, params.programId);
  const [invoicePda] = deriveInvoicePda(params.master, params.invoiceIndex, params.programId);
  const data = Buffer.concat([
    Buffer.from([TAG_CREATE_INVOICE]),
    encodeCreateInvoiceArgs(params.amount, params.currency),
  ]);
  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: merchantPda, isSigner: false, isWritable: true },
      { pubkey: params.master, isSigner: true, isWritable: false },
      { pubkey: invoicePda, isSigner: false, isWritable: true },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function ixSweep(params: {
  programId: PublicKey;
  master: PublicKey;
  invoiceIndexes: bigint[];
}): TransactionInstruction {
  const [merchantPda] = deriveMerchantPda(params.master, params.programId);
  const keys = [
    { pubkey: merchantPda, isSigner: false, isWritable: true },
    { pubkey: params.master, isSigner: true, isWritable: false },
  ];
  for (const idx of params.invoiceIndexes) {
    const [invoicePda] = deriveInvoicePda(params.master, idx, params.programId);
    keys.push({ pubkey: invoicePda, isSigner: false, isWritable: true });
  }
  const data = Buffer.concat([
    Buffer.from([TAG_SWEEP]),
    encodeSweepArgs(params.invoiceIndexes),
  ]);
  return new TransactionInstruction({
    programId: params.programId,
    keys,
    data,
  });
}

// --- account decoders -----------------------------------------------------

interface DecodedMerchant {
  tag: number;
  bump: number;
  masterPubkey: PublicKey;
  chains: number[];
  invoiceCount: bigint;
  registeredAt: bigint;
}

function decodeMerchant(data: Buffer): DecodedMerchant {
  // tag(1) + bump(1) + master(32) + chains(Vec<u8>: 4+N) + invoice_count(8) + registered_at(8)
  let o = 0;
  const tag = data.readUInt8(o); o += 1;
  const bump = data.readUInt8(o); o += 1;
  const masterPubkey = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const chainsLen = data.readUInt32LE(o); o += 4;
  const chains = Array.from(data.subarray(o, o + chainsLen)); o += chainsLen;
  const invoiceCount = data.readBigUInt64LE(o); o += 8;
  const registeredAt = data.readBigInt64LE(o); o += 8;
  return { tag, bump, masterPubkey, chains, invoiceCount, registeredAt };
}

interface DecodedInvoice {
  tag: number;
  bump: number;
  merchant: PublicKey;
  invoiceIndex: bigint;
  amount: bigint;
  currency: number;
  status: number;
  createdAt: bigint;
  sweptAt: bigint;
}

function decodeInvoice(data: Buffer): DecodedInvoice {
  // tag(1) + bump(1) + merchant(32) + invoice_index(8) + amount(8) +
  // currency(1) + status(1) + created_at(8) + swept_at(8)
  let o = 0;
  const tag = data.readUInt8(o); o += 1;
  const bump = data.readUInt8(o); o += 1;
  const merchant = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const invoiceIndex = data.readBigUInt64LE(o); o += 8;
  const amount = data.readBigUInt64LE(o); o += 8;
  const currency = data.readUInt8(o); o += 1;
  const status = data.readUInt8(o); o += 1;
  const createdAt = data.readBigInt64LE(o); o += 8;
  const sweptAt = data.readBigInt64LE(o); o += 8;
  return { tag, bump, merchant, invoiceIndex, amount, currency, status, createdAt, sweptAt };
}

// --- helpers --------------------------------------------------------------

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function header(title: string): void {
  log(`\n==> ${title}`);
}

async function sendTx(
  connection: Connection,
  payer: Keypair,
  signers: Keypair[],
  ixs: TransactionInstruction[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
  const sig = await sendAndConfirmTransaction(connection, tx, all, {
    commitment: "confirmed",
  });
  log(`    ${label} sig=${sig}`);
  return sig;
}

async function ensurePayerFunded(
  connection: Connection,
  payer: PublicKey,
  minLamports: number,
  skipAirdrop: boolean,
): Promise<void> {
  const balance = await connection.getBalance(payer, "confirmed");
  log(`    payer balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (balance >= minLamports) return;
  if (skipAirdrop) {
    throw new Error(
      `payer ${payer.toBase58()} has ${balance} lamports, below required ${minLamports}; ` +
        `airdrop skipped`,
    );
  }
  log(`    requesting devnet airdrop (1 SOL)`);
  try {
    const sig = await connection.requestAirdrop(payer, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  } catch (err) {
    throw new Error(
      `airdrop failed: ${(err as Error).message}. Fund ${payer.toBase58()} on devnet ` +
        `(https://faucet.solana.com) and re-run.`,
    );
  }
  const after = await connection.getBalance(payer, "confirmed");
  if (after < minLamports) {
    throw new Error(
      `payer still under-funded after airdrop: have ${after}, need ${minLamports}`,
    );
  }
  log(`    payer balance after airdrop: ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

async function assertProgramDeployed(
  connection: Connection,
  programId: PublicKey,
): Promise<void> {
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (info === null) {
    throw new Error(
      `program ${programId.toBase58()} not found on cluster. ` +
        `Run scripts/deploy-devnet.sh or override ZETTAPAY_PROGRAM_ID.`,
    );
  }
  if (!info.executable) {
    throw new Error(`account ${programId.toBase58()} exists but is not executable`);
  }
  log(`    program ${programId.toBase58()} is deployed (executable=true)`);
}

// --- main flow ------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cfg = loadConfig();

  header("Phase 0 — Setup");
  log(`    rpc: ${cfg.rpcUrl}`);
  log(`    program id: ${cfg.programId.toBase58()}`);
  log(`    payer: ${cfg.payer.publicKey.toBase58()}`);

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  await assertProgramDeployed(connection, cfg.programId);
  await ensurePayerFunded(connection, cfg.payer.publicKey, 0.2 * LAMPORTS_PER_SOL, cfg.skipAirdrop);

  // Fresh per-run identities — guarantees hermeticity even if the script
  // is re-run against the same RPC. A leftover merchant from a prior run
  // would otherwise cause RegisterMerchant to fail with AccountAlreadyInUse.
  const master = Keypair.generate();
  const customer = Keypair.generate();
  log(`    fresh merchant master: ${master.publicKey.toBase58()}`);
  log(`    fresh customer:        ${customer.publicKey.toBase58()}`);

  let mint: PublicKey;
  if (cfg.mintOverride !== null) {
    mint = cfg.mintOverride;
    log(`    using preexisting mint: ${mint.toBase58()}`);
  } else {
    log(`    creating fresh ${USDC_DECIMALS}-decimal test mint`);
    mint = await createMint(
      connection,
      cfg.payer,
      cfg.payer.publicKey,
      null,
      USDC_DECIMALS,
    );
    log(`    test mint: ${mint.toBase58()}`);
  }

  header("Phase 1 — RegisterMerchant");
  await sendTx(
    connection,
    cfg.payer,
    [master],
    [
      ixRegisterMerchant({
        programId: cfg.programId,
        master: master.publicKey,
        payer: cfg.payer.publicKey,
        chains: [CHAIN_SOLANA],
      }),
    ],
    "register",
  );

  header(`Phase 2 — CreateInvoice ×${INVOICE_COUNT}`);
  for (let i = 0; i < INVOICE_COUNT; i += 1) {
    const amount = INVOICE_AMOUNTS[i]!;
    await sendTx(
      connection,
      cfg.payer,
      [master],
      [
        ixCreateInvoice({
          programId: cfg.programId,
          master: master.publicKey,
          payer: cfg.payer.publicKey,
          invoiceIndex: BigInt(i),
          amount,
          currency: CURRENCY_USDC,
        }),
      ],
      `invoice[${i}] amount=${amount}`,
    );
  }

  header("Phase 3 — Simulate USDC payment");
  // Customer ATA — funded from the test mint authority (= payer). In
  // production this leg happens off-protocol from whatever wallet the
  // customer chose; here we mint to keep the test self-contained.
  const customerAta = await createAssociatedTokenAccountIdempotent(
    connection,
    cfg.payer,
    mint,
    customer.publicKey,
  );
  log(`    customer ATA: ${customerAta.toBase58()}`);
  await mintTo(
    connection,
    cfg.payer,
    mint,
    customerAta,
    cfg.payer,
    TOTAL_USDC,
  );
  log(`    minted ${TOTAL_USDC} base units to customer ATA`);

  const invoiceAtas: PublicKey[] = [];
  for (let i = 0; i < INVOICE_COUNT; i += 1) {
    const [invoicePda] = deriveInvoicePda(master.publicKey, BigInt(i), cfg.programId);
    const invoiceAta = await createAssociatedTokenAccountIdempotent(
      connection,
      cfg.payer,
      mint,
      invoicePda,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      true, // invoice PDA is off-curve — must allowOwnerOffCurve
    );
    invoiceAtas.push(invoiceAta);
    const amount = INVOICE_AMOUNTS[i]!;
    const ix = createTransferCheckedInstruction(
      customerAta,
      mint,
      invoiceAta,
      customer.publicKey,
      amount,
      USDC_DECIMALS,
    );
    await sendTx(
      connection,
      cfg.payer,
      [customer],
      [ix],
      `pay invoice[${i}] -> ${invoiceAta.toBase58()}`,
    );
  }

  header("Phase 4 — Sweep");
  const indexes = INVOICE_AMOUNTS.map((_, i) => BigInt(i));
  await sendTx(
    connection,
    cfg.payer,
    [master],
    [
      ixSweep({
        programId: cfg.programId,
        master: master.publicKey,
        invoiceIndexes: indexes,
      }),
    ],
    "sweep [0..4]",
  );

  header("Phase 5 — Validate state + balances");
  const [merchantPda] = deriveMerchantPda(master.publicKey, cfg.programId);
  const merchantInfo = await connection.getAccountInfo(merchantPda, "confirmed");
  if (merchantInfo === null) throw new Error("merchant account missing post-sweep");
  if (!merchantInfo.owner.equals(cfg.programId)) {
    throw new Error(
      `merchant account owner = ${merchantInfo.owner.toBase58()}, expected program ${cfg.programId.toBase58()}`,
    );
  }
  const merchant = decodeMerchant(Buffer.from(merchantInfo.data));
  if (merchant.tag !== MERCHANT_TAG) {
    throw new Error(`merchant.tag = ${merchant.tag}, expected ${MERCHANT_TAG}`);
  }
  if (merchant.invoiceCount !== BigInt(INVOICE_COUNT)) {
    throw new Error(
      `merchant.invoice_count = ${merchant.invoiceCount}, expected ${INVOICE_COUNT}`,
    );
  }
  if (!merchant.chains.includes(CHAIN_SOLANA)) {
    throw new Error(`merchant.chains missing CHAIN_SOLANA: ${JSON.stringify(merchant.chains)}`);
  }
  log(`    merchant.invoice_count = ${merchant.invoiceCount} ✓`);

  let summedBalances = 0n;
  for (let i = 0; i < INVOICE_COUNT; i += 1) {
    const [invoicePda] = deriveInvoicePda(master.publicKey, BigInt(i), cfg.programId);
    const info = await connection.getAccountInfo(invoicePda, "confirmed");
    if (info === null) throw new Error(`invoice[${i}] PDA missing`);
    if (!info.owner.equals(cfg.programId)) {
      throw new Error(
        `invoice[${i}] owner = ${info.owner.toBase58()}, expected ${cfg.programId.toBase58()}`,
      );
    }
    const inv = decodeInvoice(Buffer.from(info.data));
    if (inv.tag !== INVOICE_TAG) {
      throw new Error(`invoice[${i}].tag = ${inv.tag}, expected ${INVOICE_TAG}`);
    }
    if (inv.invoiceIndex !== BigInt(i)) {
      throw new Error(`invoice[${i}].invoice_index = ${inv.invoiceIndex}, expected ${i}`);
    }
    if (inv.amount !== INVOICE_AMOUNTS[i]) {
      throw new Error(
        `invoice[${i}].amount = ${inv.amount}, expected ${INVOICE_AMOUNTS[i]}`,
      );
    }
    if (inv.currency !== CURRENCY_USDC) {
      throw new Error(`invoice[${i}].currency = ${inv.currency}, expected ${CURRENCY_USDC}`);
    }
    if (inv.status !== INVOICE_STATUS_SWEPT) {
      throw new Error(
        `invoice[${i}].status = ${inv.status}, expected ${INVOICE_STATUS_SWEPT} (Swept)`,
      );
    }
    if (inv.sweptAt <= 0n) {
      throw new Error(`invoice[${i}].swept_at = ${inv.sweptAt}, expected > 0`);
    }
    const ata = invoiceAtas[i]!;
    const tokenAccount = await getAccount(connection, ata, "confirmed");
    if (tokenAccount.amount !== INVOICE_AMOUNTS[i]) {
      throw new Error(
        `invoice[${i}] ATA balance = ${tokenAccount.amount}, expected ${INVOICE_AMOUNTS[i]}`,
      );
    }
    summedBalances += tokenAccount.amount;
    log(
      `    invoice[${i}] index=${inv.invoiceIndex} amount=${inv.amount} ` +
        `status=Swept ata_balance=${tokenAccount.amount} ✓`,
    );
  }
  if (summedBalances !== TOTAL_USDC) {
    throw new Error(`sum of ATA balances = ${summedBalances}, expected ${TOTAL_USDC}`);
  }
  log(`    sum of invoice ATAs = ${summedBalances} == total ${TOTAL_USDC} ✓`);

  // Customer ATA is the source of every transfer — it must end at zero
  // if the per-invoice transferChecked amounts summed to the minted
  // total. A non-zero residue surfaces an off-by-one in the encoding.
  const customerTokenAccount = await getAccount(connection, customerAta, "confirmed");
  if (customerTokenAccount.amount !== 0n) {
    throw new Error(
      `customer ATA residual = ${customerTokenAccount.amount}, expected 0`,
    );
  }
  log(`    customer ATA residual = 0 ✓`);

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  header(`SUCCESS in ${elapsedSec}s`);
  log(`    merchant master: ${master.publicKey.toBase58()}`);
  log(`    merchant pda:    ${merchantPda.toBase58()}`);
  log(`    mint:            ${mint.toBase58()}`);
  log(`    invoices swept:  ${INVOICE_COUNT}`);
  log(`    total settled:   ${TOTAL_USDC} base units`);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n==> FAIL: ${(err as Error).message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
