-- Z40: Email verification via Supabase Auth OTP.
-- Adds email_verified_at + supabase_user_id + status columns to merchants so
-- the merchant lifecycle can express pending_verification → active → disabled.
-- The /api/merchants/register endpoint sends an OTP via auth.signInWithOtp and
-- only flips status to 'active' after /api/merchants/verify confirms the code.

-- Use IF EXISTS so this migration is safe to run against environments where
-- the merchants table mirror has not been provisioned yet (Vercel-only lane).
alter table if exists public.merchants
  add column if not exists email_verified_at timestamptz;

alter table if exists public.merchants
  add column if not exists supabase_user_id uuid references auth.users(id) on delete set null;

alter table if exists public.merchants
  add column if not exists status text not null default 'pending_verification'
    check (status in ('pending_verification', 'active', 'disabled'));

create index if not exists merchants_supabase_user_idx
  on public.merchants (supabase_user_id) where supabase_user_id is not null;

create index if not exists merchants_status_idx
  on public.merchants (status);

-- Backfill legacy rows: any merchant predating this migration was either
-- onboarded manually (so we trust the email) or is dev/test data. Promote
-- them to 'active' so they don't get locked out by the new gate.
update public.merchants
   set status = 'active',
       email_verified_at = coalesce(email_verified_at, created_at)
 where status = 'pending_verification'
   and created_at is not null;
