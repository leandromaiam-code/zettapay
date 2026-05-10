-- ZettaPay API key store (canonical Postgres mirror of the SQLite runtime
-- schema in packages/api/src/db/index.ts). Premises 9 & 13: SQLite is dev-only;
-- production rides Supabase Postgres with RLS scoping every row to its owning
-- merchant via the auth context.

create table if not exists public.zettapay_api_keys (
  id           text primary key,
  merchant_id  text not null references public.merchants (id) on delete cascade,
  public_key   text not null unique,
  secret_hash  text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists zettapay_api_keys_merchant_idx
  on public.zettapay_api_keys (merchant_id);

create index if not exists zettapay_api_keys_active_idx
  on public.zettapay_api_keys (merchant_id)
  where revoked_at is null;

alter table public.zettapay_api_keys enable row level security;

-- A merchant (acting under their authenticated Supabase session) only ever
-- sees / mutates rows it owns. The `auth.uid()` value is bound to the
-- merchants.id by application code at signup.
create policy "merchant owns api keys: select"
  on public.zettapay_api_keys
  for select
  using (merchant_id = auth.uid()::text);

create policy "merchant owns api keys: insert"
  on public.zettapay_api_keys
  for insert
  with check (merchant_id = auth.uid()::text);

create policy "merchant owns api keys: update"
  on public.zettapay_api_keys
  for update
  using (merchant_id = auth.uid()::text)
  with check (merchant_id = auth.uid()::text);

-- Hard delete is intentionally forbidden — keys are revoked via revoked_at.
