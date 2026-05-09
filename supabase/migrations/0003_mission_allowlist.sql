-- ============================================================
-- Veridian Fabric — F2.11 Mission Type Allowlist
-- Sprint 2.5 (Production Connect Safety)
--
-- Permite ao owner do workspace restringir quais squads (tipos
-- de missao) podem ser executados. Premissa V.7: nenhuma decisao
-- autonoma viola a constituicao. AutoDev so dispara missoes cujo
-- squad esta na allowlist.
-- ============================================================

alter table fabric_core_workspaces
  add column if not exists allowed_mission_squads text[]
    not null default array['dev','marketing','sales','ops'];

-- Garantia de invariante: pelo menos um squad sempre permitido,
-- e qualquer squad declarado tem que ser conhecido.
alter table fabric_core_workspaces
  drop constraint if exists fabric_core_workspaces_allowed_squads_chk;

alter table fabric_core_workspaces
  add constraint fabric_core_workspaces_allowed_squads_chk
  check (
    cardinality(allowed_mission_squads) >= 1
    and allowed_mission_squads <@ array['dev','marketing','sales','ops']
  );

-- Backfill defensivo (caso a coluna ja existisse com null em outros ambientes)
update fabric_core_workspaces
   set allowed_mission_squads = array['dev','marketing','sales','ops']
 where allowed_mission_squads is null
    or cardinality(allowed_mission_squads) = 0;

-- ---------- Gate de execucao ----------
-- Usado pelo runner / fabric-api e pelas server actions para checar
-- antes de despachar uma mission. Security definer: runner com
-- service role pode chamar sem RLS.
create or replace function fabric_fn_mission_squad_allowed(p_mission_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
      from fabric_squad_missions m
      join fabric_core_workspaces w on w.id = m.workspace_id
     where m.id = p_mission_id
       and m.squad = any(w.allowed_mission_squads)
  );
$$;

comment on function fabric_fn_mission_squad_allowed(uuid) is
  'F2.11: true se o squad da mission estiver na allowlist do workspace.';

comment on column fabric_core_workspaces.allowed_mission_squads is
  'F2.11: tipos de missao (squads) permitidos no workspace. AutoDev e execucao manual sao bloqueados se squad da mission nao estiver aqui.';
