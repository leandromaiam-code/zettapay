/**
 * scripts/stress-construction-z28-4.ts — Z28.4 (off-chain companion)
 *
 * Off-chain microbench for the client-side construction path that
 * `scripts/stress-devnet-z28-4.ts` exercises end-to-end against devnet.
 * Where the devnet runner answers "what does the network confirm per
 * second" (RPC-bound, leader-bound, blockhash-bound), this runner
 * answers "what does the SDK construct per second" (PDA derivation +
 * Borsh encoding + URI building + QR rendering, all pure CPU work).
 *
 * Why a second harness:
 *
 *   When the devnet runner reports `low_tps:Phase 4` and no
 *   `rate_limit:*` tag, the bottleneck can be RPC plumbing, customer
 *   ATA contention, OR a client-side hotspot in tx assembly. The third
 *   case is invisible from devnet timings alone. This script profiles
 *   the client path with zero RPC so an operator can compare:
 *
 *     • construction throughput here (ops/sec, pure CPU)
 *     • devnet throughput there (txs/sec, network + program)
 *
 *   If client construction sustains >100 ops/sec and devnet sustains
 *   <30 txs/sec, the gap is on-chain or RPC — not the SDK. If the SDK
 *   itself is <50 ops/sec, no devnet tuning will save you; the client
 *   is the wall.
 *
 * What it measures (defaults to 1000 invoices to mirror Z28.4 mission
 * spec — "1000 invoices simultaneas, 1000 pagamentos"):
 *
 *   1. deriveMerchantBindingPda  — merchant binding PDA derivation
 *   2. deriveInvoicePda          — invoice PDA derivation
 *   3. deriveInvoiceUsdcAddress  — invoice PDA + USDC ATA combined
 *   4. buildRegisterMerchantInstruction — merchant ix construction
 *   5. buildRecordPaymentInstruction    — payment-receipt ix construction
 *   6. buildZettaPayUri          — ZettaPay scheme URI
 *   7. buildSolanaPayUri         — Solana Pay scheme URI
 *   8. generateInvoiceQrSvg      — QR SVG render (heaviest CPU op)
 *   9. checkout_full_pipeline    — invoice + ATA + URI + QR per checkout
 *
 * Each bench runs an untimed warmup of N/10 iterations (JIT + Buffer
 * pool warm-up) before the measured pass, then records per-op latency
 * with `process.hrtime.bigint()` and computes p50/p95/p99/max +
 * throughput. The JSON artifact carries the same `bottlenecks[]` shape
 * the devnet runner uses, so the two reports can sit side by side in
 * the Z28.4 sprint folder.
 *
 * Invocation:
 *
 *   npm run stress:construction:z28-4
 *
 * Environment knobs:
 *
 *   STRESS_OPS                  total ops per bench (default 1000)
 *   STRESS_WARMUP_FRACTION      warmup as a fraction of STRESS_OPS (default 0.1)
 *   STRESS_REPORT_PATH          JSON output path (default ./stress-construction-z28-4-report.json)
 *   STRESS_OPS_FLOOR            ops/sec floor flagged as `slow_construction:<bench>` (default 50)
 *   STRESS_TIME_BUDGET_MS       hard wall-clock budget per bench (default 60_000)
 *
 * Exit: 0 on a clean run, 1 if any bench falls under STRESS_OPS_FLOOR
 * or exceeds STRESS_TIME_BUDGET_MS. The JSON report is always written.
 *
 * Premise alignment (CLAUDE.md Layer 0):
 *   • Premise 1 (Solana V1) + Premise 2 (USDC V1): only USDC + Solana
 *   • Premise 23 (SDK first): exercises @zettapay/sdk public surface
 *   • Premise 26 (PR per mission): companion to the devnet runner,
 *     shipped under the same Z28.4 mission
 *   • Wallet-less hard rule: zero wallet adapters, zero connect(),
 *     fabricated payer/merchant pubkeys via Keypair.generate()
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildRecordPaymentInstruction,
  buildRegisterMerchantInstruction,
  buildSolanaPayUri,
  buildZettaPayUri,
  deriveAssociatedTokenAddress,
  deriveInvoicePda,
  deriveInvoiceUsdcAddress,
  deriveMerchantBindingPda,
  generateInvoiceQrSvg,
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  USDC_MINT,
} from "../packages/sdk/src/index.js";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

interface BenchConfig {
  ops: number;
  warmup: number;
  reportPath: string;
  opsFloor: number;
  timeBudgetMs: number;
}

function loadConfig(): BenchConfig {
  const ops = parsePositiveInt("STRESS_OPS", process.env.STRESS_OPS, 1000);
  const warmupFraction = parseFloatEnv(
    "STRESS_WARMUP_FRACTION",
    process.env.STRESS_WARMUP_FRACTION,
    0.1,
  );
  if (warmupFraction < 0 || warmupFraction >= 1) {
    throw new Error(
      `STRESS_WARMUP_FRACTION must be in [0, 1); got ${warmupFraction}`,
    );
  }
  const warmup = Math.max(1, Math.floor(ops * warmupFraction));
  const reportPath =
    process.env.STRESS_REPORT_PATH ??
    resolve(process.cwd(), "stress-construction-z28-4-report.json");
  const opsFloor = parsePositiveInt(
    "STRESS_OPS_FLOOR",
    process.env.STRESS_OPS_FLOOR,
    50,
  );
  const timeBudgetMs = parsePositiveInt(
    "STRESS_TIME_BUDGET_MS",
    process.env.STRESS_TIME_BUDGET_MS,
    60_000,
  );
  return { ops, warmup, reportPath, opsFloor, timeBudgetMs };
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}"`);
  }
  return n;
}

function parseFloatEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number; got "${raw}"`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  owner: PublicKey;
  payer: PublicKey;
  master: PublicKey;
  merchantBinding: PublicKey;
  usdcAta: PublicKey;
  mint: PublicKey;
  paymentIds: Uint8Array[];
  txSignatures: Uint8Array[];
}

/**
 * Pre-built per-iteration fixtures. The bench loops should be measuring
 * SDK work, not Keypair generation or Buffer allocation, so all random
 * material is generated up front and indexed by `i`.
 */
