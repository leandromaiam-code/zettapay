-- Z8.2 — Postgres mirror of the SQLite runtime schema (packages/api/src/db/index.ts).
-- Premise 13: SQLite is dev-only; production rides Supabase Postgres.
-- This is the foundational migration; later files (zettapay_api_keys,
-- risk_assessments) extend it. RLS is intentionally NOT enabled here for
-- back-office tables that the application service-role accesses via the
-- pg pool — the existing per-table migrations turn it on where needed.

create extension if not exists pgcrypto;

-- ============================================================================
-- merchants — root tenant. auth.uid() is bound to merchants.id at signup.
-- ============================================================================

create table if not exists public.merchants (
  id                                text primary key,
  name                              text not null,
  wallet_address                    text not null unique,
  email                             text not null unique,
  api_key                           text not null unique,
  webhook_url                       text,
  webhook_secret                    text,
  velocity_max_payments_per_minute  integer not null default 5,
  velocity_max_amount_per_hour      numeric not null default 1000,
  deleted_at                        timestamptz,
  fraud_block_threshold             integer not null default 0,
  fraud_review_threshold            integer not null default 70 check (fraud_review_threshold between 0 and 100),
  coinflow_enabled                  boolean not null default false,
  coinflow_auto_settle              boolean not null default false,
  coinflow_merchant_id              text,
  coinflow_bank_account_id          text,
  pix_enabled                       boolean not null default false,
  pix_auto_settle                   boolean not null default false,
  pix_provider                      text,
  pix_provider_merchant_id          text,
  pix_key                           text,
  pix_key_type                      text,
  created_at                        timestamptz not null default now()
);

create index if not exists merchants_email_idx on public.merchants (email);
create index if not exists merchants_api_key_idx on public.merchants (api_key);

-- ============================================================================
-- payments — every payment intent the API records (any chain/currency).
-- ============================================================================

