import { describe, expect, it } from 'vitest';
import { SupabaseStorage } from '../src/storage/supabase.js';
import { describeStorageContract } from './storage-contract.js';

// SupabaseStorage runs against the PostgREST surface via plain `fetch`. There
// is no Supabase project in CI, so we drive the adapter with an in-memory
// fetch mock that translates the (small) subset of REST queries the adapter
// emits into table-keyed Maps. This keeps the same `describeStorageContract`
// suite as the JSON adapter — any drift between the two implementations
// surfaces here.

interface ParsedQuery {
  filters: Map<string, { op: string; value: string }>;
  order?: { column: string; dir: 'asc' | 'desc' };
  limit?: number;
  select?: string;
}

function parseQuery(url: URL): ParsedQuery {
  const out: ParsedQuery = { filters: new Map() };
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'order') {
      const [column, dir] = v.split('.');
      out.order = { column: column ?? 'id', dir: dir === 'desc' ? 'desc' : 'asc' };
    } else if (k === 'limit') {
      out.limit = Number(v);
    } else if (k === 'select') {
      out.select = v;
    } else {
      const idx = v.indexOf('.');
      if (idx < 0) {
        out.filters.set(k, { op: 'eq', value: v });
      } else {
        out.filters.set(k, { op: v.slice(0, idx), value: v.slice(idx + 1) });
      }
    }
  }
  return out;
}

function matches(row: Record<string, unknown>, q: ParsedQuery): boolean {
  for (const [col, f] of q.filters) {
    const got = row[col];
    switch (f.op) {
      case 'eq':
        if (String(got) !== f.value) return false;
        break;
      case 'is':
        if (f.value === 'null' && got != null) return false;
        if (f.value === 'not.null' && got == null) return false;
        break;
      case 'gt':
        if (!(typeof got === 'string' && got > f.value)) return false;
        break;
      case 'lte':
        if (!(typeof got === 'string' && got <= f.value)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

interface MockEnv {
  fetchImpl: typeof fetch;
  tables: Map<string, Map<string, Record<string, unknown>>>;
  rpcCount: number;
}

function makeMockEnv(): MockEnv {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  tables.set('zettapay_merchants', new Map());
  tables.set('zettapay_invoices', new Map());
  tables.set('zettapay_webhook_events', new Map());
  let rpcCount = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const restMarker = '/rest/v1/';
    const restIdx = url.pathname.indexOf(restMarker);
    if (restIdx < 0) return new Response('{}', { status: 200 });
    const tail = url.pathname.slice(restIdx + restMarker.length);

    // RPC for atomic child-index allocation.
    if (tail === 'rpc/zettapay_allocate_child_index') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const merchantId = body.p_merchant as string;
      const merchants = tables.get('zettapay_merchants')!;
      const m = merchants.get(merchantId);
      if (!m) {
        return new Response(JSON.stringify({ message: 'merchant not found' }), { status: 404 });
      }
      const idx = Number(m.next_child_index ?? 0);
      m.next_child_index = idx + 1;
      rpcCount += 1;
      return new Response(JSON.stringify(idx), { status: 200 });
    }

    const table = tables.get(tail);
    if (!table) return new Response(JSON.stringify([]), { status: 200 });
    const q = parseQuery(url);

    if (method === 'GET') {
      const rows = Array.from(table.values()).filter((r) => matches(r, q));
      if (q.order) {
        const col = q.order.column;
        const dir = q.order.dir;
        rows.sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
          return 0;
        });
      }
      const limited = q.limit ? rows.slice(0, q.limit) : rows;
      return new Response(JSON.stringify(limited), { status: 200 });
    }

    if (method === 'POST') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const row = body as Record<string, unknown>;
      const id = (row.id as string) ?? `auto_${table.size + 1}`;
      row.id = id;
      if (row.created_at === undefined) row.created_at = new Date().toISOString();
      if (row.next_child_index === undefined && tail === 'zettapay_merchants') {
        row.next_child_index = 0;
      }
      if (table.has(id)) {
        return new Response(
          JSON.stringify({ message: 'duplicate key', code: '23505' }),
          { status: 409 },
        );
      }
      // Email uniqueness for merchants.
      if (tail === 'zettapay_merchants' && typeof row.email === 'string') {
        for (const existing of table.values()) {
          if (existing.email === row.email) {
            return new Response(
              JSON.stringify({ message: 'duplicate email', code: '23505' }),
              { status: 409 },
            );
          }
        }
      }
      table.set(id, row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }

    if (method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const patch = body as Record<string, unknown>;
      const updated: Record<string, unknown>[] = [];
      for (const [k, row] of table.entries()) {
        if (!matches(row, q)) continue;
        const merged = { ...row, ...patch };
        table.set(k, merged);
        updated.push(merged);
      }
      return new Response(JSON.stringify(updated), { status: 200 });
    }

    return new Response('{}', { status: 405 });
  };

  return { fetchImpl, tables, get rpcCount() { return rpcCount; } } as MockEnv;
}

