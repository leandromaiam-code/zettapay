-- Z45: HD wallet per-invoice infrastructure.
--
-- ZettaPay pivots from Solana-only to a 2-family chain stack: Bitcoin on-chain
-- + USDC on EVMs (Base MVP, then Polygon, then Ethereum). Each invoice gets
-- a receive address derived from a master seed via BIP32/44/84:
--   BTC : m/84'/0'/0'/0/{index}   bech32 P2WPKH
--   EVM : m/44'/60'/0'/0/{index}  Metamask-compatible (same address across
--                                  Base / Polygon / Ethereum)
--
-- Because the EVM derivation path is chain-agnostic, base/polygon/ethereum
-- share a single 'evm' index namespace. BTC has its own 'btc' namespace.
-- Index allocation is atomic via UPDATE ... RETURNING on the counter row,
-- so concurrent invoice creation cannot collide.

create table if not exists public.zettapay_invoice_index_counters (
  namespace   text primary key check (namespace in ('btc', 'evm')),
  next_index  bigint not null default 0 check (next_index >= 0),
  updated_at  timestamptz not null default now()
);

insert into public.zettapay_invoice_index_counters (namespace)
values ('btc'), ('evm')
on conflict (namespace) do nothing;

-- Counters are service-role only. The atomic allocate happens behind the
-- admin endpoint; merchants never read or mutate the counter directly.
alter table public.zettapay_invoice_index_counters enable row level security;
revoke all on public.zettapay_invoice_index_counters from anon, authenticated;

create table if not exists public.zettapay_invoices (
  id                       uuid primary key default gen_random_uuid(),
  merchant_id              text not null references public.merchants (id) on delete cascade,
  amount_usd               numeric(20, 6)  not null check (amount_usd > 0),
  amount_native            numeric(38, 18) not null check (amount_native > 0),
  chain                    text not null check (chain in ('btc', 'base', 'polygon', 'ethereum')),
  derivation_path          text not null,
  derivation_index         bigint not null check (derivation_index >= 0),
  receive_address          text not null,
  status                   text not null default 'pending'
                           check (status in ('pending', 'confirmed', 'expired', 'swept')),
  tx_hash                  text,
  confirmations            integer not null default 0 check (confirmations >= 0),
  required_confirmations   integer not null check (required_confirmations >= 0),
  expires_at               timestamptz not null,
  confirmed_at             timestamptz,
  swept_at                 timestamptz,
  webhook_dispatched_at    timestamptz,
  created_at               timestamptz not null default now(),

  -- Same EVM address may legitimately back an invoice on base, polygon, and
  -- ethereum simultaneously (one private key, three chains). The (chain,
  -- receive_address) tuple is what must stay unique so the listener can route
  -- inbound payments to exactly one invoice.
  constraint zettapay_invoices_chain_address_unique
    unique (chain, receive_address)
);

create index if not exists zettapay_invoices_merchant_idx
  on public.zettapay_invoices (merchant_id, created_at desc);

create index if not exists zettapay_invoices_pending_idx
  on public.zettapay_invoices (expires_at)
  where status = 'pending';

create index if not exists zettapay_invoices_receive_address_idx
  on public.zettapay_invoices (receive_address);

create index if not exists zettapay_invoices_tx_hash_idx
  on public.zettapay_invoices (chain, tx_hash)
  where tx_hash is not null;

alter table public.zettapay_invoices enable row level security;

create policy "merchant owns invoices: select"
  on public.zettapay_invoices
  for select
  using (merchant_id = auth.uid()::text);

create policy "merchant owns invoices: insert"
  on public.zettapay_invoices
  for insert
  with check (merchant_id = auth.uid()::text);

create policy "merchant owns invoices: update"
  on public.zettapay_invoices
  for update
  using (merchant_id = auth.uid()::text)
  with check (merchant_id = auth.uid()::text);

-- Atomic index allocator. Returns the value that was claimed (pre-increment)
-- so callers always receive a fresh, never-handed-out index per namespace.
-- This is the single source of truth for derivation index assignment; using
-- it from any code path guarantees no collisions under concurrent load.
create or replace function public.zettapay_allocate_invoice_index(p_namespace text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allocated bigint;
begin
  if p_namespace not in ('btc', 'evm') then
    raise exception 'invalid index namespace: %', p_namespace
      using errcode = '22023';
  end if;

  update public.zettapay_invoice_index_counters
  set next_index = next_index + 1,
      updated_at = now()
  where namespace = p_namespace
  returning next_index - 1 into v_allocated;

  if v_allocated is null then
    raise exception 'counter row missing for namespace %', p_namespace
      using errcode = 'P0002';
  end if;

  return v_allocated;
end;
$$;

revoke all on function public.zettapay_allocate_invoice_index(text) from public, anon, authenticated;
grant execute on function public.zettapay_allocate_invoice_index(text) to service_role;
