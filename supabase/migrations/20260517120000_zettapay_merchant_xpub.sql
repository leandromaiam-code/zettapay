-- Z53 — non-custodial BTC P2P merchant model.
--
-- Migration is idempotent: drops any legacy custodial columns if present,
-- then adds the xpub + derivation_index pair used by the watch-only
-- address derivation pipeline.
--
-- HR-CUSTODY: master_seed / private_key / mnemonic columns are forbidden.
-- If a prior mission accidentally added one, this migration removes it.
-- HR-PII-MINIMAL: only email + shop_name + xpub + webhook_url + webhook
-- secret fingerprint are stored on the merchant row.

begin;

create table if not exists merchants (
  id text primary key,
  email text not null,
  shop_name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists merchants_email_idx on merchants (lower(email));

-- Purge any legacy custodial columns that may have been introduced before
-- Z53. Each statement is guarded so the migration is safe to re-run.
alter table merchants drop column if exists master_seed;
alter table merchants drop column if exists private_key;
alter table merchants drop column if exists mnemonic;
alter table merchants drop column if exists wallet_secret;

alter table merchants
  add column if not exists xpub text;
alter table merchants
  add column if not exists xpub_derivation_index integer not null default 0;
alter table merchants
  add column if not exists webhook_url text;
alter table merchants
  add column if not exists webhook_secret_sha256 text;

-- Enforce non-empty + xpub/zpub-prefixed shape. The CHECK pattern is
-- intentionally identical to the API boundary regex.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'merchants_xpub_shape_chk'
  ) then
    alter table merchants
      add constraint merchants_xpub_shape_chk
      check (xpub is null or xpub ~ '^(zpub|xpub)[1-9A-HJ-NP-Za-km-z]+$');
  end if;
end$$;

-- Once existing rows are backfilled, an operator can flip this to NOT NULL
-- via a follow-up migration. We leave it nullable here to keep this guarded
-- migration safe to re-run against an environment that already has merchants.
create index if not exists merchants_xpub_idx on merchants (xpub) where xpub is not null;

-- Atomic per-merchant derivation index increment helper. Returns the value
-- BEFORE the increment so the caller can use it as the new invoice index.
create or replace function zp_next_derivation_index(p_merchant_id text)
returns integer
language plpgsql
as $$
declare
  v_index integer;
begin
  update merchants
    set xpub_derivation_index = xpub_derivation_index + 1
    where id = p_merchant_id
    returning xpub_derivation_index - 1 into v_index;
  if v_index is null then
    raise exception 'merchant_not_found: %', p_merchant_id;
  end if;
  return v_index;
end;
$$;

-- Per-invoice address + payment state.
create table if not exists invoices (
  id text primary key,
  merchant_id text not null references merchants(id) on delete cascade,
  chain text not null default 'bitcoin',
  fiat_amount_usd numeric(18, 2) not null,
  btc_address text not null,
  derivation_index integer not null,
  required_confirmations smallint not null,
  status text not null default 'pending',
  txid text,
  received_sats bigint,
  confirmations smallint not null default 0,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists invoices_merchant_idx on invoices (merchant_id);
create unique index if not exists invoices_btc_address_idx on invoices (btc_address);

commit;
