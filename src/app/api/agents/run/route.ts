import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { agent_id?: string; workspace_slug?: string; input?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { agent_id, workspace_slug, input } = body;
  if (!agent_id || !workspace_slug || !input?.trim()) {
    return NextResponse.json({ error: 'agent_id, workspace_slug, input required' }, { status: 400 });
  }

  // 1. Carrega workspace + premissas (RLS valida acesso)
  const { data: workspace, error: wsErr } = await supabase
    .from('fabric_core_workspaces')
    .select('id, slug, name')
    .eq('slug', workspace_slug)
    .single();
  if (wsErr || !workspace) {
    return NextResponse.json({ error: 'workspace not found or no access' }, { status: 404 });
  }

  const { data: premissasRow } = await supabase
    .from('fabric_layer0_premissas')
    .select('content')
    .eq('workspace_id', workspace.id)
    .maybeSingle();

  // 2. Proxy para fabric-api no droplet
  const apiUrl = process.env.FABRIC_API_URL;
  const apiToken = process.env.FABRIC_API_TOKEN;
  if (!apiUrl || !apiToken) {
    return NextResponse.json({ error: 'fabric-api not configured' }, { status: 500 });
  }

  try {
    const upstream = await fetch(`${apiUrl}/run-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        agent_id,
        workspace_id: workspace.id,
        workspace_slug: workspace.slug,
        workspace_name: workspace.name,
        input: input.trim(),
        premissas: premissasRow?.content ?? '',
      }),
      // Não esperamos resposta sincrona — fabric-api retorna task_id imediatamente
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return NextResponse.json({ error: 'fabric-api error', detail: text }, { status: upstream.status });
    }
    const data = await upstream.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: 'failed to reach fabric-api', detail: msg }, { status: 502 });
  }
}
