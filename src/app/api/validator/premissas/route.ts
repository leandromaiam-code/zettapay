import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { validateContent, summarizeResult } from '@/lib/validator/premissas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  content: z.string().min(1).max(200_000),
  context: z
    .enum(['mission_description', 'reasoning_step', 'artifact', 'pr_diff', 'manual'])
    .default('manual'),
  mission_id: z.string().uuid().nullable().optional(),
  target_id: z.string().max(120).nullable().optional(),
  persist: z.boolean().default(true),
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

  const { workspace_id, content, context, mission_id, target_id, persist } = parsed.data;

  const { data: premissasRow } = await auth.supabase
    .from('fabric_layer0_premissas')
    .select('content')
    .eq('workspace_id', workspace_id)
    .maybeSingle();

  const result = validateContent({
    content,
    premissas: premissasRow?.content ?? '',
    context,
  });

  if (persist && result.violations.length > 0) {
    const severity = result.violations.some((v) => v.severity === 'critical')
      ? 'critical'
      : result.violations.some((v) => v.severity === 'warning')
      ? 'warning'
      : 'info';

    await auth.supabase.from('fabric_validator_events').insert({
      workspace_id,
      mission_id: mission_id ?? null,
      target_kind: context,
      target_id: target_id ?? null,
      severity,
      rules_violated: result.rulesViolated,
      forbidden_terms: result.forbiddenTermsHit,
      content_snippet: content.slice(0, 800),
      detail: { violations: result.violations },
    });
  }

  return NextResponse.json({
    ok: result.ok,
    summary: summarizeResult(result),
    violations: result.violations,
    forbidden_terms: result.forbiddenTermsHit,
    rules_violated: result.rulesViolated,
  });
}
