-- ============================================================
-- Veridian Fabric — Squad Loop schema
-- Missions / Artifacts / Reasoning steps
-- ============================================================

create table if not exists fabric_squad_missions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  squad text not null default 'dev'
    check (squad in ('dev','marketing','sales','ops')),
  name text not null,
  description text,
  phase text not null default 'plan'
    check (phase in ('plan','execution','improvement','done')),
  status text not null default 'pending'
    check (status in ('pending','running','succeeded','failed','paused')),
  progress numeric default 0 check (progress >= 0 and progress <= 1),
  source text,
  hipotese_id uuid references fabric_layer1_hipoteses(id) on delete set null,
  created_at timestamptz default now(),
  started_at timestamptz,
  completed_at timestamptz,
  next_check_at timestamptz
);

create index if not exists fabric_idx_missions_ws_phase
  on fabric_squad_missions(workspace_id, phase, created_at desc);

create table if not exists fabric_squad_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  mission_id uuid references fabric_squad_missions(id) on delete cascade,
  kind text not null,
  label text not null,
  url text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists fabric_idx_artifacts_mission
  on fabric_squad_artifacts(mission_id, created_at desc);

create table if not exists fabric_squad_reasoning (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  mission_id uuid references fabric_squad_missions(id) on delete cascade,
  step int not null default 0,
  role text not null default 'assistant'
    check (role in ('assistant','tool','observation','plan')),
  text text not null,
  ts timestamptz default now()
);

create index if not exists fabric_idx_reasoning_mission
  on fabric_squad_reasoning(mission_id, step);

-- RLS
alter table fabric_squad_missions  enable row level security;
alter table fabric_squad_artifacts enable row level security;
alter table fabric_squad_reasoning enable row level security;

drop policy if exists "members rw missions" on fabric_squad_missions;
create policy "members rw missions" on fabric_squad_missions
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members rw artifacts" on fabric_squad_artifacts;
create policy "members rw artifacts" on fabric_squad_artifacts
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members rw reasoning" on fabric_squad_reasoning;
create policy "members rw reasoning" on fabric_squad_reasoning
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));
