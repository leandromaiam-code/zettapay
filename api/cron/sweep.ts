// Z51 — Vercel cron entry. Wired by vercel.json at hourly cadence; verifies
// the CRON_SECRET header (Vercel's default scheduled-task auth) and then
// iterates the orchestrator inline. Inline rather than imported from
// packages/api/src/services/sweep_worker.ts because vercel.json keeps
// workspaces=false so the @zettapay/api workspace never reaches the
// function runtime — the canonical service lives in packages/api for the
// container cron path; this entry mirrors its loop semantics.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sweepBtc } from '../_lib/sweep-btc.js';
import { sweepEvmUsdc } from '../_lib/sweep-evm.js';
import { notifyConsecutiveFailures } from '../_lib/sweep-alerter.js';
import {
  appendAuditEntry,
  isOnchainConfirmed,
  listConfirmedUnswept,
  markSweepAttempt,
  markSwept,
} from '../_lib/sweep-store.js';
import type { SweepableInvoice, SweeperOutcome } from '../_lib/sweep-types.js';

const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_FAILURE_ALERT = 3;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (!authorize(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const summary = await runSweepTick();
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function authorize(req: VercelRequest): boolean {
  const required = process.env.CRON_SECRET?.trim();
  if (!required) return true; // unset in dev/preview; locked down in prod
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  return header === `Bearer ${required}`;
}

interface TickSummary {
  attempted: number;
  swept: number;
  skipped: number;
  failed: number;
  outcomes: Array<{ invoiceId: string; outcome: SweeperOutcome }>;
}

async function runSweepTick(): Promise<TickSummary> {
  const limit = parsePositiveInt(process.env.SWEEP_BATCH_LIMIT) ?? DEFAULT_BATCH_LIMIT;
  const alertThreshold =
    parsePositiveInt(process.env.SWEEP_FAILURE_ALERT_THRESHOLD) ?? DEFAULT_FAILURE_ALERT;
  const btcTreasury = process.env.BTC_TREASURY_ADDRESS?.trim() || null;
  const evmTreasury = process.env.EVM_TREASURY_ADDRESS?.trim() || null;

  const invoices = await listConfirmedUnswept(limit);
  const summary: TickSummary = { attempted: 0, swept: 0, skipped: 0, failed: 0, outcomes: [] };
  const consecutive = { btc: 0, evm: 0 };
  const lastReason = { btc: '', evm: '' };

  for (const invoice of invoices) {
    summary.attempted += 1;
    await markSweepAttempt(invoice.id).catch(() => undefined);

    const outcome = await attemptSweep(invoice, { btcTreasury, evmTreasury });
    summary.outcomes.push({ invoiceId: invoice.id, outcome });
    await appendAuditEntry({ invoiceId: invoice.id, chain: invoice.chain, outcome });

    const family = invoice.chain === 'btc' ? 'btc' : 'evm';
    if (outcome.kind === 'swept') {
      summary.swept += 1;
      consecutive[family] = 0;
      lastReason[family] = '';
      await markSwept(invoice.id, outcome.txHash).catch(() => undefined);
    } else if (outcome.kind === 'skipped') {
      summary.skipped += 1;
    } else {
      summary.failed += 1;
      consecutive[family] += 1;
      lastReason[family] = outcome.reason;
      if (consecutive[family] >= alertThreshold) {
        await notifyConsecutiveFailures({
          chain: invoice.chain,
          consecutive: consecutive[family],
          lastReason: lastReason[family],
        });
      }
    }
  }
  return summary;
}

async function attemptSweep(
  invoice: SweepableInvoice,
  treasury: { btcTreasury: string | null; evmTreasury: string | null },
): Promise<SweeperOutcome> {
  if (invoice.sweepTxHash) {
    const confirmed = await isOnchainConfirmed(invoice.chain, invoice.sweepTxHash);
    if (confirmed) {
      return { kind: 'swept', txHash: invoice.sweepTxHash };
    }
  }
  try {
    if (invoice.chain === 'btc') {
      if (!treasury.btcTreasury) {
        return { kind: 'skipped', reason: 'BTC_TREASURY_ADDRESS not configured' };
      }
      return await sweepBtc({
        derivationPath: invoice.derivationPath,
        fromAddress: invoice.receiveAddress,
        treasuryAddress: treasury.btcTreasury,
      });
    }
    if (!treasury.evmTreasury) {
      return { kind: 'skipped', reason: 'EVM_TREASURY_ADDRESS not configured' };
    }
    return await sweepEvmUsdc({
      chain: invoice.chain,
      derivationPath: invoice.derivationPath,
      fromAddress: invoice.receiveAddress,
      treasuryAddress: treasury.evmTreasury,
    });
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
