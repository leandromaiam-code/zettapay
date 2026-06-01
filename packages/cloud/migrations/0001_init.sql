-- @zettapay/cloud — canonical multi-tenant schema (zettapay_* tables).
--
-- This file is the reproducible source of truth for the shared Supabase project
-- the cloud service runs against. It mirrors what is live in production today:
--   * zettapay_merchant_chains.evm_tokens is NULLABLE
--   * zettapay_invoices.amount_units is TEXT (carries the canonical Invoice.amount
--     from the listener core: BTC as a decimal string "0.0005", EVM as integer
--     token base units as a string)
--   * zettapay_merchants.name holds the shop name used for checkout branding
--
-- NON-CUSTODIAL: only PUBLIC material is ever stored — xpub, fixed receive
-- address, and the webhook HMAC secret. No private key, seed phrase, or signing
-- path column exists. Funds settle straight into the merchant's own wallet.
--
-- Idempotent: every object is guarded (create ... if not exists / drop policy if
-- exists), so this can be re-applied against an existing project safely.

-- ---------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------
create table if not exists zettapay_merchants (
  id          uuid primary key default gen_random_uuid(),
  auth_uid    uuid references auth.users (id) on delete set null,
  email       text not null,
  name        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists zettapay_merchants_auth_uid_idx on zettapay_merchants (auth_uid);

-- ---------------------------------------------------------------------------
-- merchant API keys (only the SHA-256 hash + a non-secret prefix are stored)
-- ---------------------------------------------------------------------------
create table if not exists zettapay_merchant_keys (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references zettapay_merchants (id) on delete cascade,
  api_key_hash  text not null,
  key_prefix    text not null,
  label         text,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz
);
create unique index if not exists zettapay_merchant_keys_hash_idx on zettapay_merchant_keys (api_key_hash);
create index if not exists zettapay_merchant_keys_merchant_idx on zettapay_merchant_keys (merchant_id);

-- ---------------------------------------------------------------------------
-- per-merchant chain config (BTC xpub and/or Base xpub / fixed address)
-- ---------------------------------------------------------------------------
create table if not exists zettapay_merchant_chains (
  id                uuid primary key default gen_random_uuid(),
  merchant_id       uuid not null references zettapay_merchants (id) on delete cascade,
  chain             text not null check (chain in ('btc', 'base')),
  xpub              text,
  fixed_address     text,
  evm_tokens        text[],
  next_child_index  integer not null default 0,
  created_at        timestamptz not null default now(),
  unique (merchant_id, chain)
);
create index if not exists zettapay_merchant_chains_merchant_idx on zettapay_merchant_chains (merchant_id);

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------
create table if not exists zettapay_invoices (
  id            text primary key,
  merchant_id   uuid not null references zettapay_merchants (id) on delete cascade,
  chain         text not null,
  asset         text not null,
  amount_sats   bigint,
  amount_units  text,
  amount_usd    numeric,
  address       text not null,
  child_index   integer,
  nonce         integer,
  status        text not null default 'pending',
  tx_hash       text,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists zettapay_invoices_merchant_idx on zettapay_invoices (merchant_id);
create index if not exists zettapay_invoices_pending_idx on zettapay_invoices (status, expires_at);

-- ---------------------------------------------------------------------------
-- webhook endpoints (one per merchant; secret_enc is the HMAC signing secret)
-- ---------------------------------------------------------------------------
create table if not exists zettapay_webhooks (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references zettapay_merchants (id) on delete cascade,
  url          text not null,
  secret_enc   text not null,
  created_at   timestamptz not null default now()
);
create index if not exists zettapay_webhooks_merchant_idx on zettapay_webhooks (merchant_id);

-- ---------------------------------------------------------------------------
-- webhook delivery queue (retry curve + idempotent delivery)
-- ---------------------------------------------------------------------------
create table if not exists zettapay_webhook_events (
  id               text primary key,
  invoice_id       text not null references zettapay_invoices (id) on delete cascade,
  merchant_id      uuid not null references zettapay_merchants (id) on delete cascade,
  event_type       text not null,
  payload          jsonb not null default '{}'::jsonb,
  hmac             text,
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  delivered_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists zettapay_webhook_events_due_idx
  on zettapay_webhook_events (delivered_at, next_attempt_at);
create index if not exists zettapay_webhook_events_merchant_idx
  on zettapay_webhook_events (merchant_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security. The cloud service connects with the service-role key,
-- which BYPASSES RLS — these policies guard any direct access made with an
-- end-merchant JWT (e.g. a future dashboard), scoping every row to the merchant
-- owned by auth.uid(). Re-applying is safe: each policy is dropped first.
-- ---------------------------------------------------------------------------
alter table zettapay_merchants        enable row level security;
alter table zettapay_merchant_keys    enable row level security;
alter table zettapay_merchant_chains  enable row level security;
alter table zettapay_invoices          enable row level security;
alter table zettapay_webhooks          enable row level security;
alter table zettapay_webhook_events    enable row level security;

drop policy if exists zettapay_merchants_owner on zettapay_merchants;
create policy zettapay_merchants_owner on zettapay_merchants
  for all using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

drop policy if exists zettapay_merchant_keys_owner on zettapay_merchant_keys;
create policy zettapay_merchant_keys_owner on zettapay_merchant_keys
  for all using (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  ) with check (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  );

drop policy if exists zettapay_merchant_chains_owner on zettapay_merchant_chains;
create policy zettapay_merchant_chains_owner on zettapay_merchant_chains
  for all using (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  ) with check (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  );

drop policy if exists zettapay_invoices_owner on zettapay_invoices;
create policy zettapay_invoices_owner on zettapay_invoices
  for all using (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  ) with check (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  );

drop policy if exists zettapay_webhooks_owner on zettapay_webhooks;
create policy zettapay_webhooks_owner on zettapay_webhooks
  for all using (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  ) with check (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  );

drop policy if exists zettapay_webhook_events_owner on zettapay_webhook_events;
create policy zettapay_webhook_events_owner on zettapay_webhook_events
  for all using (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  ) with check (
    merchant_id in (select id from zettapay_merchants where auth_uid = auth.uid())
  );
