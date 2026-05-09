import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';
import { upsertChunks, GroundingConfigError, type GroundingChunkInput } from '@/lib/grounding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Indexação pode ser longa em batch — 60s é o máximo do Vercel free tier.
export const maxDuration = 60;

const ChunkSchema = z.object({
  source: z.enum(['code', 'docs', 'premissas', 'journal', 'external']),
  content: z.string().min(1).max(40_000),
  repo: z.string().max(200).nullable().optional(),
  ref: z.string().max(200).nullable().optional(),
  path: z.string().max(500).nullable().optional(),
  start_line: z.number().int().nonnegative().nullable().optional(),
  end_line: z.number().int().nonnegative().nullable().optional(),
  language: z.string().max(40).nullable().optional(),
  meta: z.record(z.unknown()).optional(),
});

const Body = z.object({
  workspace_slug: z.string().min(1),
  chunks: z.array(ChunkSchema).min(1).max(128),
});

export async function POST(request: Request) {
  // Apenas server-to-server: fabric-api manda batches via X-Fabric-Token.
  const token = request.headers.get('x-fabric-token');
  const expected = process.env.FABRIC_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'FABRIC_INGEST_TOKEN não configurado' }, { status: 500 });
  }
  if (!token || token !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.format() }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('fabric_core_workspaces')
    .select('id, slug')
    .eq('slug', parsed.data.workspace_slug)
    .single();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: `workspace_slug não encontrado: ${parsed.data.workspace_slug}` }, { status: 404 });
  }

  try {
    const result = await upsertChunks(supabase, {
      workspaceId: workspace.id,
      chunks: parsed.data.chunks as GroundingChunkInput[],
    });

    // Audit append-only — toda indexação fica registrada
    await supabase.from('fabric_audit_journal').insert({
      workspace_id: workspace.id,
      event_type: 'grounding_indexed',
      payload: {
        inserted: result.inserted,
        skipped: result.skipped,
        sources: Array.from(new Set(parsed.data.chunks.map((c) => c.source))),
      },
      actor: 'fabric-api',
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof GroundingConfigError) {
      return NextResponse.json({ error: 'grounding not configured', detail: err.message }, { status: 503 });
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'upsert failed', detail }, { status: 500 });
  }
}
