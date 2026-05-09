import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ============================================
// F2.5 — Vercel Preview Capture
// Recebe deployment events da Vercel, casa por branch e
// grava preview_url + state na mission. Audit append-only.
// Docs: https://vercel.com/docs/observability/webhooks-overview
// ============================================

type VercelState = 'queued' | 'building' | 'ready' | 'error' | 'canceled';

const EVENT_TO_STATE: Record<string, VercelState> = {
  'deployment.created':   'building',
  'deployment.ready':     'ready',
  'deployment.succeeded': 'ready',
  'deployment.error':     'error',
  'deployment.canceled':  'canceled',
};

const DeploymentSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1).optional(),
  inspectorUrl: z.string().optional(),
  target: z.string().nullable().optional(),
  meta: z.record(z.unknown()).optional().default({}),
});

const PayloadSchema = z.object({
  id: z.string().optional(),
  type: z.string().min(1),
  createdAt: z.number().optional(),
  payload: z.object({
    deployment: DeploymentSchema,
  }),
});

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha1', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deriveBranch(meta: Record<string, unknown>): string | null {
  const candidates = ['githubCommitRef', 'gitlabCommitRef', 'bitbucketCommitRef', 'gitBranch', 'branch'];
  for (const k of candidates) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function previewUrlFromHost(host: string | undefined): string | null {
  if (!host) return null;
  return host.startsWith('http') ? host : `https://${host}`;
}

export async function POST(request: Request) {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'VERCEL_WEBHOOK_SECRET nao configurado no servidor' },
      { status: 500 }
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-vercel-signature');
  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid payload', details: parsed.error.format() },
      { status: 400 }
    );
  }

  const { type, payload } = parsed.data;
  const state = EVENT_TO_STATE[type];
  if (!state) {
    return NextResponse.json({ ok: true, ignored: 'unsupported event', type });
  }

  const deployment = payload.deployment;
  // Premissas: capturar apenas previews. Production deploys nao representam mission preview.
  if (deployment.target === 'production') {
    return NextResponse.json({ ok: true, ignored: 'production deployment' });
  }

  const branch = deriveBranch(deployment.meta ?? {});
  if (!branch) {
    return NextResponse.json({ ok: true, ignored: 'no git branch in payload' });
  }

  const supabase = createAdminClient();

  // Resolver mission pela branch (mais recente vence em caso de duplicata)
  const { data: mission, error: lookupErr } = await supabase
    .from('fabric_squad_missions')
    .select('id, workspace_id, vercel_deployment_state, vercel_deployment_created_at')
    .eq('branch_name', branch)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupErr) {
    return NextResponse.json(
      { error: 'lookup failed', detail: lookupErr.message },
      { status: 500 }
    );
  }

  if (!mission) {
    // Branch nao casou com mission alguma — registra como orphan no journal global
    // do primeiro workspace (best-effort). Sem workspace, apenas ignora.
    return NextResponse.json({ ok: true, ignored: 'no mission for branch', branch });
  }

  const previewUrl = previewUrlFromHost(deployment.url);
  const nowIso = new Date().toISOString();

  const update: Record<string, unknown> = {
    vercel_deployment_id: deployment.id,
    vercel_deployment_state: state,
    preview_url: previewUrl,
  };

  // Carimbos de tempo conforme transicao. Apenas seta o created_at uma vez.
  if (state === 'building' && !mission.vercel_deployment_created_at) {
    update.vercel_deployment_created_at = nowIso;
  }
  if (state === 'ready') {
    update.vercel_deployment_ready_at = nowIso;
    update.vercel_deployment_error_message = null;
  }
  if (state === 'error') {
    const msg = (deployment.meta as { errorMessage?: unknown })?.errorMessage;
    update.vercel_deployment_error_message = typeof msg === 'string' ? msg.slice(0, 500) : null;
  }

  const { error: updateErr } = await supabase
    .from('fabric_squad_missions')
    .update(update)
    .eq('id', mission.id);

  if (updateErr) {
    return NextResponse.json(
      { error: 'update failed', detail: updateErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    mission_id: mission.id,
    branch,
    state,
    preview_url: previewUrl,
  });
}