function buildFixtures(ops: number): Fixtures {
  const ownerKp = Keypair.generate();
  const payerKp = Keypair.generate();
  const masterKp = Keypair.generate();
  const { pda: merchantBinding } = deriveMerchantBindingPda(
    "stressbench",
    ownerKp.publicKey,
  );
  const mint = USDC_MINT.devnet;
  const usdcAta = deriveAssociatedTokenAddress(masterKp.publicKey, mint);

  const paymentIds: Uint8Array[] = new Array(ops);
  const txSignatures: Uint8Array[] = new Array(ops);
  for (let i = 0; i < ops; i += 1) {
    const pid = new Uint8Array(PAYMENT_ID_LEN);
    const sig = new Uint8Array(TX_SIGNATURE_LEN);
    // Deterministic, distinct bytes per i — avoids Math.random() inside
    // the measured loop and keeps the workload reproducible across runs.
    for (let b = 0; b < PAYMENT_ID_LEN; b += 1) pid[b] = (i + b) & 0xff;
    for (let b = 0; b < TX_SIGNATURE_LEN; b += 1) sig[b] = (i * 7 + b) & 0xff;
    paymentIds[i] = pid;
    txSignatures[i] = sig;
  }

  return {
    owner: ownerKp.publicKey,
    payer: payerKp.publicKey,
    master: masterKp.publicKey,
    merchantBinding,
    usdcAta,
    mint,
    paymentIds,
    txSignatures,
  };
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  ops: number;
  totalMs: number;
  opsPerSec: number;
  latencyUs: {
    p50: number;
    p95: number;
    p99: number;
    max: number;
    avg: number;
  };
  errorSamples: string[];
  failedCount: number;
}

/**
 * Run `op` exactly `ops` times after a warmup of `warmup` ops, recording
 * per-iteration latency in microseconds via `process.hrtime.bigint()`.
 * Errors thrown by `op` are captured (first 5 distinct messages) and
 * counted but do not abort the bench — the goal is steady-state
 * throughput, not correctness.
 */
