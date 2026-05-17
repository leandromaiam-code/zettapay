// Z51 — Supabase access for the sweep worker. Talks to PostgREST directly
// with fetch so the /api lane stays free of the @supabase/supabase-js dep
// (vercel.json keeps workspaces=false; smaller bundle, faster cold start).

import type { SweepableInvoice, SweepChain, SweeperOutcome } from './sweep-types.js';

interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

function readConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey: key };
}

function defaultHeaders(cfg: SupabaseConfig): Record<string, string> {
  return {
    'apikey': cfg.serviceRoleKey,
    'Authorization': `Bearer ${cfg.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

interface InvoiceRow {
  id: string;
  merchant_id: string;
  chain: SweepChain;
  derivation_path: string;
  receive_address: string;
  amount_native: string;
  sweep_attempts: number | null;
  sweep_tx_hash: string | null;
}

export async function listConfirmedUnswept(limit: number): Promise<SweepableInvoice[]> {
  const cfg = readConfig();
  if (!cfg) return [];
  const select = encodeURIComponent(
    'id,merchant_id,chain,derivation_path,receive_address,amount_native,sweep_attempts,sweep_tx_hash',
  );
  const url =
    `${cfg.url}/rest/v1/zettapay_invoices` +
    `?select=${select}` +
    `&status=eq.confirmed` +
    `&swept_at=is.null` +
    `&order=confirmed_at.asc` +
    `&limit=${Math.max(1, Math.min(limit, 500))}`;
  const res = await fetch(url, { method: 'GET', headers: defaultHeaders(cfg) });
  if (!res.ok) {
    throw new Error(`supabase list failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as InvoiceRow[];
  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    chain: row.chain,
    derivationPath: row.derivation_path,
    receiveAddress: row.receive_address,
    amountNative: row.amount_native,
    sweepAttempts: row.sweep_attempts ?? 0,
    sweepTxHash: row.sweep_tx_hash,
  }));
}

export async function markSweepAttempt(invoiceId: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  // PostgREST has no atomic increment, but Supabase exposes an RPC helper
  // for this kind of update via raw SQL through pg-meta — fall back to a
  // read-modify-write that races at worst into one duplicated attempt count.
  const readUrl = `${cfg.url}/rest/v1/zettapay_invoices?select=sweep_attempts&id=eq.${encodeURIComponent(invoiceId)}&limit=1`;
  const readRes = await fetch(readUrl, { method: 'GET', headers: defaultHeaders(cfg) });
  if (!readRes.ok) return;
  const rows = (await readRes.json()) as Array<{ sweep_attempts: number | null }>;
  const current = rows[0]?.sweep_attempts ?? 0;
  const patchUrl = `${cfg.url}/rest/v1/zettapay_invoices?id=eq.${encodeURIComponent(invoiceId)}`;
  await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...defaultHeaders(cfg), Prefer: 'return=minimal' },
    body: JSON.stringify({
      sweep_attempts: current + 1,
      last_sweep_attempt_at: new Date().toISOString(),
    }),
  });
}

export async function markSwept(invoiceId: string, sweepTxHash: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  const patchUrl = `${cfg.url}/rest/v1/zettapay_invoices?id=eq.${encodeURIComponent(invoiceId)}`;
  const res = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { ...defaultHeaders(cfg), Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'swept',
      sweep_tx_hash: sweepTxHash,
      swept_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    throw new Error(`supabase markSwept failed: ${res.status} ${await res.text()}`);
  }
}

// Idempotency guard: before re-broadcasting a sweep tx, ask the chain
// whether the prior attempt's tx is already confirmed. If so, mark the row
// swept without spending another fee.
export async function isOnchainConfirmed(chain: SweepChain, sweepTxHash: string): Promise<boolean> {
  try {
    if (chain === 'btc') {
      const res = await fetch(
        `${btcMempoolBase()}/api/tx/${encodeURIComponent(sweepTxHash)}/status`,
        { method: 'GET' },
      );
      if (!res.ok) return false;
      const body = (await res.json()) as { confirmed?: boolean };
      return body.confirmed === true;
    }
    const rpcUrl = evmRpcUrl(chain);
    if (!rpcUrl) return false;
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [sweepTxHash],
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: { status?: string; blockNumber?: string } | null };
    if (!body.result) return false;
    return body.result.status === '0x1' && Boolean(body.result.blockNumber);
  } catch {
    return false;
  }
}

export async function appendAuditEntry(args: {
  invoiceId: string;
  chain: SweepChain;
  outcome: SweeperOutcome;
}): Promise<void> {
  const cfg = readConfig();
  if (!cfg) return;
  await fetch(`${cfg.url}/rest/v1/zettapay_audit_journal`, {
    method: 'POST',
    headers: { ...defaultHeaders(cfg), Prefer: 'return=minimal' },
    body: JSON.stringify({
      actor: 'sweep_worker',
      event: `sweep.${args.outcome.kind}`,
      entity_type: 'invoice',
      entity_id: args.invoiceId,
      payload: { chain: args.chain, outcome: args.outcome },
    }),
  }).catch(() => {
    // Audit must never block the sweep loop; logged failures elsewhere.
  });
}

function btcMempoolBase(): string {
  return process.env.MEMPOOL_SPACE_BASE_URL?.replace(/\/+$/, '') ?? 'https://mempool.space';
}

function evmRpcUrl(chain: SweepChain): string | null {
  switch (chain) {
    case 'base':
      return process.env.BASE_RPC_URL?.trim() ?? 'https://mainnet.base.org';
    case 'polygon':
      return process.env.POLYGON_RPC_URL?.trim() ?? 'https://polygon-rpc.com';
    case 'ethereum':
      return process.env.ETHEREUM_RPC_URL?.trim() ?? 'https://eth.llamarpc.com';
    default:
      return null;
  }
}
