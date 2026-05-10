-- Z13.4 fraud risk scoring (Postgres mirror of the SQLite runtime schema in
-- packages/api/src/db/index.ts). Premises 9 & 13: SQLite is dev-only;
-- production rides Supabase Postgres with RLS scoping every row to its
-- owning merchant via the auth context.

alter table public.merchants
  add column if not exists fraud_review_threshold integer not null default 70
  check (fraud_review_threshold between 0 and 100);

create table if not exists public.risk_assessments (
  id              text primary key,
  payment_id      text references public.payments (id) on delete set null,
  merchant_id     text not null references public.merchants (id) on delete cascade,
  payer_wallet    text not null,
  amount_usdc     numeric not null,
  score           integer not null check (score between 0 and 100),
  threshold       integer not null,
  signals_json    jsonb not null,
  decision        text not null check (decision in ('allow','review')),
  review_status   text check (review_status in ('pending','approved','rejected')),
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_reason   text,
  created_at      timestamptz not null default now()
);

create index if not exists risk_assessments_merchant_idx
  on public.risk_assessments (merchant_id);

create index if not exists risk_assessments_merchant_review_idx
  on public.risk_assessments (merchant_id, review_status, created_at)
  where review_status is not null;

create index if not exists risk_assessments_payment_idx
  on public.risk_assessments (payment_id) where payment_id is not null;

create index if not exists risk_assessments_created_at_idx
  on public.risk_assessments (created_at);

alter table public.risk_assessments enable row level security;

-- Merchants only see/mutate assessments scoped to their own merchant_id.
-- The `auth.uid()` value is bound to merchants.id by application code at
-- signup (same pattern as zettapay_api_keys).
create policy "merchant owns risk assessments: select"
  on public.risk_assessments
  for select
  using (merchant_id = auth.uid()::text);

create policy "merchant owns risk assessments: insert"
  on public.risk_assessments
  for insert
  with check (merchant_id = auth.uid()::text);

create policy "merchant owns risk assessments: update"
  on public.risk_assessments
  for update
  using (merchant_id = auth.uid()::text)
  with check (merchant_id = auth.uid()::text);

-- Hard delete is intentionally forbidden — assessments are immutable history.
