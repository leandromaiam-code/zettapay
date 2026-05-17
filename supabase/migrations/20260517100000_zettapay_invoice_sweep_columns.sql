-- Z51: sweep-cron support columns on the Z45 invoice table.
--
-- The Z45 migration already includes `swept_at` plus a 'swept' status value,
-- but no place to record the consolidation tx hash and no per-row attempt
-- counter. Both are required by the sweep worker for:
--   * Idempotency — re-check the prior tx on the chain before re-broadcasting.
--   * Operational visibility — flag invoices that keep failing so on-call can
--     intervene before WhatsApp alerts pile up.
--
-- Guarded so Z51 can land before, with, or after Z45 without ordering pain:
--   * Skips entirely if the Z45 table does not yet exist.
--   * Uses IF NOT EXISTS / IF EXISTS for every object touched.

do $$
begin
  if to_regclass('public.zettapay_invoices') is null then
    raise notice 'zettapay_invoices not present yet (Z45 not applied) — skipping Z51 sweep columns';
    return;
  end if;

  alter table public.zettapay_invoices
    add column if not exists sweep_tx_hash text;

  alter table public.zettapay_invoices
    add column if not exists sweep_attempts integer not null default 0;

  alter table public.zettapay_invoices
    add column if not exists last_sweep_attempt_at timestamptz;
end
$$;

-- Index supports the worker's main query: "give me confirmed invoices that
-- haven't been swept yet, oldest first." Partial so the index stays small —
-- once an invoice is swept it falls out and never re-enters.
create index if not exists zettapay_invoices_unswept_idx
  on public.zettapay_invoices (confirmed_at)
  where status = 'confirmed' and swept_at is null;

-- Same index for the sweep_tx_hash idempotency check (look up by chain +
-- consolidation tx so the worker can answer "did this tx already confirm?").
create index if not exists zettapay_invoices_sweep_tx_idx
  on public.zettapay_invoices (chain, sweep_tx_hash)
  where sweep_tx_hash is not null;
