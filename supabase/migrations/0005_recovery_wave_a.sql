-- ============================================================
-- Veridian Fabric — FR.1 Recovery Wave A · Backend Infra
-- Sprint 2.7 (Feature Recovery)
--
-- Re-aplica em camada de banco a infra de seguranca do AutoDev
-- que foi perdida no rollback do mass-merge:
--   1. Cost ledger        (token + USD por mission/agent run)
--   2. Kill switch        (autodev_state + circuit breaker em 3 falhas)
--   3. Premissas validator (eventos de violacao append-only)
--   4. File guard rules    (allow/deny patterns por workspace)
--   5. PR scanner          (auditoria post-merge)
--
-- Premissa V.7  : nenhuma decisao autonoma viola a constituicao.
-- Premissa V.8  : auditabilidade total, append-only.
-- Premissa V.10 : kill switch < 5s, 3 falhas = pausa.
-- Premissa V.15 : custo consciente, alerta 70/90, kill em 100.
-- Premissa V.17 : RLS em toda tabela, sem excecao.
-- ============================================================

-- ============================================================
-- 1. KILL SWITCH · workspace state machine
-- ============================================================

alter table fabric_core_workspaces
  add column if not exists autodev_state text
    not null default 'active'
    check (autodev_state in ('active','paused','circuit_broken')),
  add column if not exists autodev_failure_count int
    not null default 0
    check (autodev_failure_count >= 0),
  add column if not exists autodev_circuit_threshold int
    not null default 3
    check (autodev_circuit_threshold >= 1 and autodev_circuit_threshold <= 20),
  add column if not exists autodev_killed_at timestamptz,
  add column if not exists autodev_killed_reason text;

comment on column fabric_core_workspaces.autodev_state is
  'FR.1 Wave A: estado do kill switch — active (default), paused (run manual cancelado), circuit_broken (3 falhas consecutivas).';
comment on column fabric_core_workspaces.autodev_failure_count is
  'FR.1 Wave A: contador rolante de mission failures. Zera no proximo succeeded.';
comment on column fabric_core_workspaces.autodev_circuit_threshold is
  'FR.1 Wave A: numero de falhas consecutivas antes de circuit_broken. Default 3.';

