-- Z25.4 on-chain program registry (Postgres mirror of the SQLite runtime
-- schema in packages/api/src/db/index.ts). One row per (program_name,
-- cluster) pair. The devnet deploy automation
-- (`scripts/deploy-devnet-core.sh`) upserts here after `solana program
-- deploy` so off-chain services (SDK, API, smoke test) can resolve the
-- live program id without a config redeploy.
--
-- This table is GLOBAL, not merchant-scoped: every authenticated user is
-- allowed to read it (the SDK calls this at boot), but only the service
-- role may insert/update/delete. Mutation flows through `deploy-devnet`
-- or a human operator using a service-role key — never an end-merchant
-- session.

create table if not exists public.zettapay_protocol_config (
  id                  text primary key,
  program_name        text not null,
  cluster             text not null
    check (cluster in ('mainnet-beta','devnet','testnet','localnet')),
  program_id          text not null,
  artifact_sha256     text,
  artifact_size       integer,
  deployer_pubkey     text,
  deploy_tx_signature text,
  deployed_at         timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (program_name, cluster)
);

create index if not exists zettapay_protocol_config_program_idx
  on public.zettapay_protocol_config (program_name);

create index if not exists zettapay_protocol_config_cluster_idx
  on public.zettapay_protocol_config (cluster);

alter table public.zettapay_protocol_config enable row level security;

-- Public read: any authenticated session may resolve the active program
-- id for a given cluster. The data is fundamentally a published constant
-- (the program account is queryable on-chain by anyone).
create policy "protocol config: public read"
  on public.zettapay_protocol_config
  for select
  using (true);

-- Mutation is service-role only. Supabase bypasses RLS for the service
-- role automatically — these explicit deny-style policies make the
-- intent loud in case the role evaluation ever changes upstream.
create policy "protocol config: no insert via session"
  on public.zettapay_protocol_config
  for insert
  with check (false);

create policy "protocol config: no update via session"
  on public.zettapay_protocol_config
  for update
  using (false)
  with check (false);

create policy "protocol config: no delete via session"
  on public.zettapay_protocol_config
  for delete
  using (false);
