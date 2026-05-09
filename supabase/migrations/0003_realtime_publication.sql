-- ============================================================
-- Veridian Fabric — F5.1 Real-Time Event Stream
-- Publica as tabelas de evento na publication supabase_realtime
-- para que postgres_changes (INSERT/UPDATE) entregue eventos
-- aos subscribers via WebSocket.
-- Append-only por contrato: nenhum DELETE/UPDATE de journal.
-- ============================================================

do $$
declare
  pub_exists boolean;
begin
  select exists (select 1 from pg_publication where pubname = 'supabase_realtime')
  into pub_exists;

  if not pub_exists then
    create publication supabase_realtime;
  end if;
end $$;

-- Helper: adiciona tabela à publication só se ainda não estiver
create or replace function fabric_fn_add_to_realtime(tbl regclass)
returns void language plpgsql as $$
declare
  already boolean;
begin
  select exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = split_part(tbl::text, '.', 1)
      and tablename  = split_part(tbl::text, '.', 2)
  ) into already;

  if not already then
    execute format('alter publication supabase_realtime add table %s', tbl);
  end if;
end $$;

-- Tabelas-fonte do event stream (workspace-scoped, RLS já enforced)
select fabric_fn_add_to_realtime('public.fabric_audit_journal');
select fabric_fn_add_to_realtime('public.fabric_squad_missions');
select fabric_fn_add_to_realtime('public.fabric_squad_reasoning');
select fabric_fn_add_to_realtime('public.fabric_squad_artifacts');
select fabric_fn_add_to_realtime('public.fabric_layer1_hipoteses');

-- REPLICA IDENTITY FULL — necessário para filtros de coluna (workspace_id)
-- funcionarem em UPDATE events sem perder o old.workspace_id.
alter table fabric_audit_journal     replica identity full;
alter table fabric_squad_missions    replica identity full;
alter table fabric_squad_reasoning   replica identity full;
alter table fabric_squad_artifacts   replica identity full;
alter table fabric_layer1_hipoteses  replica identity full;

-- Index extra para o stream agregado (ordem por created_at desc)
create index if not exists fabric_idx_missions_ws_created
  on fabric_squad_missions(workspace_id, created_at desc);

create index if not exists fabric_idx_artifacts_ws_created
  on fabric_squad_artifacts(workspace_id, created_at desc);

create index if not exists fabric_idx_reasoning_ws_ts
  on fabric_squad_reasoning(workspace_id, ts desc);
