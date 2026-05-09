import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { pauseAutodev } from '@/lib/autodev/kill-switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  reason: z.string().min(1).max(500).default('manual kill switch'),
});

/**
 * POST /api/autodev/kill — emergency stop em < 5s (premissa V.10).
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

  await pauseAutodev(auth.supabase, parsed.data.workspace_id, parsed.data.reason, auth.actor);

  return NextResponse.json({ ok: true });
}