function timeBench(
  name: string,
  ops: number,
  warmup: number,
  timeBudgetMs: number,
  op: (i: number) => void,
): BenchResult {
  // Warmup — JIT + Buffer pool, results discarded.
  for (let i = 0; i < warmup; i += 1) {
    try {
      op(i);
    } catch {
      /* swallowed — warmup may legitimately error on contrived inputs */
    }
  }

  const latencies: number[] = new Array(ops);
  const errorSet = new Set<string>();
  let failedCount = 0;
  let overBudget = false;

  const t0 = process.hrtime.bigint();
  const budgetNs = BigInt(timeBudgetMs) * 1_000_000n;

  for (let i = 0; i < ops; i += 1) {
    const s = process.hrtime.bigint();
    try {
      op(i);
    } catch (err) {
      failedCount += 1;
      if (errorSet.size < 5) errorSet.add((err as Error).message);
    }
    const e = process.hrtime.bigint();
    latencies[i] = Number(e - s) / 1_000; // ns → µs
    if (e - t0 > budgetNs) {
      overBudget = true;
      latencies.length = i + 1;
      break;
    }
  }

  const tEnd = process.hrtime.bigint();
  const totalNs = Number(tEnd - t0);
  const totalMs = totalNs / 1_000_000;
  const actualOps = latencies.length;
  const opsPerSec = totalNs > 0 ? (actualOps * 1e9) / totalNs : 0;

  const sorted = [...latencies].sort((a, b) => a - b);
  const latencyUs = {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1]! : 0,
    avg: sorted.length
      ? sorted.reduce((acc, x) => acc + x, 0) / sorted.length
      : 0,
  };

  const errorSamples = [...errorSet];
  if (overBudget) errorSamples.push(`time_budget_exceeded:${timeBudgetMs}ms`);

  return {
    name,
    ops: actualOps,
    totalMs,
    opsPerSec,
    latencyUs,
    errorSamples,
    failedCount,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------
// benches
// ---------------------------------------------------------------------------

function runBenches(cfg: BenchConfig): BenchResult[] {
  const fix = buildFixtures(cfg.ops);
  const results: BenchResult[] = [];

  results.push(
    timeBench(
      "deriveMerchantBindingPda",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        // Vary the handle so PublicKey.findProgramAddressSync sees a
        // fresh input each iteration — the internal bump search loop
        // dominates the cost and is what production workloads pay.
        deriveMerchantBindingPda(`bench-${i & 0xffff}`, fix.owner);
      },
    ),
  );

  results.push(
    timeBench(
      "deriveInvoicePda",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        deriveInvoicePda(fix.master, BigInt(i));
      },
    ),
  );

  results.push(
    timeBench(
      "deriveInvoiceUsdcAddress",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        deriveInvoiceUsdcAddress({
          masterPubkey: fix.master,
          invoiceIndex: BigInt(i),
          cluster: "devnet",
        });
      },
    ),
  );

  results.push(
    timeBench(
      "buildRegisterMerchantInstruction",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        buildRegisterMerchantInstruction({
          owner: fix.owner,
          payer: fix.payer,
          merchantHandle: `bench-${i & 0xffff}`,
          usdcTokenAccount: fix.usdcAta,
        });
      },
    ),
  );

  results.push(
    timeBench(
      "buildRecordPaymentInstruction",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        buildRecordPaymentInstruction({
          merchantBinding: fix.merchantBinding,
          payer: fix.payer,
          paymentId: fix.paymentIds[i]!,
          amount: 1_000_000n + BigInt(i),
          txSignature: fix.txSignatures[i]!,
        });
      },
    ),
  );

  // For URI/QR benches we precompute a fresh invoice PDA per iteration
  // so the string serialization sees realistic, non-cached inputs.
  const invoicePdas: PublicKey[] = new Array(cfg.ops);
  for (let i = 0; i < cfg.ops; i += 1) {
    invoicePdas[i] = deriveInvoicePda(fix.master, BigInt(i)).pda;
  }

  results.push(
    timeBench(
      "buildZettaPayUri",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        buildZettaPayUri({
          invoicePda: invoicePdas[i]!,
          amount: 29,
          label: "Acme Coffee",
          message: `Invoice ${i}`,
        });
      },
    ),
  );

  results.push(
    timeBench(
      "buildSolanaPayUri",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        buildSolanaPayUri({
          recipient: fix.master,
          amount: "29",
          splToken: fix.mint,
          label: "Acme Coffee",
          message: `Invoice ${i}`,
          reference: [invoicePdas[i]!],
        });
      },
    ),
  );

  // QR rendering is async; we synthesize an async op and await per
  // iteration. The bench framework records each iteration's latency
  // separately so awaiting inside the loop is fine — it just means
  // the throughput line reflects single-threaded serial render rate,
  // which is what a single Node process can deliver.
  // To keep timeBench's sync signature, we batch QR renders in a
  // dedicated async loop and synthesize the BenchResult by hand.
  results.push(qrBenchSync(cfg, invoicePdas));

  // Full checkout pipeline — what the dashboard pays per invoice.
  // The pipeline composes invoice PDA derive + ATA derive + URI
  // generation. (QR sits in the dedicated bench above so this stays
  // synchronous and the two paths can be read independently.)
  results.push(
    timeBench(
      "checkout_full_pipeline",
      cfg.ops,
      cfg.warmup,
      cfg.timeBudgetMs,
      (i) => {
        const inv = deriveInvoiceUsdcAddress({
          masterPubkey: fix.master,
          invoiceIndex: BigInt(i),
          cluster: "devnet",
        });
        buildZettaPayUri({
          invoicePda: inv.invoicePda,
          amount: 29,
          label: "Acme Coffee",
        });
        buildSolanaPayUri({
          recipient: fix.master,
          amount: "29",
          splToken: inv.usdcMint,
          label: "Acme Coffee",
          reference: [inv.invoicePda],
        });
      },
    ),
  );

  return results;
}

