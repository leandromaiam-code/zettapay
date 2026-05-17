// Z47 — Supabase-backed implementation of the `InvoiceStore` boundary used
// by `EvmListener`. The Z45 migration provisions `public.zettapay_invoices`;
// this adapter speaks PostgREST directly so packages/api does not need to
// take a fresh runtime dep on `@supabase/supabase-js` (Vercel lane already
// pulls it; the long-running listener stays slim).
//
// All four methods are idempotent at the row level so a re-delivery of the
// same Transfer log only writes the same state.

import type {
  BaseListenerChain,
  InvoiceStore,
  MatchedTx,
  PendingInvoice,
} from "./evm_listener.js";

const PENDING_SELECT =
  "id,chain,receive_address,amount_native,required_confirmations,status";

export interface SupabaseInvoiceStoreOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Override the `fetch` impl for tests / Node < 18 polyfills. */
  fetchImpl?: typeof fetch;
  /** Table name; defaults to the Z45 canonical `zettapay_invoices`. */
  tableName?: string;
}

interface InvoiceRow {
  id: string;
  chain: string;
  receive_address: string;
  amount_native: string;
  required_confirmations: number;
  status: string;
}

/**
 * PostgREST adapter. The table lives in `public` so we hit
 * `<supabase_url>/rest/v1/zettapay_invoices`. The service-role key bypasses
 * RLS, which is required: the listener runs as a backend daemon, not as a
 * specific merchant.
 */
export class SupabaseInvoiceStore implements InvoiceStore {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetch: typeof fetch;
  private readonly tableName: string;

  constructor(opts: SupabaseInvoiceStoreOptions) {
    this.baseUrl = opts.supabaseUrl.replace(/\/+$/, "");
    this.headers = {
      apikey: opts.serviceRoleKey,
      Authorization: `Bearer ${opts.serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    };
    this.fetch = opts.fetchImpl ?? fetch;
    this.tableName = opts.tableName ?? "zettapay_invoices";
  }

  async listPending(chain: BaseListenerChain): Promise<PendingInvoice[]> {
    const url =
      `${this.baseUrl}/rest/v1/${this.tableName}` +
      `?select=${encodeURIComponent(PENDING_SELECT)}` +
      `&chain=eq.${encodeURIComponent(chain)}` +
      `&status=eq.pending` +
      `&tx_hash=is.null`;
    const res = await this.fetch(url, {
      method: "GET",
      headers: { ...this.headers, Prefer: "count=none" },
    });
    if (!res.ok) {
      throw new Error(
        `supabase listPending failed: ${res.status} ${await safeBody(res)}`,
      );
    }
    const rows = (await res.json()) as InvoiceRow[];
    return rows.map(rowToInvoice);
  }

  async markMatched(invoiceId: string, tx: MatchedTx): Promise<void> {
    await this.patch(invoiceId, {
      tx_hash: tx.hash,
      confirmations: 1,
    });
  }

  async updateConfirmations(
    invoiceId: string,
    confirmations: number,
  ): Promise<void> {
    await this.patch(invoiceId, { confirmations });
  }

  async markConfirmed(invoiceId: string, confirmedAt: Date): Promise<void> {
    await this.patch(invoiceId, {
      status: "confirmed",
      confirmed_at: confirmedAt.toISOString(),
    });
  }

  private async patch(
    invoiceId: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const url =
      `${this.baseUrl}/rest/v1/${this.tableName}` +
      `?id=eq.${encodeURIComponent(invoiceId)}`;
    const res = await this.fetch(url, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `supabase patch ${invoiceId} failed: ${res.status} ${await safeBody(res)}`,
      );
    }
  }
}

function rowToInvoice(row: InvoiceRow): PendingInvoice {
  if (!isBaseChain(row.chain)) {
    throw new Error(`invoice ${row.id} has non-Base chain "${row.chain}"`);
  }
  return {
    id: row.id,
    chain: row.chain,
    receiveAddress: assertHexAddress(row.receive_address),
    amountNative: decimalToAtomicUsdc(row.amount_native),
    requiredConfirmations: row.required_confirmations,
  };
}

function isBaseChain(value: string): value is BaseListenerChain {
  return value === "base" || value === "base-sepolia";
}

function assertHexAddress(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid 0x-prefixed address: ${value}`);
  }
  return value as `0x${string}`;
}

/**
 * The `amount_native` column is `numeric(38,18)`; for USDC we need atomic
 * units (decimals=6). Parse the decimal string and multiply by 10^6,
 * round-half-down to stay on the conservative side of the merchant's quote.
 */
export function decimalToAtomicUsdc(decimal: string): bigint {
  const trimmed = decimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: ${decimal}`);
  }
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ""] = abs.split(".");
  const padded = (fracPart + "000000").slice(0, 6);
  const atomic = BigInt((intPart ?? "0") + padded);
  return negative ? -atomic : atomic;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Build a `SupabaseInvoiceStore` from environment variables. Returns null
 * when either `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is unset — the
 * caller decides whether to fail fast or fall back to a no-op store.
 */
export function loadSupabaseInvoiceStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseInvoiceStore | null {
  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !serviceRoleKey) return null;
  return new SupabaseInvoiceStore({ supabaseUrl, serviceRoleKey });
}