-- Gate de execucao consultado pelo runner / actions antes de despachar.
create or replace function fabric_fn_can_autodev_run(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select coalesce(
    (select autodev_state = 'active'
       from fabric_core_workspaces
      where id = p_workspace_id),
    false
  );
$$;

comment on function fabric_fn_can_autodev_run(uuid) is
  'FR.1 Wave A: gate central. true se workspace esta com kill switch armado e estado active.';

-- Trigger: contabiliza falhas consecutivas e dispara circuit breaker.
create or replace function fabric_fn_track_mission_failure()
returns trigger
language plpgsql
security definer
as $$
declare
  v_threshold int;
  v_current int;
  v_next_state text;
  v_killed_at timestamptz;
  v_reason text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  -- Zera o contador em qualquer succeeded
  if new.status = 'succeeded' then
    update fabric_core_workspaces
       set autodev_failure_count = 0
     where id = new.workspace_id
       and autodev_failure_count > 0;
    return new;
  end if;

  -- Apenas failures interessam para o circuito
  if new.status <> 'failed' then
    return new;
  end if;

  select autodev_circuit_threshold, autodev_failure_count
    into v_threshold, v_current
    from fabric_core_workspaces
   where id = new.workspace_id
     for update;

  v_current := coalesce(v_current, 0) + 1;

  if v_current >= coalesce(v_threshold, 3) then
    v_next_state := 'circuit_broken';
    v_killed_at  := now();
    v_reason     := format('%s falhas consecutivas (limite %s)', v_current, v_threshold);
  else
    v_next_state := null;
  end if;

  update fabric_core_workspaces
     set autodev_failure_count = v_current,
         autodev_state = coalesce(v_next_state, autodev_state),
         autodev_killed_at = case when v_next_state is not null then v_killed_at else autodev_killed_at end,
         autodev_killed_reason = case when v_next_state is not null then v_reason else autodev_killed_reason end
   where id = new.workspace_id;

  insert into fabric_audit_journal(workspace_id, event_type, payload, actor)
  values (
    new.workspace_id,
    case when v_next_state is not null then 'autodev_circuit_broken' else 'autodev_failure_recorded' end,
    jsonb_build_object(
      'mission_id', new.id,
      'mission_name', new.name,
      'failure_count', v_current,
      'threshold', v_threshold,
      'reason', coalesce(v_reason, 'failure registered')
    ),
    'system'
  );

  if v_next_state = 'circuit_broken' then
    insert into fabric_notifications(workspace_id, kind, severity, title, body, meta)
    values (
      new.workspace_id,
      'autodev_circuit_broken',
      'critical',
      'AutoDev pausado — circuit breaker',
      v_reason,
      jsonb_build_object('mission_id', new.id, 'failure_count', v_current)
    );
  end if;

  return new;
end $$;

drop trigger if exists fabric_trg_track_mission_failure on fabric_squad_missions;
create trigger fabric_trg_track_mission_failure
  after insert or update of status on fabric_squad_missions
  for each row execute function fabric_fn_track_mission_failure();

-- ============================================================
-- 2. COST LEDGER · token + USD per agent run
-- ============================================================

alter table fabric_core_workspaces
  add column if not exists cost_monthly_budget_usd numeric(10,2)
    not null default 50.00
    check (cost_monthly_budget_usd >= 0),
  add column if not exists cost_alert_70_period text,
  add column if not exists cost_alert_90_period text,
  add column if not exists cost_killed_period text;

comment on column fabric_core_workspaces.cost_monthly_budget_usd is
  'FR.1 Wave A: orcamento mensal por workspace. Alertas em 70/90, kill switch em 100.';
comment on column fabric_core_workspaces.cost_alert_70_period is
  'FR.1 Wave A: ultimo periodo (YYYY-MM) em que o alerta 70 foi emitido — evita spam.';

create table if not exists fabric_cost_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  mission_id uuid references fabric_squad_missions(id) on delete set null,
  agent_id text,
  source text not null default 'autodev'
    check (source in ('autodev','plan_squad','validator','manual','other')),
  model text,
  prompt_tokens int not null default 0 check (prompt_tokens >= 0),
  completion_tokens int not null default 0 check (completion_tokens >= 0),
  total_tokens int generated always as (prompt_tokens + completion_tokens) stored,
  usd_amount numeric(12,6) not null default 0 check (usd_amount >= 0),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fabric_idx_cost_ledger_ws_created
  on fabric_cost_ledger(workspace_id, created_at desc);

create index if not exists fabric_idx_cost_ledger_mission
  on fabric_cost_ledger(mission_id, created_at desc)
  where mission_id is not null;

comment on table fabric_cost_ledger is
  'FR.1 Wave A: append-only de custo por agent run. Premissa V.15.';

-- View agregada por mes (UTC). Usada pela UI e pelo trigger de alerta.
create or replace view fabric_cost_monthly_v as
select
  workspace_id,
  to_char(date_trunc('month', created_at at time zone 'utc'), 'YYYY-MM') as period,
  sum(usd_amount)::numeric(12,6) as total_usd,
  sum(total_tokens)::bigint as total_tokens,
  count(*)::bigint as runs
from fabric_cost_ledger
group by workspace_id, date_trunc('month', created_at at time zone 'utc');

comment on view fabric_cost_monthly_v is
  'FR.1 Wave A: total de custo por workspace por mes. Periodo em UTC YYYY-MM.';

-- Helper: total do mes corrente para um workspace
create or replace function fabric_fn_workspace_cost_this_month(p_workspace_id uuid)
returns numeric
language sql
security definer
stable
as $$
  select coalesce(sum(usd_amount), 0)::numeric
    from fabric_cost_ledger
   where workspace_id = p_workspace_id
     and date_trunc('month', created_at at time zone 'utc')
         = date_trunc('month', now() at time zone 'utc');
$$;

-- Trigger: ao inserir um run, checa orcamento e emite alertas / kill switch.
create or replace function fabric_fn_check_budget_thresholds()
returns trigger
language plpgsql
security definer
as $$
declare
  v_budget numeric;
  v_period text;
  v_total numeric;
  v_pct numeric;
  v_already_70 text;
  v_already_90 text;
  v_already_killed text;
begin
  select cost_monthly_budget_usd,
         cost_alert_70_period,
         cost_alert_90_period,
         cost_killed_period
    into v_budget, v_already_70, v_already_90, v_already_killed
    from fabric_core_workspaces
   where id = new.workspace_id
     for update;

  if v_budget is null or v_budget = 0 then
    return new;
  end if;

  v_period := to_char(now() at time zone 'utc', 'YYYY-MM');

  select coalesce(sum(usd_amount), 0)
    into v_total
    from fabric_cost_ledger
   where workspace_id = new.workspace_id
     and date_trunc('month', created_at at time zone 'utc')
         = date_trunc('month', now() at time zone 'utc');

  v_pct := (v_total / v_budget) * 100;

  -- 70% alert
  if v_pct >= 70 and (v_already_70 is null or v_already_70 <> v_period) then
    update fabric_core_workspaces
       set cost_alert_70_period = v_period
     where id = new.workspace_id;

    insert into fabric_notifications(workspace_id, kind, severity, title, body, meta)
    values (
      new.workspace_id,
      'cost_alert_70',
      'warning',
      'Custo do mes atingiu 70%',
      format('USD %.2f de %.2f (%.0f%%)', v_total, v_budget, v_pct),
      jsonb_build_object('period', v_period, 'total_usd', v_total, 'budget_usd', v_budget)
    );
  end if;

  -- 90% alert
  if v_pct >= 90 and (v_already_90 is null or v_already_90 <> v_period) then
    update fabric_core_workspaces
       set cost_alert_90_period = v_period
     where id = new.workspace_id;

    insert into fabric_notifications(workspace_id, kind, severity, title, body, meta)
    values (
      new.workspace_id,
      'cost_alert_90',
      'warning',
      'Custo do mes atingiu 90%',
      format('USD %.2f de %.2f (%.0f%%)', v_total, v_budget, v_pct),
      jsonb_build_object('period', v_period, 'total_usd', v_total, 'budget_usd', v_budget)
    );
  end if;

  -- 100% kill
  if v_pct >= 100 and (v_already_killed is null or v_already_killed <> v_period) then
    update fabric_core_workspaces
       set cost_killed_period = v_period,
           autodev_state = 'circuit_broken',
           autodev_killed_at = now(),
           autodev_killed_reason = format('orcamento excedido: USD %.2f de %.2f', v_total, v_budget)
     where id = new.workspace_id;

    insert into fabric_audit_journal(workspace_id, event_type, payload, actor)
    values (
      new.workspace_id,
      'autodev_killed_by_budget',
      jsonb_build_object('period', v_period, 'total_usd', v_total, 'budget_usd', v_budget),
      'system'
    );

    insert into fabric_notifications(workspace_id, kind, severity, title, body, meta)
    values (
      new.workspace_id,
      'cost_killed',
      'critical',
      'AutoDev pausado — orcamento esgotado',
      format('USD %.2f / %.2f no mes', v_total, v_budget),
      jsonb_build_object('period', v_period, 'total_usd', v_total, 'budget_usd', v_budget)
    );
  end if;

  return new;
end $$;

drop trigger if exists fabric_trg_check_budget on fabric_cost_ledger;
create trigger fabric_trg_check_budget
  after insert on fabric_cost_ledger
  for each row execute function fabric_fn_check_budget_thresholds();

-- ============================================================
-- 3. PREMISSAS VALIDATOR · violation events (append-only)
-- ============================================================

create table if not exists fabric_validator_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  mission_id uuid references fabric_squad_missions(id) on delete set null,
  target_kind text not null
    check (target_kind in ('mission_description','reasoning_step','artifact','pr_diff','manual')),
  target_id text,
  severity text not null default 'warning'
    check (severity in ('info','warning','critical')),
  rules_violated text[] not null default array[]::text[],
  forbidden_terms text[] not null default array[]::text[],
  content_snippet text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fabric_idx_validator_events_ws_created
  on fabric_validator_events(workspace_id, created_at desc);

create index if not exists fabric_idx_validator_events_mission
  on fabric_validator_events(mission_id, created_at desc)
  where mission_id is not null;

comment on table fabric_validator_events is
  'FR.1 Wave A: append-only de violacoes detectadas pelo Premissas Validator. V.7 + V.8.';

-- ============================================================
-- 4. FILE GUARD · write-allowlist por workspace
-- ============================================================

create table if not exists fabric_file_guard_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references fabric_core_workspaces(id) on delete cascade,
  pattern text not null,
  action text not null check (action in ('allow','deny')),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists fabric_idx_file_guard_ws
  on fabric_file_guard_rules(workspace_id, action);

comment on table fabric_file_guard_rules is
  'FR.1 Wave A: padroes glob (workspace-scoped ou globais quando workspace_id=null) que governam que arquivos o AutoDev pode tocar.';

-- Defaults globais (workspace_id null = aplicado a TODOS os workspaces)
insert into fabric_file_guard_rules(workspace_id, pattern, action, reason)
select null, p.pattern, p.action, p.reason
  from (values
    ('.env',                 'deny',  'secret store · proibido em qualquer cenario'),
    ('.env.*',               'deny',  'secret store · proibido em qualquer cenario'),
    ('**/.env',              'deny',  'secret store · proibido em qualquer cenario'),
    ('**/.env.*',            'deny',  'secret store · proibido em qualquer cenario'),
    ('supabase/config.toml', 'deny',  'config infra · alteracao requer humano'),
    ('package-lock.json',    'deny',  'lock automatico · regen via npm install pelo runner'),
    ('node_modules/**',      'deny',  'dependencias · nunca commitar'),
    ('.git/**',              'deny',  'metadados git'),
    ('src/**',               'allow', 'codigo de aplicacao'),
    ('public/**',            'allow', 'assets'),
    ('supabase/migrations/**','allow', 'schema versionado'),
    ('package.json',         'allow', 'permitido com scan'),
    ('next.config.ts',       'allow', 'permitido com scan'),
    ('tsconfig.json',        'allow', 'permitido com scan')
  ) as p(pattern, action, reason)
 where not exists (
   select 1
     from fabric_file_guard_rules r
    where r.workspace_id is null
      and r.pattern = p.pattern
 );

-- ============================================================
-- 5. PR SCANNER · resumo da auditoria post-merge
-- ============================================================

create table if not exists fabric_pr_scans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  mission_id uuid references fabric_squad_missions(id) on delete set null,
  pr_url text,
  pr_number int,
  base_sha text,
  head_sha text,
  branch_name text,
  files_changed int not null default 0 check (files_changed >= 0),
  lines_added int not null default 0 check (lines_added >= 0),
  lines_removed int not null default 0 check (lines_removed >= 0),
  premissas_violations int not null default 0 check (premissas_violations >= 0),
  file_guard_violations int not null default 0 check (file_guard_violations >= 0),
  forbidden_terms_count int not null default 0 check (forbidden_terms_count >= 0),
  verdict text not null default 'clean'
    check (verdict in ('clean','review','blocked')),
  summary text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fabric_idx_pr_scans_ws_created
  on fabric_pr_scans(workspace_id, created_at desc);

create index if not exists fabric_idx_pr_scans_mission
  on fabric_pr_scans(mission_id, created_at desc)
  where mission_id is not null;

create unique index if not exists fabric_uq_pr_scans_head_sha
  on fabric_pr_scans(workspace_id, head_sha)
  where head_sha is not null;

comment on table fabric_pr_scans is
  'FR.1 Wave A: snapshot da auditoria de cada PR. Verdict consolida violacoes do validator + file_guard.';

-- ============================================================
-- RLS · todas as tabelas novas sao workspace-scoped
-- ============================================================

alter table fabric_cost_ledger        enable row level security;
alter table fabric_validator_events   enable row level security;
alter table fabric_file_guard_rules   enable row level security;
alter table fabric_pr_scans           enable row level security;

drop policy if exists "members read cost ledger" on fabric_cost_ledger;
create policy "members read cost ledger" on fabric_cost_ledger
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "members write cost ledger" on fabric_cost_ledger;
create policy "members write cost ledger" on fabric_cost_ledger
  for insert with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members read validator events" on fabric_validator_events;
create policy "members read validator events" on fabric_validator_events
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "members write validator events" on fabric_validator_events;
create policy "members write validator events" on fabric_validator_events
  for insert with check (fabric_fn_has_access(workspace_id));

drop policy if exists "members read file guard" on fabric_file_guard_rules;
create policy "members read file guard" on fabric_file_guard_rules
  for select using (
    workspace_id is null
    or fabric_fn_has_access(workspace_id)
  );

drop policy if exists "owners manage file guard" on fabric_file_guard_rules;
create policy "owners manage file guard" on fabric_file_guard_rules
  for all using (
    workspace_id is not null
    and exists (
      select 1 from fabric_core_workspaces w
       where w.id = workspace_id and w.owner_id = auth.uid()
    )
  ) with check (
    workspace_id is not null
    and exists (
      select 1 from fabric_core_workspaces w
       where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

drop policy if exists "members read pr scans" on fabric_pr_scans;
create policy "members read pr scans" on fabric_pr_scans
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "members write pr scans" on fabric_pr_scans;
create policy "members write pr scans" on fabric_pr_scans
  for insert with check (fabric_fn_has_access(workspace_id));

-- ============================================================
-- Realtime publication para as novas tabelas
-- (idempotente — adiciona se ainda nao estiver)
-- ============================================================

select fabric_fn_add_to_realtime('public.fabric_cost_ledger');
select fabric_fn_add_to_realtime('public.fabric_validator_events');
select fabric_fn_add_to_realtime('public.fabric_pr_scans');

alter table fabric_cost_ledger      replica identity full;
alter table fabric_validator_events replica identity full;
alter table fabric_pr_scans         replica identity full;
