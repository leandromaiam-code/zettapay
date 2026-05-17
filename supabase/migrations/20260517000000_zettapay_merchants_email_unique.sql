-- ZettaPay merchant email uniqueness (Z39B).
--
-- The Vercel signup handler used to generate a new merchant_id + api_key on
-- every POST to /api/merchants/onboard, even when the same email signed up
-- twice. That polluted the merchant table with duplicates, leaked fresh
-- api_keys to anyone who could replay the request, and made it impossible
-- for an operator to know which row was canonical.
--
-- This migration:
--   1. Normalises any existing duplicate emails — keeps the oldest row, soft-
--      renames the rest to "<email>+dup-<id>@invalid" + flags them for
--      manual review via merchants.metadata->>'duplicate_of'.
--   2. Adds a CASE-INSENSITIVE UNIQUE constraint on email so the application
--      can rely on the database as the final source of truth even if the
--      in-process dedup gate (see api/_lib/merchant-store.ts) is bypassed
--      after a cold start.

begin;

-- 1. De-dupe existing rows if any. Safe to run on an empty table.
with ranked as (
  select
    id,
    email,
    row_number() over (
      partition by lower(email)
      order by created_at asc, id asc
    ) as rn
  from public.merchants
  where email is not null and length(email) > 0
)
update public.merchants m
   set email    = m.email || '+dup-' || m.id || '@invalid',
       metadata = coalesce(m.metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'duplicate_of', (
                         select r2.id
                           from ranked r2
                          where lower(r2.email) = lower(m.email)
                            and r2.rn = 1
                       ),
                       'duplicate_renamed_at', to_jsonb(now())
                     )
  from ranked r
 where r.id = m.id
   and r.rn > 1;

-- 2. Enforce the constraint. CITEXT would be cleaner; index on lower(email)
--    keeps the column type unchanged for downstream readers.
create unique index if not exists merchants_email_unique_ci
  on public.merchants (lower(email));

-- Surface the constraint name in pg_constraint listings (\d merchants) so
-- audits can find it without grepping pg_indexes.
alter table public.merchants
  add constraint merchants_email_unique unique using index merchants_email_unique_ci;

commit;
