-- ========================================================
-- Veridian Fabric V0 — schema inicial
-- Convenção: fabric_<submodulo>_<recurso>
--   core    -> workspaces e membership
--   layer0  -> premissas centrais
--   layer1  -> backlog de hipóteses
--   signals -> métricas externas
--   audit   -> journal
-- Funções: fabric_fn_*  | Triggers: fabric_trg_*
-- ========================================================

-- ---------- TABLES ----------

create table if not exists fabric_core_workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  brand_color text default '#9B7F4E',
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);

create table if not exists fabric_core_members (
  workspace_id uuid references fabric_core_workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','operator','viewer')),
  created_at timestamptz default now(),
  primary key (workspace_id, user_id)
);

create table if not exists fabric_layer0_premissas (
  workspace_id uuid primary key references fabric_core_workspaces(id) on delete cascade,
  content text not null default '',
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists fabric_layer1_hipoteses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  source text not null check (source in ('benchmark','nps','churn','manual')),
  title text not null,
  body text,
  score numeric default 0,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','deferred')),
  created_at timestamptz default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id)
);

create index if not exists fabric_idx_hipoteses_workspace on fabric_layer1_hipoteses(workspace_id, status, created_at desc);

create table if not exists fabric_audit_journal (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  actor text not null default 'system',
  created_at timestamptz default now()
);

create index if not exists fabric_idx_journal_workspace on fabric_audit_journal(workspace_id, created_at desc);

create table if not exists fabric_signals_metrics (
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  captured_at date not null,
  nps numeric,
  churn_rate numeric,
  active_users int,
  primary key (workspace_id, captured_at)
);

-- ---------- FUNCTIONS ----------

create or replace function fabric_fn_has_access(ws uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from fabric_core_members
    where workspace_id = ws and user_id = auth.uid()
  );
$$;

create or replace function fabric_fn_bootstrap_workspace()
returns trigger language plpgsql security definer as $$
begin
  insert into fabric_core_members(workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  insert into fabric_layer0_premissas(workspace_id, content)
  values (new.id, '# Premissas Centrais' || chr(10) || chr(10) || 'Editar aqui.');
  insert into fabric_audit_journal(workspace_id, event_type, payload, actor)
  values (new.id, 'workspace_created', jsonb_build_object('slug', new.slug, 'name', new.name), 'system');
  return new;
end $$;

drop trigger if exists fabric_trg_bootstrap_workspace on fabric_core_workspaces;
create trigger fabric_trg_bootstrap_workspace
  after insert on fabric_core_workspaces
  for each row execute function fabric_fn_bootstrap_workspace();

-- ---------- RLS ----------

alter table fabric_core_workspaces      enable row level security;
alter table fabric_core_members         enable row level security;
alter table fabric_layer0_premissas     enable row level security;
alter table fabric_layer1_hipoteses     enable row level security;
alter table fabric_audit_journal        enable row level security;
alter table fabric_signals_metrics      enable row level security;

drop policy if exists "members read workspaces" on fabric_core_workspaces;
create policy "members read workspaces" on fabric_core_workspaces
  for select using (fabric_fn_has_access(id));

drop policy if exists "owners update workspaces" on fabric_core_workspaces;
create policy "owners update workspaces" on fabric_core_workspaces
  for update using (owner_id = auth.uid());

drop policy if exists "users create workspaces" on fabric_core_workspaces;
create policy "users create workspaces" on fabric_core_workspaces
  for insert with check (owner_id = auth.uid());

drop policy if exists "owners delete workspaces" on fabric_core_workspaces;
create policy "owners delete workspaces" on fabric_core_workspaces
  for delete using (owner_id = auth.uid());

drop policy if exists "members read members" on fabric_core_members;
create policy "members read members" on fabric_core_members
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "owners manage members" on fabric_core_members;
create policy "owners manage members" on fabric_core_members
  for all using (
    exists (select 1 from fabric_core_workspaces w
            where w.id = workspace_id and w.owner_id = auth.uid())
  );

drop policy if exists "members rw premissas" on fabric_layer0_premissas;
create policy "members rw premissas" on fabric_layer0_premissas
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members rw hipoteses" on fabric_layer1_hipoteses;
create policy "members rw hipoteses" on fabric_layer1_hipoteses
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members read journal" on fabric_audit_journal;
create policy "members read journal" on fabric_audit_journal
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "members write journal" on fabric_audit_journal;
create policy "members write journal" on fabric_audit_journal
  for insert with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members read metrics" on fabric_signals_metrics;
create policy "members read metrics" on fabric_signals_metrics
  for select using (fabric_fn_has_access(workspace_id));