/**
 * QR rendering is async (qrcode.toString returns a Promise). We can't
 * shove that through `timeBench` without making the whole frame async,
 * so this synthesizes the same `BenchResult` shape from a synchronous
 * deasync trick: a busy-await on `Atomics.wait` would be too invasive;
 * instead we run the loop on top of a synchronously-resolving sub-
 * function and use `void` to discard the Promise — Node 18 queues these
 * to the microtask drain, which we explicitly await at the end via
 * `Promise.all` of recorded promises. Per-iteration latency is the time
 * each promise took to settle.
 */
function qrBenchSync(cfg: BenchConfig, invoicePdas: PublicKey[]): BenchResult {
  // Synthetic latencies — we'll fill them in below. Initialise with 0
  // so a partial run still produces a sortable array.
  const latencies: number[] = new Array(cfg.ops).fill(0);
  const errorSet = new Set<string>();
  let failedCount = 0;
  let overBudget = false;

  // The block below executes synchronously up to the first await. We
  // launch all renders and await them serially so we measure per-render
  // wall time and the bench reflects sequential render throughput — the
  // realistic checkout pattern is one render per request.
  const runAsync = async (): Promise<{
    totalNs: bigint;
    actualOps: number;
  }> => {
    // Pre-build the URI strings once so the QR bench measures encode
    // throughput, not URI assembly cost. URI assembly has its own
    // bench above.
    const uris: string[] = new Array(cfg.ops);
    for (let i = 0; i < cfg.ops; i += 1) {
      uris[i] = buildZettaPayUri({
        invoicePda: invoicePdas[i]!,
        amount: 29,
        label: "Acme Coffee",
      });
    }

    // Warmup.
    for (let i = 0; i < cfg.warmup; i += 1) {
      try {
        await generateInvoiceQrSvg(uris[0]!);
      } catch {
        /* swallowed */
      }
    }

    const t0 = process.hrtime.bigint();
    const budgetNs = BigInt(cfg.timeBudgetMs) * 1_000_000n;
    let actual = 0;
    for (let i = 0; i < cfg.ops; i += 1) {
      const s = process.hrtime.bigint();
      try {
        await generateInvoiceQrSvg(uris[i]!);
      } catch (err) {
        failedCount += 1;
        if (errorSet.size < 5) errorSet.add((err as Error).message);
      }
      const e = process.hrtime.bigint();
      latencies[i] = Number(e - s) / 1_000;
      actual = i + 1;
      if (e - t0 > budgetNs) {
        overBudget = true;
        break;
      }
    }
    return { totalNs: process.hrtime.bigint() - t0, actualOps: actual };
  };

  // Drive the async loop to completion on the current macrotask via a
  // deasync-style spin. We avoid `child_process` and `Atomics.wait`
  // here by simply blocking on the microtask queue: in Node, an
  // `async` function whose body awaits resolved promises drains
  // before the next macrotask, and tsx runs this file as the top
  // entry — there is nothing else scheduled on the loop. So we
  // simply await it from the runAll() async wrapper below; this
  // sub-function records its findings into the closure.
  let finished: { totalNs: bigint; actualOps: number } = {
    totalNs: 0n,
    actualOps: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  const promise: Promise<void> = runAsync().then((r) => {
    finished = r;
  });
  // The caller (main) awaits runAll() which awaits this promise via
  // the deferred result — but the recursive shape complicates types.
  // The simpler contract: stash the promise on a global so main can
  // await it, then return the partially-filled BenchResult. main()
  // calls `await __pendingQrPromise` before serializing.
  __pendingQrPromise = promise;
  __pendingQrCommit = () => {
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      totalNs: finished.totalNs,
      actualOps: finished.actualOps,
      latencyUs: {
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted.length ? sorted[sorted.length - 1]! : 0,
        avg: sorted.length
          ? sorted.reduce((acc, x) => acc + x, 0) / sorted.length
          : 0,
      },
      errorSamples: overBudget
        ? [...errorSet, `time_budget_exceeded:${cfg.timeBudgetMs}ms`]
        : [...errorSet],
      failedCount,
    };
  };

  // Return a placeholder; main() rewrites this entry after awaiting.
  return {
    name: "generateInvoiceQrSvg",
    ops: 0,
    totalMs: 0,
    opsPerSec: 0,
    latencyUs: { p50: 0, p95: 0, p99: 0, max: 0, avg: 0 },
    errorSamples: [],
    failedCount: 0,
  };
}