create table if not exists public.payments (
  id              text primary key,
  merchant_id     text not null references public.merchants (id) on delete restrict,
  amount_usdc     numeric not null,
  payer_wallet    text not null,
  status          text not null check (status in ('pending','processing','completed','failed','refunded')),
  tx_signature    text,
  error_message   text,
  metadata_json   jsonb,
  currency        text not null default 'USDC',
  chain           text not null default 'solana',
  payer_ip        text,
  payer_country   text,
  agent_identity_id text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists payments_merchant_idx on public.payments (merchant_id);
create index if not exists payments_status_idx on public.payments (status);
create index if not exists payments_merchant_created_at_idx
  on public.payments (merchant_id, created_at);
create index if not exists payments_merchant_payer_created_at_idx
  on public.payments (merchant_id, payer_wallet, created_at);
create unique index if not exists payments_tx_signature_uidx
  on public.payments (tx_signature) where tx_signature is not null;

-- ============================================================================
-- refunds — Z13.5. Each row captures the merchant's signed authorization.
-- ============================================================================

create table if not exists public.refunds (
  id              text primary key,
  payment_id      text not null unique references public.payments (id) on delete restrict,
  merchant_id     text not null references public.merchants (id) on delete restrict,
  amount_usdc     numeric not null,
  currency        text not null default 'USDC',
  reason          text not null,
  status          text not null check (status in ('pending','processing','completed','failed')),
  tx_signature    text,
  error_message   text,
  signed_by       text not null,
  signed_at       timestamptz not null,
  signature       text not null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists refunds_merchant_idx on public.refunds (merchant_id);
create index if not exists refunds_status_idx on public.refunds (status);
create unique index if not exists refunds_tx_signature_uidx
  on public.refunds (tx_signature) where tx_signature is not null;

-- ============================================================================
-- audit_journal — append-only. Triggers reject UPDATE/DELETE.
-- ============================================================================

create table if not exists public.audit_journal (
  id          bigserial primary key,
  actor       text not null,
  event       text not null,
  entity_type text,
  entity_id   text,
  reason      text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_journal_entity_idx
  on public.audit_journal (entity_type, entity_id);
create index if not exists audit_journal_event_idx on public.audit_journal (event);
create index if not exists audit_journal_actor_idx on public.audit_journal (actor);
create index if not exists audit_journal_created_at_idx on public.audit_journal (created_at);

create or replace function public.audit_journal_reject_mutation()
  returns trigger
  language plpgsql
as $$
begin
  raise exception 'audit_journal is append-only — % rejected', tg_op;
end;
$$;

drop trigger if exists audit_journal_no_update on public.audit_journal;
create trigger audit_journal_no_update
  before update on public.audit_journal
  for each row execute function public.audit_journal_reject_mutation();

drop trigger if exists audit_journal_no_delete on public.audit_journal;
create trigger audit_journal_no_delete
  before delete on public.audit_journal
  for each row execute function public.audit_journal_reject_mutation();

-- ============================================================================
-- idempotency_keys — Z8.3. Protects POST /pay and /merchants/register.
-- ============================================================================

create table if not exists public.idempotency_keys (
  id              bigserial primary key,
  scope           text not null,
  key             text not null,
  request_hash    text not null,
  response_status integer not null,
  response_body   text not null,
  created_at      timestamptz not null default now(),
  unique (scope, key)
);

create index if not exists idempotency_keys_created_at_idx
  on public.idempotency_keys (created_at);

-- ============================================================================
-- webhook_events — Z10.1. Stripe-grade lifecycle (pending/sent/failed/dead).
-- ============================================================================

create table if not exists public.webhook_events (
  id                 text primary key,
  event_id           text not null,
  url                text not null,
  payload_json       jsonb not null,
  status             text not null check (status in ('pending','sent','failed','dead')),
  attempt_count      integer not null default 0,
  max_attempts       integer not null,
  last_attempt_at    timestamptz,
  last_status_code   integer,
  last_error         text,
  dead_letter_reason text,
  delivered_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists webhook_events_event_id_uidx
  on public.webhook_events (event_id);
create index if not exists webhook_events_status_idx
  on public.webhook_events (status);
create index if not exists webhook_events_last_attempt_at_idx
  on public.webhook_events (last_attempt_at);

-- ============================================================================
-- coinflow_settlements — USDC → bank withdrawals.
-- ============================================================================

create table if not exists public.coinflow_settlements (
  id              text primary key,
  merchant_id     text not null references public.merchants (id) on delete restrict,
  payment_id      text references public.payments (id) on delete set null,
  amount_usdc     numeric not null,
  fee_usdc        numeric not null,
  net_usdc        numeric not null,
  fee_bps         integer not null,
  bank_account_id text not null,
  withdrawal_id   text,
  status          text not null check (status in ('pending','processing','completed','failed')),
  error_message   text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists coinflow_settlements_merchant_idx
  on public.coinflow_settlements (merchant_id);
create index if not exists coinflow_settlements_status_idx
  on public.coinflow_settlements (status);
create unique index if not exists coinflow_settlements_payment_uidx
  on public.coinflow_settlements (payment_id) where payment_id is not null;

-- ============================================================================
-- subscriptions — recurring charges with permanent customer authorization.
-- ============================================================================

create table if not exists public.subscriptions (
  id                          text primary key,
  merchant_id                 text not null references public.merchants (id) on delete restrict,
  customer_wallet             text not null,
  amount                      numeric not null check (amount > 0),
  currency                    text not null default 'USDC',
  interval                    text not null check (interval in ('daily','weekly','monthly')),
  status                      text not null check (status in ('active','paused','canceled')),
  next_charge_at              timestamptz not null,
  last_charge_at              timestamptz,
  metadata_json               jsonb,
  authorization_signature     text,
  authorization_public_key    text,
  authorization_signed_at     timestamptz,
  failed_charge_count         integer not null default 0,
  last_failure_reason         text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists subscriptions_merchant_idx on public.subscriptions (merchant_id);
create index if not exists subscriptions_status_idx on public.subscriptions (status);
create index if not exists subscriptions_next_charge_idx
  on public.subscriptions (next_charge_at) where status = 'active';
create index if not exists subscriptions_customer_wallet_idx
  on public.subscriptions (customer_wallet);

-- ============================================================================
-- funnel_events — Z14.3. view → checkout → completed.
-- ============================================================================

create table if not exists public.funnel_events (
  id              text primary key,
  merchant_id     text not null references public.merchants (id) on delete cascade,
  session_id      text not null,
  event_type      text not null check (event_type in ('view','checkout','completed')),
  payment_id      text references public.payments (id) on delete set null,
  metadata_json   jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists funnel_events_merchant_idx
  on public.funnel_events (merchant_id);
create index if not exists funnel_events_merchant_created_at_idx
  on public.funnel_events (merchant_id, created_at);
create index if not exists funnel_events_merchant_type_created_at_idx
  on public.funnel_events (merchant_id, event_type, created_at);
create unique index if not exists funnel_events_session_type_uidx
  on public.funnel_events (merchant_id, session_id, event_type);

-- ============================================================================
-- kyc — Sumsub/Persona verifications and uploaded documents.
-- ============================================================================

create table if not exists public.kyc_verifications (
  id              text primary key,
  merchant_id     text not null unique references public.merchants (id) on delete cascade,
  provider        text not null check (provider in ('sumsub','persona')),
  external_id     text,
  applicant_id    text,
  level_name      text,
  status          text not null check (status in ('pending','in_review','approved','rejected','blocked')),
  review_answer   text,
  review_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists kyc_verifications_status_idx on public.kyc_verifications (status);
create unique index if not exists kyc_verifications_external_uidx
  on public.kyc_verifications (provider, external_id) where external_id is not null;
create unique index if not exists kyc_verifications_applicant_uidx
  on public.kyc_verifications (provider, applicant_id) where applicant_id is not null;

create table if not exists public.kyc_documents (
  id              text primary key,
  verification_id text not null references public.kyc_verifications (id) on delete cascade,
  doc_type        text not null,
  doc_subtype     text,
  file_name       text,
  mime_type       text,
  size_bytes      integer,
  external_ref    text,
  created_at      timestamptz not null default now()
);

create index if not exists kyc_documents_verification_idx
  on public.kyc_documents (verification_id);

-- ============================================================================
-- shopify_installations — OAuth lifecycle.
-- ============================================================================

create table if not exists public.shopify_installations (
  id              text primary key,
  shop_domain     text not null unique,
  merchant_id     text not null references public.merchants (id) on delete restrict,
  access_token    text,
  scope           text,
  status          text not null check (status in ('pending','installed','uninstalled')),
  oauth_nonce     text,
  created_at      timestamptz not null default now(),
  installed_at    timestamptz,
  uninstalled_at  timestamptz,
  updated_at      timestamptz not null default now()
);

create index if not exists shopify_installations_merchant_idx
  on public.shopify_installations (merchant_id);
create index if not exists shopify_installations_status_idx
  on public.shopify_installations (status);

-- ============================================================================
-- registry_tools — Z20 marketplace.
-- ============================================================================

create table if not exists public.registry_tools (
  id                 text primary key,
  merchant_id        text not null references public.merchants (id) on delete cascade,
  slug               text not null unique,
  name               text not null,
  description        text not null,
  category           text not null,
  endpoint_url       text not null,
  price_usdc         numeric not null check (price_usdc >= 0),
  currency           text not null default 'USDC',
  input_schema_json  jsonb not null,
  tags_json          jsonb not null default '[]'::jsonb,
  homepage_url       text,
  docs_url           text,
  icon_url           text,
  status             text not null check (status in ('draft','published','suspended')),
  install_count      integer not null default 0,
  call_count         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists registry_tools_merchant_idx on public.registry_tools (merchant_id);
create index if not exists registry_tools_status_idx on public.registry_tools (status);
create index if not exists registry_tools_category_idx on public.registry_tools (category);
create index if not exists registry_tools_status_category_idx
  on public.registry_tools (status, category);

-- ============================================================================
-- agent identities + replay-defeating nonces + per-merchant spending limits.
-- ============================================================================

create table if not exists public.agent_identities (
  id              text primary key,
  provider        text not null,
  agent_id        text not null,
  public_key      text not null unique,
  display_name    text,
  owner_email     text,
  payout_wallet   text,
  status          text not null check (status in ('active','revoked')) default 'active',
  registered_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists agent_identities_provider_agent_uidx
  on public.agent_identities (provider, agent_id);
create index if not exists agent_identities_status_idx on public.agent_identities (status);

create table if not exists public.agent_identity_nonces (
  id           bigserial primary key,
  identity_id  text not null references public.agent_identities (id) on delete cascade,
  nonce        text not null,
  used_at      timestamptz not null default now(),
  unique (identity_id, nonce)
);

create index if not exists agent_identity_nonces_used_at_idx
  on public.agent_identity_nonces (used_at);

create table if not exists public.agent_spending_limits (
  id                 text primary key,
  merchant_id        text not null references public.merchants (id) on delete cascade,
  agent_identity_id  text not null references public.agent_identities (id) on delete cascade,
  max_per_request    numeric,
  daily_cap          numeric,
  frozen             boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists agent_spending_limits_merchant_agent_uidx
  on public.agent_spending_limits (merchant_id, agent_identity_id);
create index if not exists agent_spending_limits_merchant_idx
  on public.agent_spending_limits (merchant_id);

-- Backfill payments → agent_identities FK after both tables exist.
alter table public.payments
  drop constraint if exists payments_agent_identity_fkey;
alter table public.payments
  add constraint payments_agent_identity_fkey
  foreign key (agent_identity_id) references public.agent_identities (id) on delete set null;

create index if not exists payments_merchant_agent_created_at_idx
  on public.payments (merchant_id, agent_identity_id, created_at);

-- ============================================================================
-- treasury_reserve_entries — Z22.3. Operational reserve ledger.
-- ============================================================================

create table if not exists public.treasury_reserve_entries (
  id              text primary key,
  kind            text not null check (kind in ('credit','debit')),
  amount_usdc     numeric not null check (amount_usdc > 0),
  reason          text not null check (reason in (
    'tpv_contribution','manual_top_up','incident_refund','operational_drawdown','rebalance'
  )),
  payment_id      text references public.payments (id) on delete set null,
  merchant_id     text references public.merchants (id) on delete set null,
  external_ref    text,
  memo            text,
  actor           text not null,
  created_at      timestamptz not null default now()
);

create index if not exists treasury_reserve_entries_kind_idx
  on public.treasury_reserve_entries (kind);
create index if not exists treasury_reserve_entries_reason_idx
  on public.treasury_reserve_entries (reason);
create index if not exists treasury_reserve_entries_created_at_idx
  on public.treasury_reserve_entries (created_at);
create index if not exists treasury_reserve_entries_payment_idx
  on public.treasury_reserve_entries (payment_id);
create unique index if not exists treasury_reserve_entries_payment_reason_uidx
  on public.treasury_reserve_entries (payment_id, reason)
  where payment_id is not null and reason = 'tpv_contribution';

-- ============================================================================
-- agent_to_agent_payments — Z20.4.
-- ============================================================================

create table if not exists public.agent_to_agent_payments (
  id                       text primary key,
  payer_agent_identity_id  text not null references public.agent_identities (id) on delete restrict,
  payee_agent_identity_id  text not null references public.agent_identities (id) on delete restrict,
  payer_wallet             text not null,
  payee_wallet             text not null,
  amount_usdc              numeric not null check (amount_usdc > 0),
  currency                 text not null default 'USDC',
  task_ref                 text,
  status                   text not null check (status in ('pending','processing','completed','failed')),
  tx_signature             text,
  error_message            text,
  metadata_json            jsonb,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create index if not exists a2a_payments_payer_idx
  on public.agent_to_agent_payments (payer_agent_identity_id, created_at);
create index if not exists a2a_payments_payee_idx
  on public.agent_to_agent_payments (payee_agent_identity_id, created_at);
create index if not exists a2a_payments_status_idx
  on public.agent_to_agent_payments (status);
create unique index if not exists a2a_payments_tx_signature_uidx
  on public.agent_to_agent_payments (tx_signature) where tx_signature is not null;
create index if not exists a2a_payments_task_ref_idx
  on public.agent_to_agent_payments (task_ref) where task_ref is not null;

-- ============================================================================
-- onchain_payments — Z9.5. Indexer mirror of on-chain Payment receipts.
-- ============================================================================

create table if not exists public.onchain_payments (
  pda              text primary key,
  merchant_binding text not null,
  payment_id_hex   text not null,
  amount           text not null,
  tx_signature     text not null unique,
  recorded_at      bigint not null,
  slot             bigint,
  ingested_at      timestamptz not null default now()
);

create index if not exists onchain_payments_binding_idx
  on public.onchain_payments (merchant_binding, recorded_at);
create index if not exists onchain_payments_recorded_idx
  on public.onchain_payments (recorded_at);
create unique index if not exists onchain_payments_binding_paymentid_uidx
  on public.onchain_payments (merchant_binding, payment_id_hex);

-- ============================================================================
-- pix_settlements — Z12.2. USDC → BRL via Bitpreço/Transfero.
-- ============================================================================

create table if not exists public.pix_settlements (
  id              text primary key,
  merchant_id     text not null references public.merchants (id) on delete restrict,
  payment_id      text references public.payments (id) on delete set null,
  provider        text not null check (provider in ('bitpreco','transfero')),
  amount_usdc     numeric not null,
  fee_usdc        numeric not null,
  net_usdc        numeric not null,
  fee_bps         integer not null,
  pix_key         text not null,
  pix_key_type    text not null check (pix_key_type in ('cpf','cnpj','email','phone','random')),
  withdrawal_id   text,
  quoted_brl      numeric,
  status          text not null check (status in ('pending','processing','completed','failed')),
  error_message   text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists pix_settlements_merchant_idx on public.pix_settlements (merchant_id);
create index if not exists pix_settlements_status_idx on public.pix_settlements (status);
create unique index if not exists pix_settlements_payment_uidx
  on public.pix_settlements (payment_id) where payment_id is not null;

-- ============================================================================
-- bridge_intents — Z11. Cross-chain USDC bridges via CCTP-style attestations.
-- ============================================================================

create table if not exists public.bridge_intents (
  id                    text primary key,
  merchant_id           text not null references public.merchants (id) on delete restrict,
  source_chain          text not null,
  source_network        text not null,
  source_currency       text not null,
  destination_currency  text not null,
  recipient_wallet      text not null,
  amount_usdc           numeric not null,
  fee_usdc              numeric not null,
  net_usdc              numeric not null,
  fee_bps               integer not null,
  source_tx_hash        text,
  attestation_hash      text,
  attestation_status    text,
  redemption_signature  text,
  payment_id            text references public.payments (id) on delete set null,
  status                text not null check (status in ('pending','burned','attested','completed','failed')),
  error_message         text,
  metadata_json         jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists bridge_intents_merchant_idx on public.bridge_intents (merchant_id);
create index if not exists bridge_intents_status_idx on public.bridge_intents (status);
create unique index if not exists bridge_intents_source_tx_uidx
  on public.bridge_intents (source_tx_hash) where source_tx_hash is not null;

-- ============================================================================
-- aml_alerts + aml_sars — Z13.x. Sanction/screen alerts and filed SARs.
-- ============================================================================

create table if not exists public.aml_alerts (
  id              text primary key,
  merchant_id     text not null references public.merchants (id) on delete cascade,
  payment_id      text references public.payments (id) on delete set null,
  payer_wallet    text,
  rule            text not null,
  severity        text not null check (severity in ('low','medium','high','critical')),
  status          text not null check (status in ('open','reviewed','dismissed','escalated')),
  score           integer not null default 0,
  summary         text not null,
  evidence_json   jsonb not null default '{}'::jsonb,
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_notes    text,
  sar_id          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists aml_alerts_merchant_idx on public.aml_alerts (merchant_id);
create index if not exists aml_alerts_merchant_status_idx
  on public.aml_alerts (merchant_id, status);
create index if not exists aml_alerts_payment_idx on public.aml_alerts (payment_id);
create index if not exists aml_alerts_payer_idx on public.aml_alerts (payer_wallet);
create index if not exists aml_alerts_created_at_idx on public.aml_alerts (created_at);

create table if not exists public.aml_sars (
  id                  text primary key,
  merchant_id         text not null references public.merchants (id) on delete restrict,
  reference           text not null unique,
  status              text not null check (status in ('draft','filed','closed')),
  narrative           text not null,
  subject_wallet      text,
  subject_summary     text,
  total_amount_usdc   numeric not null default 0,
  alert_count         integer not null default 0,
  filed_at            timestamptz,
  filed_by            text,
  external_filing_id  text,
  payload_json        jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists aml_sars_merchant_idx on public.aml_sars (merchant_id);
create index if not exists aml_sars_status_idx on public.aml_sars (status);
create index if not exists aml_sars_created_at_idx on public.aml_sars (created_at);

-- ============================================================================
-- consent_records — Z21.4. LGPD/GDPR ledger; append-only by convention.
-- ============================================================================

create table if not exists public.consent_records (
  id              text primary key,
  subject_type    text not null check (subject_type in ('merchant','wallet')),
  subject_id      text not null,
  purpose         text not null,
  granted         boolean not null,
  granted_at      timestamptz,
  withdrawn_at    timestamptz,
  source          text,
  metadata_json   jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists consent_records_subject_idx
  on public.consent_records (subject_type, subject_id);
create index if not exists consent_records_subject_purpose_idx
  on public.consent_records (subject_type, subject_id, purpose);
create index if not exists consent_records_created_at_idx
  on public.consent_records (created_at);
