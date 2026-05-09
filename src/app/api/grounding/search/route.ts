import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient, createClient } from '@/lib/supabase/server';
import { searchChunks, GroundingConfigError, type GroundingSource } from '@/lib/grounding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  workspace_slug: z.string().min(1),
  query: z.string().min(1).max(8000),
  k: z.number().int().min(1).max(50).optional(),
  source: z.enum(['code', 'docs', 'premissas', 'journal', 'external']).optional(),
  min_similarity: z.number().min(0).max(1).optional(),
});

export async function POST(request: Request) {
  // Dois modos de auth:
  //  1. Header X-Fabric-Token (fabric-api → Next, mesmo padrão de /api/n8n/ingest)
  //  2. Sessão de usuário Supabase (UI / debug)
  const ingestToken = request.headers.get('x-fabric-token');
  const expected = process.env.FABRIC_INGEST_TOKEN;
  const tokenAuth = !!expected && ingestToken === expected;

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
  const { workspace_slug, query, k, source, min_similarity } = parsed.data;

  // Auth via sessão se não veio token de servidor
  let supabase = tokenAuth ? createAdminClient() : await createClient();
  if (!tokenAuth) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const { data: workspace, error: wsErr } = await supabase
    .from('fabric_core_workspaces')
    .select('id, slug')
    .eq('slug', workspace_slug)
    .single();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: 'workspace not found or no access' }, { status: 404 });
  }

  try {
    const matches = await searchChunks(supabase, {
      workspaceId: workspace.id,
      query,
      k,
      source: source as GroundingSource | undefined,
      minSimilarity: min_similarity ?? 0,
    });
    return NextResponse.json({ matches });
  } catch (err) {
    if (err instanceof GroundingConfigError) {
      return NextResponse.json({ error: 'grounding not configured', detail: err.message }, { status: 503 });
    }
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: 'search failed', detail }, { status: 500 });
  }
}