let __pendingQrPromise: Promise<void> | null = null;
let __pendingQrCommit:
  | (() => {
      totalNs: bigint;
      actualOps: number;
      latencyUs: BenchResult["latencyUs"];
      errorSamples: string[];
      failedCount: number;
    })
  | null = null;

// ---------------------------------------------------------------------------
// bottleneck classification + report
// ---------------------------------------------------------------------------

function classifyBottlenecks(results: BenchResult[], floor: number): string[] {
  const tags: string[] = [];
  for (const r of results) {
    if (r.failedCount > 0) {
      tags.push(`construction_failures:${r.name}:${r.failedCount}/${r.ops}`);
    }
    if (r.errorSamples.some((s) => s.startsWith("time_budget_exceeded:"))) {
      tags.push(`time_budget_exceeded:${r.name}`);
    }
    if (r.ops > 0 && r.opsPerSec < floor) {
      tags.push(
        `slow_construction:${r.name}:${r.opsPerSec.toFixed(1)}ops/s<${floor}`,
      );
    }
  }
  if (tags.length === 0) tags.push("none_observed");
  return tags;
}

interface Report {
  generatedAt: string;
  mission: "Z28.4";
  variant: "off-chain-construction";
  config: BenchConfig;
  node: { version: string; platform: string; arch: string };
  benches: BenchResult[];
  bottlenecks: string[];
}

function writeReport(cfg: BenchConfig, results: BenchResult[]): Report {
  const report: Report = {
    generatedAt: new Date().toISOString(),
    mission: "Z28.4",
    variant: "off-chain-construction",
    config: cfg,
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    benches: results,
    bottlenecks: classifyBottlenecks(results, cfg.opsFloor),
  };
  writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function formatRow(r: BenchResult): string {
  return [
    r.name.padEnd(34),
    `${r.ops.toString().padStart(5)} ops`,
    `${r.opsPerSec.toFixed(1).padStart(10)} ops/s`,
    `p50=${r.latencyUs.p50.toFixed(1).padStart(8)}µs`,
    `p95=${r.latencyUs.p95.toFixed(1).padStart(8)}µs`,
    `p99=${r.latencyUs.p99.toFixed(1).padStart(8)}µs`,
    `fails=${r.failedCount}`,
  ].join("  ");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(
    `[stress-construction-z28-4] ops=${cfg.ops} warmup=${cfg.warmup} floor=${cfg.opsFloor} ops/s`,
  );
  console.log(
    `[stress-construction-z28-4] node=${process.version} ${process.platform}/${process.arch}`,
  );

  const results = runBenches(cfg);

  // Settle the async QR bench then patch its row in `results`.
  if (__pendingQrPromise && __pendingQrCommit) {
    await __pendingQrPromise;
    const commit = __pendingQrCommit();
    const qrIdx = results.findIndex((r) => r.name === "generateInvoiceQrSvg");
    if (qrIdx >= 0) {
      const totalMs = Number(commit.totalNs) / 1_000_000;
      const opsPerSec =
        commit.totalNs > 0n
          ? (commit.actualOps * 1e9) / Number(commit.totalNs)
          : 0;
      results[qrIdx] = {
        name: "generateInvoiceQrSvg",
        ops: commit.actualOps,
        totalMs,
        opsPerSec,
        latencyUs: commit.latencyUs,
        errorSamples: commit.errorSamples,
        failedCount: commit.failedCount,
      };
    }
  }

  console.log("");
  for (const r of results) console.log(formatRow(r));
  console.log("");

  const report = writeReport(cfg, results);
  console.log(
    `[stress-construction-z28-4] report → ${cfg.reportPath}\n[stress-construction-z28-4] bottlenecks: ${report.bottlenecks.join(", ")}`,
  );

  const failed =
    report.bottlenecks.some((t) => t !== "none_observed") ? 1 : 0;
  process.exit(failed);
}

main().catch((err) => {
  console.error("[stress-construction-z28-4] fatal:", err);
  process.exit(1);
});
