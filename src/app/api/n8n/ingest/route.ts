import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================
// Schema das requisicoes inbound do n8n
// ============================================

const HipoteseDataSchema = z.object({
  source: z.enum(['benchmark', 'nps', 'churn', 'manual']),
  title: z.string().min(1).max(280),
  body: z.string().optional(),
  score: z.number().optional().default(0),
});

const MetricDataSchema = z.object({
  captured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'formato esperado: YYYY-MM-DD'),
  nps: z.number().nullable().optional(),
  churn_rate: z.number().nullable().optional(),
  active_users: z.number().int().nullable().optional(),
});

const JournalDataSchema = z.object({
  event_type: z.string().min(1),
  payload: z.record(z.unknown()).optional().default({}),
  actor: z.string().optional().default('n8n'),
});

const PayloadSchema = z.object({
  workspace_slug: z.string().min(1),
  kind: z.enum(['hipotese', 'metric', 'journal']),
  data: z.record(z.unknown()),
});

// ============================================
// POST /api/n8n/ingest
// ============================================

export async function POST(request: Request) {
  // 1. Auth via header X-Fabric-Token
  const token = request.headers.get('x-fabric-token');
  const expected = process.env.FABRIC_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'FABRIC_INGEST_TOKEN nao configurado no servidor' }, { status: 500 });
  }
  if (!token || token !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.format() }, { status: 400 });
  }

  const { workspace_slug, kind, data } = parsed.data;

  // 3. Resolver workspace_id pelo slug (admin client — ignora RLS)
  const supabase = createAdminClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('fabric_core_workspaces')
    .select('id, slug')
    .eq('slug', workspace_slug)
    .single();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: `workspace_slug nao encontrado: ${workspace_slug}` }, { status: 404 });
  }

  // 4. Despachar pelo tipo
  try {
    if (kind === 'hipotese') {
      const d = HipoteseDataSchema.parse(data);
      const { data: row, error } = await supabase
        .from('fabric_layer1_hipoteses')
        .insert({
          workspace_id: workspace.id,
          source: d.source,
          title: d.title,
          body: d.body ?? null,
          score: d.score,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error) throw error;

      await supabase.from('fabric_audit_journal').insert({
        workspace_id: workspace.id,
        event_type: 'hipotese_inserted',
        payload: { hipotese_id: row.id, source: d.source, title: d.title },
        actor: 'n8n',
      });

      return NextResponse.json({ ok: true, hipotese_id: row.id });
    }

    if (kind === 'metric') {
      const d = MetricDataSchema.parse(data);
      const { error } = await supabase
        .from('fabric_signals_metrics')
        .upsert({
          workspace_id: workspace.id,
          captured_at: d.captured_at,
          nps: d.nps ?? null,
          churn_rate: d.churn_rate ?? null,
          active_users: d.active_users ?? null,
        });
      if (error) throw error;

      await supabase.from('fabric_audit_journal').insert({
        workspace_id: workspace.id,
        event_type: 'metric_recorded',
        payload: d,
        actor: 'n8n',
      });

      return NextResponse.json({ ok: true });
    }

    if (kind === 'journal') {
      const d = JournalDataSchema.parse(data);
      const { error } = await supabase
        .from('fabric_audit_journal')
        .insert({
          workspace_id: workspace.id,
          event_type: d.event_type,
          payload: d.payload ?? {},
          actor: d.actor ?? 'n8n',
        });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido';
    return NextResponse.json({ error: 'falha ao processar', detail: message }, { status: 500 });
  }

  return NextResponse.json({ error: 'unreachable' }, { status: 500 });
}
