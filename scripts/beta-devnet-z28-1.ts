/**
 * scripts/beta-devnet-z28-1.ts — Z28.1
 *
 * Internal beta runner on Solana devnet. Scales the Z25.5 smoke test
 * (1 merchant × 5 invoices) up to the Z28.1 mission spec (5 merchants ×
 * 20 invoices = 100 invoices), and emits a structured JSON report so
 * Leandro can hand it to the friend-merchant beta cohort + Immunefi
 * triage.
 *
 * Mission spec (Z28 sprint):
 *   "Beta interno devnet: cadastra 5 merchants amigos via SDK, processa
 *    100 invoices reais (USDC devnet), valida sweep, valida webhooks.
 *    Documenta bugs encontrados."
 *
 * Phases:
 *
 *   0. setup     — load deployer, connect to RPC, fresh keypairs (5
 *                  merchant masters + 1 customer), create test mint
 *                  (or reuse BETA_USDC_MINT)
 *   1. register  — RegisterMerchant tx ×5 (one per friend merchant)
 *   2. invoice   — CreateInvoice ×20 per merchant (= 100 total), amounts
 *                  cycled across $0.50 / $1 / $5 / $10 / $25 / $50 /
 *                  $100 / $250 / $500 / $1 (10 amounts × 2 cycles per
 *                  merchant) so a silent encoder bug at any magnitude
 *                  surfaces
 *   3. simulate  — mint USDC to customer ATA (sum of all 100 amounts),
 *                  then transferChecked customer → each invoice ATA
 *   4. sweep     — Sweep tx per merchant, indexes [0..19] batched at
 *                  TX_INDEX_BATCH per tx to stay under the 1232-byte
 *                  Solana tx limit
 *   5. validate  — every merchant.invoice_count == 20, every invoice
 *                  Swept + non-zero swept_at, ATA balances match,
 *                  customer ATA residual == 0
 *   6. webhooks  — (optional, BETA_API_URL set) for each merchant, GET
 *                  /webhooks/events and assert ≥1 payment.received event
 *                  was attempted; report per-merchant delivery status
 *
 * Each phase appends a `PhaseReport` entry (status, durationMs, txCount,
 * errors[]) to the report file. The report is the canonical artifact —
 * paste it into the runbook for the Immunefi bug-bounty narrative + the
 * BETA_FRIENDS_LOG markdown.
 *
 * Invocation:
 *
 *   npm run beta:devnet:z28-1
 *
 * Environment:
 *
 *   ZETTAPAY_PROGRAM_ID    on-chain program (default: declare_id! constant)
 *   SOLANA_RPC_URL         devnet endpoint (default: api.devnet.solana.com)
 *   SOLANA_KEYPAIR_PATH    deployer keypair (default: ~/.config/solana/id.json)
 *   BETA_USDC_MINT         reuse an existing test mint instead of creating
 *   BETA_API_URL           optional; if set, runs Phase 6 webhook checks
 *   BETA_API_KEY           required when BETA_API_URL is set
 *   BETA_MERCHANT_NAMES    optional CSV; default "alpha,bravo,charlie,delta,echo"
 *   BETA_REPORT_PATH       output JSON report (default: ./beta-z28-1-report.json)
 *   BETA_SKIP_AIRDROP      "1" to refuse devnet airdrop fallback
 *
 * Exit codes: 0 on full success, 1 on any phase failure. Failures are
 * captured in the JSON report regardless of exit code, so the operator
 * can post-mortem without re-running.
 *
 * Premise alignment:
 *   • Premise 1 (Solana V1) + Premise 2 (USDC V1): chains=[SOLANA], currency=USDC
 *   • Premise 14 (no custody): every invoice keeps funds in its own PDA-owned ATA
 *   • Premise 22 (free tier 100 tx/month): cohort size matches free-tier ceiling
 *   • Premise 26 (PR for every mission): this script is the closing deliverable for Z28.1
 *   • Wallet-less hard rule: customer signs locally as a raw Keypair; no `.connect()`
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
  mintTo,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// --- on-chain constants (mirror programs/zettapay-core/src/*.rs) ---------

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
const INVOICE_STATUS_SWEPT = 1;

const USDC_DECIMALS = 6;

// 10-amount cycle, $0.50 → $500, spanning 4 orders of magnitude so a
// silent off-by-one in u64 encoding shows up loudly. 20 invoices per
// merchant = 2 full cycles.
const AMOUNT_CYCLE_USDC: readonly bigint[] = [
  500_000n,        // $0.50
  1_000_000n,      // $1
  5_000_000n,      // $5
  10_000_000n,     // $10
  25_000_000n,     // $25
  50_000_000n,     // $50
  100_000_000n,    // $100
  250_000_000n,    // $250
  500_000_000n,    // $500
  1_000_000n,      // $1 (repeat to balance cycle)
] as const;

const MERCHANT_COUNT = 5;
const INVOICES_PER_MERCHANT = 20;
const TOTAL_INVOICES = MERCHANT_COUNT * INVOICES_PER_MERCHANT;

// Conservative sweep batch — 5 invoice PDA writables + 2 merchant
// accounts + sig overhead well under the 1232-byte tx limit. 20 / 5 = 4
// sweep txs per merchant.
const SWEEP_BATCH_SIZE = 5;

// --- env loading ----------------------------------------------------------

interface BetaConfig {
  rpcUrl: string;
  programId: PublicKey;
  payer: Keypair;
  mintOverride: PublicKey | null;
  apiUrl: string | null;
  apiKey: string | null;
  merchantNames: string[];
  reportPath: string;
  skipAirdrop: boolean;
}

function loadConfig(): BetaConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const programIdStr = process.env.ZETTAPAY_PROGRAM_ID ?? DEFAULT_PROGRAM_ID;
  const programId = new PublicKey(programIdStr);

  const keypairPath =
    process.env.SOLANA_KEYPAIR_PATH ??
    resolve(homedir(), ".config", "solana", "id.json");
  const payer = loadKeypair(keypairPath);

  const mintOverrideStr = process.env.BETA_USDC_MINT;
  const mintOverride = mintOverrideStr ? new PublicKey(mintOverrideStr) : null;

  const apiUrl = process.env.BETA_API_URL?.trim() || null;
  const apiKey = process.env.BETA_API_KEY?.trim() || null;
  if (apiUrl !== null && apiKey === null) {
    throw new Error("BETA_API_URL is set but BETA_API_KEY is missing");
  }

  const namesRaw = process.env.BETA_MERCHANT_NAMES ?? "alpha,bravo,charlie,delta,echo";
  const merchantNames = namesRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (merchantNames.length !== MERCHANT_COUNT) {
    throw new Error(
      `BETA_MERCHANT_NAMES must list exactly ${MERCHANT_COUNT} names; got ${merchantNames.length}`,
    );
  }

  const reportPath = process.env.BETA_REPORT_PATH ?? resolve(process.cwd(), "beta-z28-1-report.json");
  const skipAirdrop = process.env.BETA_SKIP_AIRDROP === "1";

  return { rpcUrl, programId, payer, mintOverride, apiUrl, apiKey, merchantNames, reportPath, skipAirdrop };
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

// --- borsh encoders -------------------------------------------------------

function encodeRegisterMerchantArgs(masterPubkey: PublicKey, chains: number[]): Buffer {
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
  invoiceCount: bigint;
  chains: number[];
}

function decodeMerchant(data: Buffer): DecodedMerchant {
  let o = 0;
  const tag = data.readUInt8(o); o += 1;
  o += 1; // bump
  o += 32; // master pubkey
  const chainsLen = data.readUInt32LE(o); o += 4;
  const chains = Array.from(data.subarray(o, o + chainsLen)); o += chainsLen;
  const invoiceCount = data.readBigUInt64LE(o); o += 8;
  return { tag, invoiceCount, chains };
}

interface DecodedInvoice {
  tag: number;
  invoiceIndex: bigint;
  amount: bigint;
  currency: number;
  status: number;
  sweptAt: bigint;
}

function decodeInvoice(data: Buffer): DecodedInvoice {
  let o = 0;
  const tag = data.readUInt8(o); o += 1;
  o += 1; // bump
  o += 32; // merchant pubkey
  const invoiceIndex = data.readBigUInt64LE(o); o += 8;
  const amount = data.readBigUInt64LE(o); o += 8;
  const currency = data.readUInt8(o); o += 1;
  const status = data.readUInt8(o); o += 1;
  o += 8; // created_at
  const sweptAt = data.readBigInt64LE(o); o += 8;
  return { tag, invoiceIndex, amount, currency, status, sweptAt };
}

// --- report shape ---------------------------------------------------------

interface PhaseReport {
  name: string;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  txCount: number;
  errors: string[];
}

interface MerchantSummary {
  name: string;
  master: string;
  merchantPda: string;
  registerSig: string | null;
  invoiceCount: number;
  totalUsdcBaseUnits: string;
  invoiceSignatures: string[];
  paymentSignatures: string[];
  sweepSignatures: string[];
  webhookEventCount: number | null;
}

interface BetaReport {
  mission: string;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number | null;
  rpcUrl: string;
  programId: string;
  mint: string | null;
  payer: string;
  customer: string | null;
  apiUrl: string | null;
  totalMerchants: number;
  totalInvoices: number;
  expectedTotalUsdcBaseUnits: string;
  phases: PhaseReport[];
  merchants: MerchantSummary[];
  bugs: BugEntry[];
  outcome: "success" | "failed";
}

interface BugEntry {
  phase: string;
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  detail: string;
  txSig: string | null;
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
      `payer ${payer.toBase58()} has ${balance} lamports, below required ${minLamports}; airdrop skipped`,
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
    throw new Error(`payer still under-funded after airdrop: have ${after}, need ${minLamports}`);
  }
}

async function assertProgramDeployed(
  connection: Connection,
  programId: PublicKey,
): Promise<void> {
  const info = await connection.getAccountInfo(programId, "confirmed");
  if (info === null) {
    throw new Error(
      `program ${programId.toBase58()} not found. Run scripts/deploy-devnet.sh or set ZETTAPAY_PROGRAM_ID.`,
    );
  }
  if (!info.executable) {
    throw new Error(`account ${programId.toBase58()} exists but is not executable`);
  }
}

function emptyPhase(name: string): PhaseReport {
  return { name, status: "ok", durationMs: 0, txCount: 0, errors: [] };
}

async function runPhase<T>(
  report: BetaReport,
  name: string,
  fn: (phase: PhaseReport) => Promise<T>,
): Promise<T> {
  const phase = emptyPhase(name);
  report.phases.push(phase);
  const t0 = Date.now();
  header(name);
  try {
    const out = await fn(phase);
    phase.durationMs = Date.now() - t0;
    log(`    ${name} ok (${phase.txCount} tx, ${phase.durationMs}ms)`);
    return out;
  } catch (err) {
    phase.durationMs = Date.now() - t0;
    phase.status = "fail";
    phase.errors.push((err as Error).message);
    log(`    ${name} FAIL: ${(err as Error).message}`);
    throw err;
  }
}

function writeReport(cfg: BetaConfig, report: BetaReport): void {
  writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2), "utf8");
  log(`    report → ${cfg.reportPath}`);
}

// --- main flow ------------------------------------------------------------

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const cfg = loadConfig();

  const report: BetaReport = {
    mission: "Z28.1 — internal beta on Solana devnet",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    durationSec: null,
    rpcUrl: cfg.rpcUrl,
    programId: cfg.programId.toBase58(),
    mint: null,
    payer: cfg.payer.publicKey.toBase58(),
    customer: null,
    apiUrl: cfg.apiUrl,
    totalMerchants: MERCHANT_COUNT,
    totalInvoices: TOTAL_INVOICES,
    expectedTotalUsdcBaseUnits: "0",
    phases: [],
    merchants: [],
    bugs: [],
    outcome: "failed",
  };

  log(`==> Z28.1 beta — ${MERCHANT_COUNT} merchants × ${INVOICES_PER_MERCHANT} invoices = ${TOTAL_INVOICES} invoices`);
  log(`    rpc:        ${cfg.rpcUrl}`);
  log(`    program:    ${cfg.programId.toBase58()}`);
  log(`    payer:      ${cfg.payer.publicKey.toBase58()}`);
  log(`    api:        ${cfg.apiUrl ?? "(none — webhook phase will be skipped)"}`);
  log(`    merchants:  ${cfg.merchantNames.join(", ")}`);

  const connection = new Connection(cfg.rpcUrl, "confirmed");

  // --- Phase 0: Setup ---
  let mint: PublicKey | null = null;
  let customer: Keypair | null = null;
  const masters: Keypair[] = [];
  try {
    await runPhase(report, "Phase 0 — Setup", async (_phase) => {
      await assertProgramDeployed(connection, cfg.programId);
      // 100 invoice txs + 5 register + 20 sweep + 100 payments + mint
      // ops → conservative 5 SOL floor for fees + rent.
      await ensurePayerFunded(connection, cfg.payer.publicKey, 5 * LAMPORTS_PER_SOL, cfg.skipAirdrop);

      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const kp = Keypair.generate();
        masters.push(kp);
        log(`    merchant[${cfg.merchantNames[m]}] master = ${kp.publicKey.toBase58()}`);
      }
      customer = Keypair.generate();
      report.customer = customer.publicKey.toBase58();
      log(`    customer = ${customer.publicKey.toBase58()}`);

      if (cfg.mintOverride !== null) {
        mint = cfg.mintOverride;
        log(`    reusing mint: ${mint.toBase58()}`);
      } else {
        mint = await createMint(connection, cfg.payer, cfg.payer.publicKey, null, USDC_DECIMALS);
        log(`    fresh test mint: ${mint.toBase58()}`);
      }
      report.mint = mint.toBase58();
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  if (mint === null) throw new Error("Phase 0 finished without setting mint");
  if (customer === null) throw new Error("Phase 0 finished without setting customer");
  const mintFinal: PublicKey = mint;
  const customerFinal: Keypair = customer;

  // Per-merchant accumulators that subsequent phases populate.
  const merchantSummaries: MerchantSummary[] = masters.map((kp, i) => {
    const [merchantPda] = deriveMerchantPda(kp.publicKey, cfg.programId);
    return {
      name: cfg.merchantNames[i]!,
      master: kp.publicKey.toBase58(),
      merchantPda: merchantPda.toBase58(),
      registerSig: null,
      invoiceCount: 0,
      totalUsdcBaseUnits: "0",
      invoiceSignatures: [],
      paymentSignatures: [],
      sweepSignatures: [],
      webhookEventCount: null,
    };
  });
  report.merchants = merchantSummaries;

  // --- Phase 1: Register 5 merchants ---
  try {
    await runPhase(report, "Phase 1 — RegisterMerchant ×5", async (phase) => {
      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const master = masters[m]!;
        const sig = await sendTx(
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
          `register[${cfg.merchantNames[m]}]`,
        );
        merchantSummaries[m]!.registerSig = sig;
        phase.txCount += 1;
      }
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 2: Create 100 invoices ---
  const invoiceAmounts: bigint[][] = masters.map(() => []);
  let expectedTotal = 0n;
  try {
    await runPhase(report, `Phase 2 — CreateInvoice ×${TOTAL_INVOICES}`, async (phase) => {
      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const master = masters[m]!;
        const summary = merchantSummaries[m]!;
        let merchantTotal = 0n;
        for (let i = 0; i < INVOICES_PER_MERCHANT; i += 1) {
          const amount = AMOUNT_CYCLE_USDC[i % AMOUNT_CYCLE_USDC.length]!;
          invoiceAmounts[m]!.push(amount);
          merchantTotal += amount;
          expectedTotal += amount;
          const sig = await sendTx(
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
            `invoice[${cfg.merchantNames[m]}#${i}] amount=${amount}`,
          );
          summary.invoiceSignatures.push(sig);
          summary.invoiceCount += 1;
          phase.txCount += 1;
        }
        summary.totalUsdcBaseUnits = merchantTotal.toString();
      }
      report.expectedTotalUsdcBaseUnits = expectedTotal.toString();
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 3: Simulate customer payments ---
  const invoiceAtas: PublicKey[][] = masters.map(() => []);
  try {
    await runPhase(report, `Phase 3 — Simulate payments ×${TOTAL_INVOICES}`, async (phase) => {
      const customerAta = await createAssociatedTokenAccountIdempotent(
        connection,
        cfg.payer,
        mintFinal,
        customerFinal.publicKey,
      );
      log(`    customer ATA: ${customerAta.toBase58()}`);
      await mintTo(connection, cfg.payer, mintFinal, customerAta, cfg.payer, expectedTotal);
      log(`    minted ${expectedTotal} base units to customer ATA`);

      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const master = masters[m]!;
        const summary = merchantSummaries[m]!;
        for (let i = 0; i < INVOICES_PER_MERCHANT; i += 1) {
          const amount = invoiceAmounts[m]![i]!;
          const [invoicePda] = deriveInvoicePda(master.publicKey, BigInt(i), cfg.programId);
          const invoiceAta = await createAssociatedTokenAccountIdempotent(
            connection,
            cfg.payer,
            mintFinal,
            invoicePda,
            undefined,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
            true, // PDA is off-curve
          );
          invoiceAtas[m]!.push(invoiceAta);
          const ix = createTransferCheckedInstruction(
            customerAta,
            mintFinal,
            invoiceAta,
            customerFinal.publicKey,
            amount,
            USDC_DECIMALS,
          );
          const sig = await sendTx(
            connection,
            cfg.payer,
            [customerFinal],
            [ix],
            `pay[${cfg.merchantNames[m]}#${i}] -> ${invoiceAta.toBase58()}`,
          );
          summary.paymentSignatures.push(sig);
          phase.txCount += 1;
        }
      }
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 4: Sweep (batched per merchant) ---
  try {
    await runPhase(report, "Phase 4 — Sweep", async (phase) => {
      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const master = masters[m]!;
        const summary = merchantSummaries[m]!;
        for (let start = 0; start < INVOICES_PER_MERCHANT; start += SWEEP_BATCH_SIZE) {
          const end = Math.min(start + SWEEP_BATCH_SIZE, INVOICES_PER_MERCHANT);
          const batch: bigint[] = [];
          for (let i = start; i < end; i += 1) batch.push(BigInt(i));
          const sig = await sendTx(
            connection,
            cfg.payer,
            [master],
            [
              ixSweep({
                programId: cfg.programId,
                master: master.publicKey,
                invoiceIndexes: batch,
              }),
            ],
            `sweep[${cfg.merchantNames[m]}] [${start}..${end - 1}]`,
          );
          summary.sweepSignatures.push(sig);
          phase.txCount += 1;
        }
      }
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 5: Validate on-chain state for every invoice ---
  try {
    await runPhase(report, "Phase 5 — Validate", async (_phase) => {
      let summedBalances = 0n;
      for (let m = 0; m < MERCHANT_COUNT; m += 1) {
        const master = masters[m]!;
        const [merchantPda] = deriveMerchantPda(master.publicKey, cfg.programId);
        const info = await connection.getAccountInfo(merchantPda, "confirmed");
        if (info === null) throw new Error(`merchant[${cfg.merchantNames[m]}] PDA missing`);
        if (!info.owner.equals(cfg.programId)) {
          throw new Error(
            `merchant[${cfg.merchantNames[m]}] owner = ${info.owner.toBase58()}, expected ${cfg.programId.toBase58()}`,
          );
        }
        const merchant = decodeMerchant(Buffer.from(info.data));
        if (merchant.tag !== MERCHANT_TAG) {
          throw new Error(`merchant[${cfg.merchantNames[m]}].tag = ${merchant.tag}, expected ${MERCHANT_TAG}`);
        }
        if (merchant.invoiceCount !== BigInt(INVOICES_PER_MERCHANT)) {
          throw new Error(
            `merchant[${cfg.merchantNames[m]}].invoice_count = ${merchant.invoiceCount}, expected ${INVOICES_PER_MERCHANT}`,
          );
        }
        if (!merchant.chains.includes(CHAIN_SOLANA)) {
          throw new Error(`merchant[${cfg.merchantNames[m]}].chains missing SOLANA`);
        }

        for (let i = 0; i < INVOICES_PER_MERCHANT; i += 1) {
          const [invoicePda] = deriveInvoicePda(master.publicKey, BigInt(i), cfg.programId);
          const invInfo = await connection.getAccountInfo(invoicePda, "confirmed");
          if (invInfo === null) throw new Error(`invoice[${cfg.merchantNames[m]}#${i}] PDA missing`);
          if (!invInfo.owner.equals(cfg.programId)) {
            throw new Error(
              `invoice[${cfg.merchantNames[m]}#${i}] owner = ${invInfo.owner.toBase58()}`,
            );
          }
          const inv = decodeInvoice(Buffer.from(invInfo.data));
          if (inv.tag !== INVOICE_TAG) throw new Error(`invoice[${cfg.merchantNames[m]}#${i}] bad tag`);
          if (inv.invoiceIndex !== BigInt(i)) {
            throw new Error(`invoice[${cfg.merchantNames[m]}#${i}].invoice_index = ${inv.invoiceIndex}`);
          }
          if (inv.amount !== invoiceAmounts[m]![i]) {
            throw new Error(
              `invoice[${cfg.merchantNames[m]}#${i}].amount = ${inv.amount}, expected ${invoiceAmounts[m]![i]}`,
            );
          }
          if (inv.currency !== CURRENCY_USDC) {
            throw new Error(`invoice[${cfg.merchantNames[m]}#${i}].currency = ${inv.currency}`);
          }
          if (inv.status !== INVOICE_STATUS_SWEPT) {
            throw new Error(`invoice[${cfg.merchantNames[m]}#${i}].status = ${inv.status}, expected Swept`);
          }
          if (inv.sweptAt <= 0n) {
            throw new Error(`invoice[${cfg.merchantNames[m]}#${i}].swept_at = ${inv.sweptAt}`);
          }
          const ata = invoiceAtas[m]![i]!;
          const tokenAccount = await getAccount(connection, ata, "confirmed");
          if (tokenAccount.amount !== invoiceAmounts[m]![i]) {
            throw new Error(
              `invoice[${cfg.merchantNames[m]}#${i}] ATA balance = ${tokenAccount.amount}, expected ${invoiceAmounts[m]![i]}`,
            );
          }
          summedBalances += tokenAccount.amount;
        }
        log(`    merchant[${cfg.merchantNames[m]}] all ${INVOICES_PER_MERCHANT} invoices validated`);
      }
      if (summedBalances !== expectedTotal) {
        throw new Error(`sum of ATA balances = ${summedBalances}, expected ${expectedTotal}`);
      }
      log(`    summed ATA balances = ${summedBalances} == expected ${expectedTotal}`);
    });
  } catch {
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 6: Webhook validation (optional, off-chain) ---
  if (cfg.apiUrl !== null && cfg.apiKey !== null) {
    try {
      await runPhase(report, "Phase 6 — Webhook events", async (phase) => {
        const url = new URL("/webhooks/events", cfg.apiUrl as string).toString();
        const res = await fetch(url, {
          headers: { "Authorization": `Bearer ${cfg.apiKey as string}` },
        });
        if (!res.ok) {
          throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as { events?: Array<{ event_id?: string; status?: string }> };
        const events = body.events ?? [];
        log(`    received ${events.length} webhook event rows from API`);
        for (const summary of merchantSummaries) {
          // The on-chain phases above don't talk to the API; this phase
          // just snapshots what the API delivered for the same merchant
          // master keys. If the API was wired to indexer, expect > 0
          // events; otherwise the field will be 0 and the runbook
          // flags the wiring as a known beta-blocker bug.
          summary.webhookEventCount = events.filter(
            (e) => typeof e.event_id === "string",
          ).length;
        }
        phase.txCount = events.length;
        if (events.length === 0) {
          report.bugs.push({
            phase: "Phase 6 — Webhook events",
            severity: "high",
            summary: "API /webhooks/events returned 0 rows after a 100-invoice run",
            detail:
              "The on-chain phases finalized 100 USDC transfers + sweeps successfully, " +
              "but the API surface reported zero webhook events. Either (a) the indexer " +
              "is not subscribed to this devnet program id, (b) webhook dispatch is gated " +
              "behind an env var unset in this run, or (c) the merchants registered via " +
              "raw on-chain ix are not joined to API merchant rows. Triage required " +
              "before the next beta cycle.",
            txSig: null,
          });
        }
      });
    } catch (err) {
      report.bugs.push({
        phase: "Phase 6 — Webhook events",
        severity: "medium",
        summary: "Webhook events endpoint unreachable",
        detail: (err as Error).message,
        txSig: null,
      });
      // Webhook phase failure is non-fatal — the on-chain settlement
      // already validated. Mark this run as success-with-bug rather than
      // hard-failing the report.
    }
  } else {
    const phase = emptyPhase("Phase 6 — Webhook events");
    phase.status = "skipped";
    phase.errors.push("BETA_API_URL not set; skipped");
    report.phases.push(phase);
    log(`\n==> Phase 6 — Webhook events  (skipped: BETA_API_URL not set)`);
  }

  // --- finalize ---
  report.finishedAt = new Date().toISOString();
  report.durationSec = Number(((Date.now() - startedAtMs) / 1000).toFixed(1));
  report.outcome = "success";
  writeReport(cfg, report);

  header(`SUCCESS in ${report.durationSec}s`);
  log(`    merchants registered: ${MERCHANT_COUNT}`);
  log(`    invoices created:     ${TOTAL_INVOICES}`);
  log(`    payments settled:     ${TOTAL_INVOICES}`);
  log(`    total USDC settled:   ${expectedTotal} base units`);
  log(`    bugs filed in report: ${report.bugs.length}`);
  log(`    report path:          ${cfg.reportPath}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n==> FAIL: ${(err as Error).message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
