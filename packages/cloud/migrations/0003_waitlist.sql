-- Cloud early-access waitlist (the form on /app). Email only.
-- Additive and idempotent. RLS is enabled with no policy: only the service role
-- (the website's serverless function) can read or write.

create table if not exists zettapay_waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  source      text not null default 'app',
  created_at  timestamptz not null default now()
);
create unique index if not exists zettapay_waitlist_email_idx on zettapay_waitlist (email);

alter table zettapay_waitlist enable row level security;