describeStorageContract('supabase (fetch-mock)', async () => {
  const env = makeMockEnv();
  return new SupabaseStorage({
    url: 'https://mock.supabase.test',
    serviceRoleKey: 'mock-service-role',
    fetchImpl: env.fetchImpl,
  });
});

describe('SupabaseStorage — adapter-specific behavior', () => {
  it('uses the SECURITY DEFINER RPC for nextChildIndex when present', async () => {
    const env = makeMockEnv();
    const adapter = new SupabaseStorage({
      url: 'https://mock.supabase.test',
      serviceRoleKey: 'mock',
      fetchImpl: env.fetchImpl,
    });
    const merchant = await adapter.createMerchant({
      shop_name: 'RPC Test',
      email: 'rpc@example.test',
      xpub: 'zpub-test',
      webhook_url: 'https://example.test/hook',
      webhook_secret_hash: 'sha256:secret',
    });
    const idxA = await adapter.nextChildIndex(merchant.id);
    const idxB = await adapter.nextChildIndex(merchant.id);
    expect(idxA).toBe(0);
    expect(idxB).toBe(1);
    expect(env.rpcCount).toBeGreaterThanOrEqual(2);
  });

  it('findInvoiceByAddress returns the matching invoice', async () => {
    const env = makeMockEnv();
    const adapter = new SupabaseStorage({
      url: 'https://mock.supabase.test',
      serviceRoleKey: 'mock',
      fetchImpl: env.fetchImpl,
    });
    const merchant = await adapter.createMerchant({
      shop_name: 'Addr Test',
      email: 'addr@example.test',
      xpub: 'zpub-test',
      webhook_url: 'https://example.test/hook',
      webhook_secret_hash: 'sha256:secret',
    });
    const invoice = await adapter.createInvoice({
      id: 'inv_addr_test_0001',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.0001',
      address: 'bc1qexampleaddressforfindlookup',
      child_index: 0,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const found = await adapter.findInvoiceByAddress(invoice.address);
    expect(found?.id).toBe(invoice.id);
    const missing = await adapter.findInvoiceByAddress('bc1qdoesnotexist');
    expect(missing).toBeNull();
  });

  it('getMerchantByEmail normalizes case and returns null for unknown', async () => {
    const env = makeMockEnv();
    const adapter = new SupabaseStorage({
      url: 'https://mock.supabase.test',
      serviceRoleKey: 'mock',
      fetchImpl: env.fetchImpl,
    });
    await adapter.createMerchant({
      shop_name: 'Email Test',
      email: 'Email@Example.Test',
      xpub: 'zpub-test',
      webhook_url: 'https://example.test/hook',
      webhook_secret_hash: 'sha256:secret',
    });
    const found = await adapter.getMerchantByEmail('EMAIL@example.test');
    expect(found?.email).toBe('email@example.test');
    const missing = await adapter.getMerchantByEmail('nobody@example.test');
    expect(missing).toBeNull();
  });

  it('createMerchant returns existing row on email conflict (idempotent)', async () => {
    const env = makeMockEnv();
    const adapter = new SupabaseStorage({
      url: 'https://mock.supabase.test',
      serviceRoleKey: 'mock',
      fetchImpl: env.fetchImpl,
    });
    const first = await adapter.createMerchant({
      shop_name: 'Dup Test',
      email: 'dup@example.test',
      xpub: 'zpub-1',
      webhook_url: 'https://example.test/hook-1',
      webhook_secret_hash: 'sha256:1',
    });
    const second = await adapter.createMerchant({
      shop_name: 'Dup Test 2',
      email: 'dup@example.test',
      xpub: 'zpub-2',
      webhook_url: 'https://example.test/hook-2',
      webhook_secret_hash: 'sha256:2',
    });
    expect(second.id).toBe(first.id);
    expect(second.xpub).toBe('zpub-1');
  });
});
