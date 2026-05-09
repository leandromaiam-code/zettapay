import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { checkFiles, type FileGuardRule } from '@/lib/file-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  files: z.array(z.string().min(1).max(500)).min(1).max(2_000),
});

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

  const { workspace_id, files } = parsed.data;

  const { data: rows, error } = await auth.supabase
    .from('fabric_file_guard_rules')
    .select('id, workspace_id, pattern, action, reason')
    .or(`workspace_id.is.null,workspace_id.eq.${workspace_id}`);

  if (error) {
    return NextResponse.json({ error: 'rules lookup failed', detail: error.message }, { status: 500 });
  }

  // workspace-specific overrides global. denies have priority but order doesnt
  // matter because checkFiles short-circuits on the first deny anyway.
  const rules = (rows ?? []) as FileGuardRule[];
  const result = checkFiles(files, rules);

  return NextResponse.json({
    allowed: result.allowed,
    blocked: result.blocked.map((d) => ({
      path: d.path,
      reason: d.matchedRule?.reason ?? null,
      pattern: d.matchedRule?.pattern ?? null,
    })),
    decisions: result.decisions.map((d) => ({
      path: d.path,
      action: d.action,
      pattern: d.matchedRule?.pattern ?? null,
    })),
  });
}
