import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// F2.1 Code Grounding — substrato RAG do Fabric
//
// Esta lib roda apenas em rotas server / server actions.
// Embeddings são gerados sob demanda via OpenAI (text-embedding-3-small,
// 1536 dimensões) — escolhido por custo/qualidade e por casar com a
// definição da coluna vector(1536) do migration 0003.
// ============================================================

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

export type GroundingSource = 'code' | 'docs' | 'premissas' | 'journal' | 'external';

export interface GroundingChunkInput {
  source: GroundingSource;
  content: string;
  repo?: string | null;
  ref?: string | null;
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  language?: string | null;
  meta?: Record<string, unknown>;
}

export interface GroundingMatch {
  id: string;
  source: GroundingSource;
  repo: string | null;
  ref: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  language: string | null;
  content: string;
  similarity: number;
}

export class GroundingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroundingConfigError';
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Aproximação rápida de tokens (~4 chars/token em pt+en+code).
// Não substitui um tokenizer real, mas serve para budget e telemetria.
export function approxTokenCount(content: string): number {
  return Math.ceil(content.length / 4);
}

// ---------- Embedding via OpenAI ----------

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new GroundingConfigError('OPENAI_API_KEY ausente — embeddings indisponíveis');
  }

  // OpenAI aceita batch de até 2048; clampamos por segurança.
  const batch = inputs.slice(0, 256);

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: batch,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`embed failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  const json = (await res.json()) as OpenAIEmbeddingResponse;
  const ordered = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);

  for (const v of ordered) {
    if (v.length !== EMBEDDING_DIMS) {
      throw new Error(`dimensão inesperada: ${v.length}, esperava ${EMBEDDING_DIMS}`);
    }
  }
  return ordered;
}

export async function embedText(input: string): Promise<number[]> {
  const [v] = await embedTexts([input]);
  return v;
}

// ---------- Upsert ----------

interface UpsertOptions {
  workspaceId: string;
  chunks: GroundingChunkInput[];
}

export interface UpsertResult {
  inserted: number;
  skipped: number;
}

export async function upsertChunks(
  supabase: SupabaseClient,
  { workspaceId, chunks }: UpsertOptions,
): Promise<UpsertResult> {
  if (chunks.length === 0) return { inserted: 0, skipped: 0 };

  // Hash determinístico — chunks idênticos não regeram embedding nem viram duplicata.
  const hashed = chunks.map((c) => ({
    ...c,
    content_hash: hashContent(c.content),
  }));

  // Quais já existem (mesma path + hash)?
  const seenKey = (row: { source: string; path?: string | null; content_hash: string }) =>
    `${row.source}::${row.path ?? ''}::${row.content_hash}`;

  const { data: existing } = await supabase
    .from('fabric_grounding_chunks')
    .select('source, path, content_hash')
    .eq('workspace_id', workspaceId)
    .in('content_hash', hashed.map((c) => c.content_hash));

  const existingSet = new Set((existing ?? []).map(seenKey));
  const fresh = hashed.filter((c) => !existingSet.has(seenKey(c)));

  if (fresh.length === 0) return { inserted: 0, skipped: hashed.length };

  const embeddings = await embedTexts(fresh.map((c) => c.content));

  const rows = fresh.map((c, i) => ({
    workspace_id: workspaceId,
    source: c.source,
    repo: c.repo ?? null,
    ref: c.ref ?? null,
    path: c.path ?? null,
    start_line: c.start_line ?? null,
    end_line: c.end_line ?? null,
    language: c.language ?? null,
    content: c.content,
    content_hash: c.content_hash,
    token_count: approxTokenCount(c.content),
    embedding: embeddings[i],
    embedding_model: EMBEDDING_MODEL,
    meta: c.meta ?? {},
  }));

  const { error } = await supabase
    .from('fabric_grounding_chunks')
    .upsert(rows, { onConflict: 'workspace_id,source,path,content_hash' });

  if (error) throw new Error(`upsert grounding: ${error.message}`);

  return { inserted: rows.length, skipped: hashed.length - rows.length };
}

// ---------- Search ----------

export interface SearchOptions {
  workspaceId: string;
  query: string;
  k?: number;
  source?: GroundingSource;
  minSimilarity?: number;
}

export async function searchChunks(
  supabase: SupabaseClient,
  { workspaceId, query, k = 8, source, minSimilarity = 0 }: SearchOptions,
): Promise<GroundingMatch[]> {
  const embedding = await embedText(query);

  const { data, error } = await supabase.rpc('fabric_fn_grounding_search', {
    p_workspace_id: workspaceId,
    p_query_embedding: embedding,
    p_match_count: Math.max(1, Math.min(50, k)),
    p_source: source ?? null,
    p_min_similarity: minSimilarity,
  });

  if (error) throw new Error(`grounding search: ${error.message}`);
  return (data ?? []) as GroundingMatch[];
}
