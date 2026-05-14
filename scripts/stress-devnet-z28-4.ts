/**
 * scripts/stress-devnet-z28-4.ts — Z28.4
 *
 * Devnet stress test for `zettapay-core`. Defaults target 1000
 * invoices (10 merchants × 100 invoices) and 1000 simulated USDC
 * payments. Each phase is timed end-to-end, transactions are sent
 * with bounded concurrency, and per-instruction compute-unit
 * consumption is sampled from confirmed transactions to surface the
 * actual on-chain CU profile of every instruction the protocol ships
 * today (RegisterMerchant, CreateInvoice, transferChecked, Sweep).
 *
 * Mission spec (Z28 sprint):
 *   "Stress test devnet: script cria 1000 invoices simultaneas, simula
 *    1000 pagamentos, mede TPS, identifica bottlenecks. Reporta CU
 *    usage por instruction."
 *
 * Phases:
 *
 *   0. setup     — load deployer, connect to RPC, fresh keypairs
 *                  (N merchant masters + N customers — one customer
 *                  per merchant, so per-account write conflicts on the
 *                  customer ATA don't collapse all payments into a
 *                  single serialized stream — and a fresh SPL test
 *                  mint (or reuse STRESS_USDC_MINT)
 *   1. register  — RegisterMerchant ×N (sequential; one-time cost,
 *                  excluded from steady-state TPS)
 *   2. invoices  — CreateInvoice ×TOTAL distributed round-robin across
 *                  merchants, submitted with STRESS_CONCURRENCY workers
 *                  in flight. Each invoice gets a USDC amount cycled
 *                  from a 10-rung ladder (\$0.50 → \$500) so encoder
 *                  bugs at any magnitude surface inside the stress run.
 *   3. fund      — for each customer ATA, mintTo the per-customer
 *                  invoice total. Setup cost; not part of TPS.
 *   4. payments  — for each invoice, build a single tx with two
 *                  instructions: createAssociatedTokenAccountIdempotent
 *                  (target = invoice PDA ATA) + transferChecked
 *                  (customer → invoice ATA at the invoice amount).
 *                  Submitted concurrently up to STRESS_CONCURRENCY.
 *                  Each customer's writes serialize on its own ATA, so
 *                  effective parallelism = min(N customers,
 *                  concurrency).
 *   5. sweep     — Sweep batched STRESS_SWEEP_BATCH per tx, sequential
 *                  within a merchant (merchant PDA is writable per
 *                  call), parallel across merchants.
 *   6. cu_sample — getTransaction() over a strided sample of each
 *                  phase's signatures, decoding
 *                  meta.computeUnitsConsumed. Sampled (not exhaustive)
 *                  because devnet RPC throttles getTransaction at high
 *                  call rates.
 *   7. report    — emit a single JSON artifact: per-phase TPS, latency
 *                  percentiles (p50/p95/p99/max), per-instruction CU
 *                  stats, and a `bottlenecks[]` array summarizing what
 *                  this run hit. The artifact is the deliverable.
 *
 * Invocation:
 *
 *   npm run stress:devnet:z28-4
 *
 * Environment:
 *
 *   ZETTAPAY_PROGRAM_ID       on-chain program (default: declare_id! constant)
 *   SOLANA_RPC_URL            devnet endpoint (default: api.devnet.solana.com)
 *   SOLANA_KEYPAIR_PATH       deployer keypair (default: ~/.config/solana/id.json)
 *   STRESS_USDC_MINT          reuse an existing test mint
 *   STRESS_INVOICE_COUNT      total invoices (default 1000)
 *   STRESS_MERCHANT_COUNT     merchants (default 10; must divide STRESS_INVOICE_COUNT)
 *   STRESS_CONCURRENCY        max in-flight txs (default 25)
 *   STRESS_SWEEP_BATCH        invoice indexes per Sweep tx (default 5)
 *   STRESS_CU_SAMPLE_RATE     fetch CU for every Nth confirmed tx (default 10)
 *   STRESS_REPORT_PATH        output JSON report path (default ./stress-z28-4-report.json)
 *   STRESS_SKIP_AIRDROP       "1" to refuse devnet airdrop fallback
 *
 * Exit codes: 0 on full success, 1 if any tx-producing phase records
 * any failure or if a phase aborts. The report file is always written
 * (even on early abort) so the operator can triage without re-running.
 *
 * Premise alignment:
 *   • Premise 1 (Solana V1) + Premise 2 (USDC V1): chains=[SOLANA], currency=USDC
 *   • Premise 14 (no custody): every invoice keeps funds in its own PDA-owned ATA
 *   • Premise 26 (PR per mission): this script is the closing deliverable for Z28.4
 *   • Wallet-less hard rule: customers sign locally as raw Keypairs; no `.connect()`
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
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
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

const USDC_DECIMALS = 6;

const COMPUTE_UNIT_BUDGET = 200_000;

// 10-amount ladder spanning $0.50 → $500 so an encoder bug at any
// magnitude surfaces during stress.
const AMOUNT_CYCLE_USDC: readonly bigint[] = [
  500_000n,
  1_000_000n,
  5_000_000n,
  10_000_000n,
  25_000_000n,
  50_000_000n,
  100_000_000n,
  250_000_000n,
  500_000_000n,
  1_000_000n,
] as const;

// --- env loading ----------------------------------------------------------

interface StressConfig {
  rpcUrl: string;
  programId: PublicKey;
  payer: Keypair;
  mintOverride: PublicKey | null;
  invoiceCount: number;
  merchantCount: number;
  concurrency: number;
  sweepBatch: number;
  cuSampleRate: number;
  reportPath: string;
  skipAirdrop: boolean;
}

function loadConfig(): StressConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const programId = new PublicKey(process.env.ZETTAPAY_PROGRAM_ID ?? DEFAULT_PROGRAM_ID);

  const keypairPath =
    process.env.SOLANA_KEYPAIR_PATH ??
    resolve(homedir(), ".config", "solana", "id.json");
  const payer = loadKeypair(keypairPath);

  const mintOverrideStr = process.env.STRESS_USDC_MINT;
  const mintOverride = mintOverrideStr ? new PublicKey(mintOverrideStr) : null;

  const invoiceCount = parsePositiveInt("STRESS_INVOICE_COUNT", process.env.STRESS_INVOICE_COUNT, 1000);
  const merchantCount = parsePositiveInt("STRESS_MERCHANT_COUNT", process.env.STRESS_MERCHANT_COUNT, 10);
  if (invoiceCount % merchantCount !== 0) {
    throw new Error(
      `STRESS_INVOICE_COUNT (${invoiceCount}) must be divisible by STRESS_MERCHANT_COUNT (${merchantCount})`,
    );
  }
  const concurrency = parsePositiveInt("STRESS_CONCURRENCY", process.env.STRESS_CONCURRENCY, 25);
  const sweepBatch = parsePositiveInt("STRESS_SWEEP_BATCH", process.env.STRESS_SWEEP_BATCH, 5);
  const cuSampleRate = parsePositiveInt("STRESS_CU_SAMPLE_RATE", process.env.STRESS_CU_SAMPLE_RATE, 10);

  const reportPath =
    process.env.STRESS_REPORT_PATH ?? resolve(process.cwd(), "stress-z28-4-report.json");
  const skipAirdrop = process.env.STRESS_SKIP_AIRDROP === "1";

  return {
    rpcUrl,
    programId,
    payer,
    mintOverride,
    invoiceCount,
    merchantCount,
    concurrency,
    sweepBatch,
    cuSampleRate,
    reportPath,
    skipAirdrop,
  };
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}"`);
  }
  return n;
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
  return PublicKey.findProgramAddressSync([MERCHANT_SEED, master.toBuffer()], programId);
}

function deriveInvoicePda(
  master: PublicKey,
  invoiceIndex: bigint,
  programId: PublicKey,
): [PublicKey, number] {
  const idx = Buffer.alloc(INVOICE_INDEX_SEED_LEN);
  idx.writeBigUInt64LE(invoiceIndex, 0);
  return PublicKey.findProgramAddressSync([master.toBuffer(), idx], programId);
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
}): TransactionInstruction {
  const [merchantPda] = deriveMerchantPda(params.master, params.programId);
  const data = Buffer.concat([
    Buffer.from([TAG_REGISTER_MERCHANT]),
    encodeRegisterMerchantArgs(params.master, [CHAIN_SOLANA]),
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
}): TransactionInstruction {
  const [merchantPda] = deriveMerchantPda(params.master, params.programId);
  const [invoicePda] = deriveInvoicePda(params.master, params.invoiceIndex, params.programId);
  const data = Buffer.concat([
    Buffer.from([TAG_CREATE_INVOICE]),
    encodeCreateInvoiceArgs(params.amount, CURRENCY_USDC),
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
  return new TransactionInstruction({ programId: params.programId, keys, data });
}

// --- timing + concurrency helpers ----------------------------------------

interface TxResult {
  sig: string;
  durationMs: number;
  error: string | null;
}

async function timedSend(
  connection: Connection,
  payer: Keypair,
  signers: Keypair[],
  ixs: TransactionInstruction[],
): Promise<TxResult> {
  const t0 = Date.now();
  try {
    const tx = new Transaction().add(...ixs);
    const all = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
    const sig = await sendAndConfirmTransaction(connection, tx, all, { commitment: "confirmed" });
    return { sig, durationMs: Date.now() - t0, error: null };
  } catch (err) {
    return { sig: "", durationMs: Date.now() - t0, error: (err as Error).message };
  }
}

async function withConcurrency<T, R>(
  items: T[],
  maxInflight: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(maxInflight, items.length));
  for (let w = 0; w < n; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = cursor;
          cursor += 1;
          if (idx >= items.length) return;
          results[idx] = await worker(items[idx]!, idx);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// --- statistics -----------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx]!;
}

interface LatencyStats {
  count: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function summarizeLatency(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

// --- report shape ---------------------------------------------------------

interface PhaseMetrics {
  name: string;
  status: "ok" | "fail" | "skipped";
  durationMs: number;
  txCount: number;
  failedCount: number;
  tps: number;
  latencyMs: LatencyStats;
  errorSamples: string[];
}

interface CuStats {
  instruction: string;
  phase: string;
  sampleSize: number;
  cuMin: number;
  cuP50: number;
  cuP95: number;
  cuMax: number;
  cuAvg: number;
  budgetHeadroomPctP95: number;
}

interface StressReport {
  mission: string;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number | null;
  rpcUrl: string;
  programId: string;
  mint: string | null;
  payer: string;
  invoiceCount: number;
  merchantCount: number;
  concurrency: number;
  sweepBatchSize: number;
  cuSampleRate: number;
  expectedTotalUsdcBaseUnits: string;
  phases: PhaseMetrics[];
  cuByInstruction: CuStats[];
  bottlenecks: string[];
  outcome: "success" | "failed";
}

function emptyPhase(name: string): PhaseMetrics {
  return {
    name,
    status: "ok",
    durationMs: 0,
    txCount: 0,
    failedCount: 0,
    tps: 0,
    latencyMs: summarizeLatency([]),
    errorSamples: [],
  };
}

function recordPhase(
  phase: PhaseMetrics,
  results: TxResult[],
  startedAt: number,
): { successSigs: string[]; latenciesMs: number[] } {
  const successSigs: string[] = [];
  const latenciesMs: number[] = [];
  for (const r of results) {
    if (r.error === null) {
      successSigs.push(r.sig);
      latenciesMs.push(r.durationMs);
    } else {
      phase.failedCount += 1;
      if (phase.errorSamples.length < 5) phase.errorSamples.push(r.error);
    }
  }
  phase.txCount = results.length;
  phase.durationMs = Date.now() - startedAt;
  phase.latencyMs = summarizeLatency(latenciesMs);
  phase.tps = phase.durationMs > 0 ? Number(((successSigs.length * 1000) / phase.durationMs).toFixed(2)) : 0;
  if (phase.failedCount > 0 && phase.failedCount === phase.txCount) {
    phase.status = "fail";
  }
  return { successSigs, latenciesMs };
}

// --- helpers --------------------------------------------------------------

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function header(title: string): void {
  log(`\n==> ${title}`);
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

async function sampleComputeUnits(
  connection: Connection,
  instructionLabel: string,
  phaseName: string,
  sigs: string[],
  sampleRate: number,
): Promise<CuStats> {
  if (sigs.length === 0) {
    return {
      instruction: instructionLabel,
      phase: phaseName,
      sampleSize: 0,
      cuMin: 0,
      cuP50: 0,
      cuP95: 0,
      cuMax: 0,
      cuAvg: 0,
      budgetHeadroomPctP95: 100,
    };
  }
  const cus: number[] = [];
  for (let i = 0; i < sigs.length; i += sampleRate) {
    const sig = sigs[i]!;
    try {
      const tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const cu = tx?.meta?.computeUnitsConsumed;
      if (typeof cu === "number") cus.push(cu);
    } catch {
      // Sampling is best-effort; missing samples don't fail the run.
    }
  }
  if (cus.length === 0) {
    return {
      instruction: instructionLabel,
      phase: phaseName,
      sampleSize: 0,
      cuMin: 0,
      cuP50: 0,
      cuP95: 0,
      cuMax: 0,
      cuAvg: 0,
      budgetHeadroomPctP95: 100,
    };
  }
  const sorted = [...cus].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const cuP95 = percentile(sorted, 95);
  return {
    instruction: instructionLabel,
    phase: phaseName,
    sampleSize: cus.length,
    cuMin: sorted[0]!,
    cuP50: percentile(sorted, 50),
    cuP95,
    cuMax: sorted[sorted.length - 1]!,
    cuAvg: Math.round(sum / cus.length),
    budgetHeadroomPctP95: Number(
      (((COMPUTE_UNIT_BUDGET - cuP95) / COMPUTE_UNIT_BUDGET) * 100).toFixed(1),
    ),
  };
}

function detectBottlenecks(report: StressReport): string[] {
  const out: string[] = [];
  for (const p of report.phases) {
    if (p.status === "fail") out.push(`phase_failed:${p.name}`);
    if (p.failedCount > 0) {
      const failurePct = (p.failedCount / Math.max(p.txCount, 1)) * 100;
      out.push(`tx_failures:${p.name}:${p.failedCount}/${p.txCount} (${failurePct.toFixed(1)}%)`);
    }
    if (p.txCount >= 50 && p.tps < 1) {
      out.push(`low_tps:${p.name}:${p.tps}/s`);
    }
    if (p.latencyMs.p95 > 30_000) {
      out.push(`slow_confirm:${p.name}:p95=${p.latencyMs.p95}ms`);
    }
    const errorBlob = p.errorSamples.join(" ").toLowerCase();
    if (/429|rate|too many/.test(errorBlob)) out.push(`rate_limit:${p.name}`);
    if (/blockhash|expired/.test(errorBlob)) out.push(`blockhash_expiry:${p.name}`);
  }
  for (const cu of report.cuByInstruction) {
    if (cu.sampleSize === 0) continue;
    if (cu.cuP95 > COMPUTE_UNIT_BUDGET * 0.9) {
      out.push(`compute_budget_pressure:${cu.instruction}:p95=${cu.cuP95}/${COMPUTE_UNIT_BUDGET}`);
    }
  }
  if (out.length === 0) out.push("none_observed");
  return out;
}

function writeReport(cfg: StressConfig, report: StressReport): void {
  writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2), "utf8");
  log(`    report → ${cfg.reportPath}`);
}

// --- main flow ------------------------------------------------------------

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const cfg = loadConfig();
  const invoicesPerMerchant = cfg.invoiceCount / cfg.merchantCount;

  const report: StressReport = {
    mission: "Z28.4 — devnet stress test",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    durationSec: null,
    rpcUrl: cfg.rpcUrl,
    programId: cfg.programId.toBase58(),
    mint: null,
    payer: cfg.payer.publicKey.toBase58(),
    invoiceCount: cfg.invoiceCount,
    merchantCount: cfg.merchantCount,
    concurrency: cfg.concurrency,
    sweepBatchSize: cfg.sweepBatch,
    cuSampleRate: cfg.cuSampleRate,
    expectedTotalUsdcBaseUnits: "0",
    phases: [],
    cuByInstruction: [],
    bottlenecks: [],
    outcome: "failed",
  };

  log(`==> Z28.4 stress — ${cfg.merchantCount} merchants × ${invoicesPerMerchant} invoices = ${cfg.invoiceCount}`);
  log(`    rpc:          ${cfg.rpcUrl}`);
  log(`    program:      ${cfg.programId.toBase58()}`);
  log(`    payer:        ${cfg.payer.publicKey.toBase58()}`);
  log(`    concurrency:  ${cfg.concurrency} in flight`);
  log(`    sweep batch:  ${cfg.sweepBatch} indexes/tx`);
  log(`    cu sample:    every ${cfg.cuSampleRate}th tx`);

  const connection = new Connection(cfg.rpcUrl, "confirmed");

  // --- Phase 0: Setup ---------------------------------------------------
  let mint: PublicKey | null = null;
  const masters: Keypair[] = [];
  const customers: Keypair[] = [];
  const phase0 = emptyPhase("Phase 0 — Setup");
  report.phases.push(phase0);
  const phase0t0 = Date.now();
  header(phase0.name);
  try {
    await assertProgramDeployed(connection, cfg.programId);
    // Conservative SOL floor: 1000 invoice rent + 1000 payment fees +
    // ATA rent + sweep fees. 8 SOL keeps headroom on devnet.
    await ensurePayerFunded(connection, cfg.payer.publicKey, 8 * LAMPORTS_PER_SOL, cfg.skipAirdrop);

    for (let m = 0; m < cfg.merchantCount; m += 1) {
      masters.push(Keypair.generate());
      customers.push(Keypair.generate());
    }
    log(`    generated ${cfg.merchantCount} merchant masters + ${cfg.merchantCount} customers`);

    if (cfg.mintOverride !== null) {
      mint = cfg.mintOverride;
      log(`    reusing mint: ${mint.toBase58()}`);
    } else {
      mint = await createMint(connection, cfg.payer, cfg.payer.publicKey, null, USDC_DECIMALS);
      log(`    fresh test mint: ${mint.toBase58()}`);
    }
    report.mint = mint.toBase58();
    phase0.durationMs = Date.now() - phase0t0;
    log(`    Phase 0 ok (${phase0.durationMs}ms)`);
  } catch (err) {
    phase0.status = "fail";
    phase0.errorSamples.push((err as Error).message);
    phase0.durationMs = Date.now() - phase0t0;
    log(`    Phase 0 FAIL: ${(err as Error).message}`);
    report.bottlenecks = detectBottlenecks(report);
    writeReport(cfg, report);
    process.exit(1);
  }

  if (mint === null) throw new Error("Phase 0 finished without setting mint");
  const mintFinal: PublicKey = mint;

  // Per-invoice plan: which merchant + index it belongs to.
  interface InvoicePlan {
    merchantIdx: number;
    invoiceIndex: bigint;
    amount: bigint;
  }
  const invoicePlans: InvoicePlan[] = [];
  let expectedTotal = 0n;
  for (let m = 0; m < cfg.merchantCount; m += 1) {
    for (let j = 0; j < invoicesPerMerchant; j += 1) {
      const amount = AMOUNT_CYCLE_USDC[j % AMOUNT_CYCLE_USDC.length]!;
      invoicePlans.push({ merchantIdx: m, invoiceIndex: BigInt(j), amount });
      expectedTotal += amount;
    }
  }
  report.expectedTotalUsdcBaseUnits = expectedTotal.toString();

  // --- Phase 1: Register merchants (sequential) -------------------------
  const phase1 = emptyPhase(`Phase 1 — RegisterMerchant ×${cfg.merchantCount}`);
  report.phases.push(phase1);
  const phase1t0 = Date.now();
  header(phase1.name);
  const registerSigs: string[] = [];
  try {
    const results: TxResult[] = [];
    for (let m = 0; m < cfg.merchantCount; m += 1) {
      const master = masters[m]!;
      const r = await timedSend(
        connection,
        cfg.payer,
        [master],
        [
          ixRegisterMerchant({
            programId: cfg.programId,
            master: master.publicKey,
            payer: cfg.payer.publicKey,
          }),
        ],
      );
      results.push(r);
      if (r.error !== null) {
        log(`    register[${m}] FAIL: ${r.error}`);
      }
    }
    const summary = recordPhase(phase1, results, phase1t0);
    registerSigs.push(...summary.successSigs);
    log(
      `    Phase 1 ${phase1.status} (${phase1.txCount} tx, ${phase1.failedCount} fail, ${phase1.durationMs}ms, tps=${phase1.tps})`,
    );
    if (phase1.failedCount === phase1.txCount) {
      throw new Error("all RegisterMerchant txs failed");
    }
  } catch (err) {
    phase1.status = "fail";
    phase1.errorSamples.push((err as Error).message);
    report.bottlenecks = detectBottlenecks(report);
    writeReport(cfg, report);
    process.exit(1);
  }

  // --- Phase 2: Create invoices (concurrent, round-robin) ---------------
  const phase2 = emptyPhase(`Phase 2 — CreateInvoice ×${cfg.invoiceCount}`);
  report.phases.push(phase2);
  const phase2t0 = Date.now();
  header(phase2.name);
  const createdInvoiceSigs: string[] = [];
  // Track which invoice plans actually succeeded so payment phase can
  // skip phantom invoices.
  const invoiceCreated: boolean[] = new Array(invoicePlans.length).fill(false);
  try {
    const results = await withConcurrency(invoicePlans, cfg.concurrency, async (plan, idx) => {
      const master = masters[plan.merchantIdx]!;
      return timedSend(
        connection,
        cfg.payer,
        [master],
        [
          ixCreateInvoice({
            programId: cfg.programId,
            master: master.publicKey,
            payer: cfg.payer.publicKey,
            invoiceIndex: plan.invoiceIndex,
            amount: plan.amount,
          }),
        ],
      ).then((r) => {
        if (r.error === null) invoiceCreated[idx] = true;
        return r;
      });
    });
    const summary = recordPhase(phase2, results, phase2t0);
    createdInvoiceSigs.push(...summary.successSigs);
    log(
      `    Phase 2 ${phase2.status} (${phase2.txCount} tx, ${phase2.failedCount} fail, ${phase2.durationMs}ms, tps=${phase2.tps}, p95=${phase2.latencyMs.p95}ms)`,
    );
  } catch (err) {
    phase2.status = "fail";
    phase2.errorSamples.push((err as Error).message);
  }

  // --- Phase 3: Fund customers ------------------------------------------
  const phase3 = emptyPhase(`Phase 3 — Fund customers ×${cfg.merchantCount}`);
  report.phases.push(phase3);
  const phase3t0 = Date.now();
  header(phase3.name);
  // Per-customer USDC totals (sum of their merchant's created-invoice amounts)
  const customerTotals: bigint[] = new Array(cfg.merchantCount).fill(0n);
  for (let i = 0; i < invoicePlans.length; i += 1) {
    if (invoiceCreated[i]) customerTotals[invoicePlans[i]!.merchantIdx]! += invoicePlans[i]!.amount;
  }
  const customerAtas: PublicKey[] = new Array(cfg.merchantCount);
  try {
    for (let m = 0; m < cfg.merchantCount; m += 1) {
      const customer = customers[m]!;
      const ata = await createAssociatedTokenAccountIdempotent(
        connection,
        cfg.payer,
        mintFinal,
        customer.publicKey,
      );
      customerAtas[m] = ata;
      const total = customerTotals[m]!;
      if (total > 0n) {
        await mintTo(connection, cfg.payer, mintFinal, ata, cfg.payer, total);
      }
    }
    phase3.txCount = cfg.merchantCount * 2;
    phase3.durationMs = Date.now() - phase3t0;
    phase3.tps = phase3.durationMs > 0 ? Number(((phase3.txCount * 1000) / phase3.durationMs).toFixed(2)) : 0;
    log(`    Phase 3 ok (${phase3.txCount} setup tx, ${phase3.durationMs}ms)`);
  } catch (err) {
    phase3.status = "fail";
    phase3.errorSamples.push((err as Error).message);
    phase3.durationMs = Date.now() - phase3t0;
    log(`    Phase 3 FAIL: ${(err as Error).message}`);
  }

  // --- Phase 4: Payments (concurrent) -----------------------------------
  const phase4 = emptyPhase(`Phase 4 — transferChecked ×${cfg.invoiceCount}`);
  report.phases.push(phase4);
  const phase4t0 = Date.now();
  header(phase4.name);
  const paymentSigs: string[] = [];
  const invoicePaid: boolean[] = new Array(invoicePlans.length).fill(false);
  try {
    const results = await withConcurrency(invoicePlans, cfg.concurrency, async (plan, idx) => {
      if (!invoiceCreated[idx]) {
        return { sig: "", durationMs: 0, error: "skipped: invoice not created" };
      }
      const customer = customers[plan.merchantIdx]!;
      const customerAta = customerAtas[plan.merchantIdx]!;
      const master = masters[plan.merchantIdx]!;
      const [invoicePda] = deriveInvoicePda(master.publicKey, plan.invoiceIndex, cfg.programId);
      const invoiceAta = getAssociatedTokenAddressSync(
        mintFinal,
        invoicePda,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        cfg.payer.publicKey,
        invoiceAta,
        invoicePda,
        mintFinal,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const payIx = createTransferCheckedInstruction(
        customerAta,
        mintFinal,
        invoiceAta,
        customer.publicKey,
        plan.amount,
        USDC_DECIMALS,
      );
      const r = await timedSend(connection, cfg.payer, [customer], [ataIx, payIx]);
      if (r.error === null) invoicePaid[idx] = true;
      return r;
    });
    const summary = recordPhase(phase4, results, phase4t0);
    paymentSigs.push(...summary.successSigs);
    log(
      `    Phase 4 ${phase4.status} (${phase4.txCount} tx, ${phase4.failedCount} fail, ${phase4.durationMs}ms, tps=${phase4.tps}, p95=${phase4.latencyMs.p95}ms)`,
    );
  } catch (err) {
    phase4.status = "fail";
    phase4.errorSamples.push((err as Error).message);
  }

  // --- Phase 5: Sweep (batched per merchant, parallel across merchants)
  const sweepBatchTotal = cfg.merchantCount * Math.ceil(invoicesPerMerchant / cfg.sweepBatch);
  const phase5 = emptyPhase(`Phase 5 — Sweep ×${sweepBatchTotal}`);
  report.phases.push(phase5);
  const phase5t0 = Date.now();
  header(phase5.name);
  const sweepSigs: string[] = [];
  try {
    interface SweepJob {
      merchantIdx: number;
      indexes: bigint[];
    }
    const jobs: SweepJob[] = [];
    for (let m = 0; m < cfg.merchantCount; m += 1) {
      for (let start = 0; start < invoicesPerMerchant; start += cfg.sweepBatch) {
        const end = Math.min(start + cfg.sweepBatch, invoicesPerMerchant);
        const indexes: bigint[] = [];
        for (let j = start; j < end; j += 1) {
          // Skip indexes whose payment failed; sweeping an unpaid invoice
          // surfaces the on-chain "no funds" error and would inflate the
          // failure count without adding signal.
          const planIdx = m * invoicesPerMerchant + j;
          if (invoicePaid[planIdx]) indexes.push(BigInt(j));
        }
        if (indexes.length > 0) jobs.push({ merchantIdx: m, indexes });
      }
    }

    // Per-merchant queue: serialize sweeps within a merchant (merchant
    // PDA writable), but allow merchants to sweep in parallel.
    const perMerchant: SweepJob[][] = Array.from({ length: cfg.merchantCount }, () => []);
    for (const job of jobs) perMerchant[job.merchantIdx]!.push(job);

    const merchantWorkers = perMerchant.map((queue, m) =>
      (async (): Promise<TxResult[]> => {
        const out: TxResult[] = [];
        const master = masters[m]!;
        for (const job of queue) {
          const r = await timedSend(
            connection,
            cfg.payer,
            [master],
            [
              ixSweep({
                programId: cfg.programId,
                master: master.publicKey,
                invoiceIndexes: job.indexes,
              }),
            ],
          );
          out.push(r);
        }
        return out;
      })(),
    );
    const allResults = (await Promise.all(merchantWorkers)).flat();
    const summary = recordPhase(phase5, allResults, phase5t0);
    sweepSigs.push(...summary.successSigs);
    log(
      `    Phase 5 ${phase5.status} (${phase5.txCount} tx, ${phase5.failedCount} fail, ${phase5.durationMs}ms, tps=${phase5.tps}, p95=${phase5.latencyMs.p95}ms)`,
    );
  } catch (err) {
    phase5.status = "fail";
    phase5.errorSamples.push((err as Error).message);
  }

  // --- Phase 6: CU sampling ---------------------------------------------
  const phase6 = emptyPhase("Phase 6 — CU sampling");
  report.phases.push(phase6);
  const phase6t0 = Date.now();
  header(phase6.name);
  try {
    const cuStats: CuStats[] = [];
    cuStats.push(
      await sampleComputeUnits(connection, "RegisterMerchant", phase1.name, registerSigs, 1),
    );
    cuStats.push(
      await sampleComputeUnits(connection, "CreateInvoice", phase2.name, createdInvoiceSigs, cfg.cuSampleRate),
    );
    cuStats.push(
      await sampleComputeUnits(
        connection,
        "transferChecked+createATAIdempotent",
        phase4.name,
        paymentSigs,
        cfg.cuSampleRate,
      ),
    );
    cuStats.push(await sampleComputeUnits(connection, "Sweep", phase5.name, sweepSigs, cfg.cuSampleRate));
    report.cuByInstruction = cuStats;
    phase6.txCount = cuStats.reduce((acc, s) => acc + s.sampleSize, 0);
    phase6.durationMs = Date.now() - phase6t0;
    log(`    Phase 6 ok (${phase6.txCount} samples, ${phase6.durationMs}ms)`);
    for (const s of cuStats) {
      log(
        `      ${s.instruction.padEnd(40)} samples=${s.sampleSize.toString().padStart(4)} cu min=${s.cuMin} p50=${s.cuP50} p95=${s.cuP95} max=${s.cuMax} headroom@p95=${s.budgetHeadroomPctP95}%`,
      );
    }
  } catch (err) {
    phase6.status = "fail";
    phase6.errorSamples.push((err as Error).message);
    phase6.durationMs = Date.now() - phase6t0;
    log(`    Phase 6 FAIL: ${(err as Error).message}`);
  }

  // --- Finalize ---------------------------------------------------------
  report.bottlenecks = detectBottlenecks(report);
  report.finishedAt = new Date().toISOString();
  report.durationSec = Number(((Date.now() - startedAtMs) / 1000).toFixed(1));

  const anyTxPhaseFailed = [phase2, phase4, phase5].some(
    (p) => p.status === "fail" || p.failedCount > 0,
  );
  report.outcome = anyTxPhaseFailed ? "failed" : "success";

  writeReport(cfg, report);

  header(`${report.outcome.toUpperCase()} in ${report.durationSec}s`);
  log(`    invoices created: ${createdInvoiceSigs.length}/${cfg.invoiceCount}`);
  log(`    payments settled: ${paymentSigs.length}/${cfg.invoiceCount}`);
  log(`    sweep txs:        ${sweepSigs.length}`);
  log(`    bottlenecks:      ${report.bottlenecks.join(", ")}`);
  log(`    report path:      ${cfg.reportPath}`);

  process.exit(report.outcome === "success" ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n==> FAIL: ${(err as Error).message}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
