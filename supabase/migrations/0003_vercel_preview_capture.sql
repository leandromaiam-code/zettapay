-- ============================================================
-- Veridian Fabric — F2.5 GATEWAY: Vercel Preview Capture
-- Captura deployments preview da Vercel e amarra na mission via branch.
-- Audit append-only registra cada transição de estado.
-- ============================================================

alter table fabric_squad_missions
  add column if not exists branch_name text,
  add column if not exists preview_url text,
  add column if not exists vercel_deployment_id text,
  add column if not exists vercel_deployment_state text
    check (vercel_deployment_state in ('queued','building','ready','error','canceled')),
  add column if not exists vercel_deployment_created_at timestamptz,
  add column if not exists vercel_deployment_ready_at timestamptz,
  add column if not exists vercel_deployment_error_message text;

-- Lookup por branch (webhook resolve mission a partir de meta.gitBranch)
create index if not exists fabric_idx_missions_branch
  on fabric_squad_missions(branch_name)
  where branch_name is not null;

-- Garante que cada deployment vira no máximo uma mission
create unique index if not exists fabric_uq_missions_vercel_deployment
  on fabric_squad_missions(vercel_deployment_id)
  where vercel_deployment_id is not null;

-- ---------- AUDIT TRIGGER (append-only) ----------
-- Loga vercel_preview_created / _ready / _failed / _canceled em fabric_audit_journal
-- sempre que vercel_deployment_state mudar.

create or replace function fabric_fn_log_vercel_state()
returns trigger language plpgsql security definer as $$
declare
  v_event text;
begin
  if new.vercel_deployment_state is null then
    return new;
  end if;
  if old.vercel_deployment_state is not distinct from new.vercel_deployment_state then
    return new;
  end if;

  v_event := case new.vercel_deployment_state
    when 'queued'   then 'vercel_preview_queued'
    when 'building' then 'vercel_preview_building'
    when 'ready'    then 'vercel_preview_ready'
    when 'error'    then 'vercel_preview_failed'
    when 'canceled' then 'vercel_preview_canceled'
  end;

  insert into fabric_audit_journal(workspace_id, event_type, payload, actor)
  values (
    new.workspace_id,
    v_event,
    jsonb_build_object(
      'mission_id',    new.id,
      'mission_name',  new.name,
      'branch_name',   new.branch_name,
      'deployment_id', new.vercel_deployment_id,
      'preview_url',   new.preview_url,
      'state',         new.vercel_deployment_state,
      'error_message', new.vercel_deployment_error_message
    ),
    'vercel'
  );

  return new;
end $$;

drop trigger if exists fabric_trg_log_vercel_state on fabric_squad_missions;
create trigger fabric_trg_log_vercel_state
  after update of vercel_deployment_state on fabric_squad_missions
  for each row execute function fabric_fn_log_vercel_state();
