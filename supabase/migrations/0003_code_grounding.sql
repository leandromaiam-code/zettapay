-- ============================================================
-- Veridian Fabric — F2.1 Code Grounding (pgvector)
-- Sprint 2 GATEWAY · "Fabric escreve Fabric"
--
-- Substrato de RAG: trechos do código, premissas e docs do
-- workspace ficam embedados em pgvector. AutoDev consulta este
-- substrato antes de executar missões — para que a próxima
-- missão tenha contexto real do que já foi forjado.
--
-- Convenção: fabric_grounding_<recurso>
-- ============================================================

create extension if not exists vector;

-- ---------- TABLE ----------

create table if not exists fabric_grounding_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references fabric_core_workspaces(id) on delete cascade,

  -- Procedência do chunk
  source text not null
    check (source in ('code','docs','premissas','journal','external')),
  repo text,
  ref text,             -- branch ou commit SHA
  path text,            -- caminho relativo (ex: src/lib/grounding.ts)
  start_line int,
  end_line int,
  language text,

  -- Conteúdo + dedupe
  content text not null,
  content_hash text not null,
  token_count int,

  -- Embedding (text-embedding-3-small = 1536 dimensões)
  embedding vector(1536),
  embedding_model text not null default 'text-embedding-3-small',

  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe por workspace + path + hash (mesmo trecho não vira chunk duplicado)
create unique index if not exists fabric_idx_grounding_dedupe
  on fabric_grounding_chunks(workspace_id, source, path, content_hash);

create index if not exists fabric_idx_grounding_workspace
  on fabric_grounding_chunks(workspace_id, source, updated_at desc);

-- ANN sobre embedding (cosine). ivfflat é estável e barato no plano free.
-- 100 listas é suficiente até ~100k chunks por workspace; reavaliar depois.
create index if not exists fabric_idx_grounding_embedding
  on fabric_grounding_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ---------- TRIGGER ----------

create or replace function fabric_fn_grounding_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists fabric_trg_grounding_touch on fabric_grounding_chunks;
create trigger fabric_trg_grounding_touch
  before update on fabric_grounding_chunks
  for each row execute function fabric_fn_grounding_touch();

-- ---------- RPC: similarity search ----------
-- security definer + checagem explícita de fabric_fn_has_access.
-- Sempre filtra por workspace_id antes do <-> para que o índice ANN
-- seja útil. Distância cosseno; similaridade = 1 - distância.

create or replace function fabric_fn_grounding_search(
  p_workspace_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 8,
  p_source text default null,
  p_min_similarity float default 0.0
) returns table (
  id uuid,
  source text,
  repo text,
  ref text,
  path text,
  start_line int,
  end_line int,
  language text,
  content text,
  similarity float
)
language plpgsql
security definer
stable
as $$
begin
  if not fabric_fn_has_access(p_workspace_id) then
    raise exception 'access denied for workspace %', p_workspace_id
      using errcode = '42501';
  end if;

  return query
    select
      c.id,
      c.source,
      c.repo,
      c.ref,
      c.path,
      c.start_line,
      c.end_line,
      c.language,
      c.content,
      (1 - (c.embedding <=> p_query_embedding))::float as similarity
    from fabric_grounding_chunks c
    where c.workspace_id = p_workspace_id
      and c.embedding is not null
      and (p_source is null or c.source = p_source)
      and (1 - (c.embedding <=> p_query_embedding)) >= p_min_similarity
    order by c.embedding <=> p_query_embedding
    limit greatest(1, least(p_match_count, 50));
end $$;

-- ---------- RLS ----------

alter table fabric_grounding_chunks enable row level security;

drop policy if exists "members read grounding" on fabric_grounding_chunks;
create policy "members read grounding" on fabric_grounding_chunks
  for select using (fabric_fn_has_access(workspace_id));

drop policy if exists "members write grounding" on fabric_grounding_chunks;
create policy "members write grounding" on fabric_grounding_chunks
  for all using (fabric_fn_has_access(workspace_id))
  with check (fabric_fn_has_access(workspace_id));
