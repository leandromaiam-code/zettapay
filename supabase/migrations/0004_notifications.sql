-- ============================================================
-- Veridian Fabric — Notifications (F5.2)
-- Append-only notifications scoped to workspace + (optionally) user.
-- Auto-emitted on mission status transitions and hipotese decisions.
-- ============================================================

create table if not exists fabric_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  kind text not null,
  severity text not null default 'info'
    check (severity in ('info','success','warning','critical')),
  title text not null,
  body text,
  href text,
  meta jsonb default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists fabric_idx_notifications_ws_user_unread
  on fabric_notifications(workspace_id, user_id, read_at, created_at desc);

create index if not exists fabric_idx_notifications_ws_recent
  on fabric_notifications(workspace_id, created_at desc);

alter table fabric_notifications replica identity full;

-- Realtime publication (idempotent — only add if not present)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'fabric_notifications'
  ) then
    execute 'alter publication supabase_realtime add table fabric_notifications';
  end if;
end $$;

-- ---------- RLS ----------
alter table fabric_notifications enable row level security;

drop policy if exists "members read notifications" on fabric_notifications;
create policy "members read notifications" on fabric_notifications
  for select using (
    fabric_fn_has_access(workspace_id)
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "members update own notifications" on fabric_notifications;
create policy "members update own notifications" on fabric_notifications
  for update using (
    fabric_fn_has_access(workspace_id)
    and (user_id is null or user_id = auth.uid())
  )
  with check (
    fabric_fn_has_access(workspace_id)
    and (user_id is null or user_id = auth.uid())
  );

drop policy if exists "members write notifications" on fabric_notifications;
create policy "members write notifications" on fabric_notifications
  for insert with check (fabric_fn_has_access(workspace_id));

-- ---------- AUTO EMITTERS ----------

create or replace function fabric_fn_notify_mission_change()
returns trigger language plpgsql security definer as $$
declare
  v_severity text;
  v_title text;
  v_body text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  if new.status = 'succeeded' then
    v_severity := 'success';
    v_title := 'Mission concluída';
    v_body := new.name;
  elsif new.status = 'failed' then
    v_severity := 'critical';
    v_title := 'Mission falhou';
    v_body := new.name;
  elsif new.status = 'paused' then
    v_severity := 'warning';
    v_title := 'Mission pausada';
    v_body := new.name;
  else
    return new;
  end if;

  insert into fabric_notifications(workspace_id, kind, severity, title, body, href, meta)
  values (
    new.workspace_id,
    'mission_' || new.status,
    v_severity,
    v_title,
    v_body,
    '/' || (select slug from fabric_core_workspaces where id = new.workspace_id) || '/missions/' || new.id::text,
    jsonb_build_object('mission_id', new.id, 'phase', new.phase, 'squad', new.squad)
  );
  return new;
end $$;

drop trigger if exists fabric_trg_notify_mission on fabric_squad_missions;
create trigger fabric_trg_notify_mission
  after insert or update of status on fabric_squad_missions
  for each row execute function fabric_fn_notify_mission_change();

create or replace function fabric_fn_notify_hipotese_decision()
returns trigger language plpgsql security definer as $$
declare
  v_severity text;
  v_title text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('approved','rejected') then
    return new;
  end if;

  v_severity := case when new.status = 'approved' then 'success' else 'info' end;
  v_title := case when new.status = 'approved' then 'Hipótese aprovada' else 'Hipótese rejeitada' end;

  insert into fabric_notifications(workspace_id, kind, severity, title, body, href, meta)
  values (
    new.workspace_id,
    'hipotese_' || new.status,
    v_severity,
    v_title,
    new.title,
    '/' || (select slug from fabric_core_workspaces where id = new.workspace_id) || '?tab=plan',
    jsonb_build_object('hipotese_id', new.id, 'source', new.source)
  );
  return new;
end $$;

drop trigger if exists fabric_trg_notify_hipotese on fabric_layer1_hipoteses;
create trigger fabric_trg_notify_hipotese
  after insert or update of status on fabric_layer1_hipoteses
  for each row execute function fabric_fn_notify_hipotese_decision();
