import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { resumeAutodev } from '@/lib/autodev/kill-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
});

/**
 * POST /api/autodev/resume — owner-only resume.
 * RLS garante que apenas membros do workspace acessem; a checagem
 * de owner e adicional, espelhando a regra usada por outras actions.
 */
export async function POST(request: Request) {
  const auth = await requireInternalAuth(request);
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload', details: parsed.error.format() }, { status: 400 });
  }

  if (auth.kind === 'user') {
    const { data: ws } = await auth.supabase
      .from('fabric_core_workspaces')
      .select('owner_id')
      .eq('id', parsed.data.workspace_id)
      .single();
    if (!ws || ws.owner_id !== auth.user.id) {
      return NextResponse.json({ error: 'forbidden — owner only' }, { status: 403 });
    }
  }

  await resumeAutodev(auth.supabase, parsed.data.workspace_id, auth.actor);

  return NextResponse.json({ ok: true });
}
