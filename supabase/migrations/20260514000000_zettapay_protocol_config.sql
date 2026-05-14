-- Z29.4 — Canonical record of the ZettaPay on-chain program per Solana cluster.
--
-- One row per network (mainnet-beta, devnet, testnet, localnet). The Fabric
-- mainnet-live script (scripts/z29-4-mainnet-program-live.ts) upserts the
-- mainnet-beta row immediately after the human operator signs the deploy with
-- Phantom (Z29.3). The runtime API reads this table on boot to resolve the
-- program id, replacing the stale env var fallback.
--
-- RLS: enabled with no policies. PostgREST/anon access is denied; only the
-- service-role key (server-side scripts, runtime API) can read/write — see
-- premise 21 (service role never exposed client-side).

create table if not exists public.zettapay_protocol_config (
  network         text primary key
                  check (network in ('mainnet-beta', 'devnet', 'testnet', 'localnet')),
  program_id      text not null
                  check (char_length(program_id) between 32 and 44),
  deployed_at     timestamptz not null,
  verified_at     timestamptz not null default now(),
  verifier_note   text,
  updated_at      timestamptz not null default now()
);

create index if not exists zettapay_protocol_config_program_idx
  on public.zettapay_protocol_config (program_id);

alter table public.zettapay_protocol_config enable row level security;
