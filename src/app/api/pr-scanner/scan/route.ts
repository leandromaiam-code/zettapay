import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { parseUnifiedDiff, decideVerdict } from '@/lib/pr-scanner';
import { validateContent } from '@/lib/validator/premissas';
import { checkFiles, type FileGuardRule } from '@/lib/file-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  mission_id: z.string().uuid().nullable().optional(),
  pr_url: z.string().url().nullable().optional(),
  pr_number: z.number().int().nullable().optional(),
  base_sha: z.string().max(80).nullable().optional(),
  head_sha: z.string().max(80).nullable().optional(),
  branch_name: z.string().max(200).nullable().optional(),
  diff: z.string().min(1).max(2_000_000),
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

  const { workspace_id, mission_id, pr_url, pr_number, base_sha, head_sha, branch_name, diff } = parsed.data;

  const stats = parseUnifiedDiff(diff);

  // Premissas validation — only on the diff body (not the file list)
  const validation = validateContent({
    content: diff,
    context: 'pr_diff',
  });
  const premissasCritical = validation.violations.filter((v) => v.severity === 'critical').length;

  // File Guard
  const { data: rules } = await auth.supabase
    .from('fabric_file_guard_rules')
    .select('id, workspace_id, pattern, action, reason')
    .or(`workspace_id.is.null,workspace_id.eq.${workspace_id}`);
  const guardResult = checkFiles(stats.files, (rules ?? []) as FileGuardRule[]);

  const verdict = decideVerdict({
    premissasViolations: validation.violations.length,
    premissasCritical,
    fileGuardViolations: guardResult.blocked.length,
  });

  const { data: row, error } = await auth.supabase
    .from('fabric_pr_scans')
    .insert({
      workspace_id,
      mission_id: mission_id ?? null,
      pr_url: pr_url ?? null,
      pr_number: pr_number ?? null,
      base_sha: base_sha ?? null,
      head_sha: head_sha ?? null,
      branch_name: branch_name ?? null,
      files_changed: stats.filesChanged,
      lines_added: stats.linesAdded,
      lines_removed: stats.linesRemoved,
      premissas_violations: validation.violations.length,
      file_guard_violations: guardResult.blocked.length,
      forbidden_terms_count: validation.forbiddenTermsHit.length,
      verdict: verdict.verdict,
      summary: verdict.summary,
      detail: {
        violations: validation.violations,
        forbidden_terms: validation.forbiddenTermsHit,
        rules_violated: validation.rulesViolated,
        blocked_files: guardResult.blocked.map((d) => ({
          path: d.path,
          pattern: d.matchedRule?.pattern,
          reason: d.matchedRule?.reason,
        })),
      },
    })
    .select('id, verdict, summary')
    .single();

  if (error) {
    return NextResponse.json({ error: 'insert failed', detail: error.message }, { status: 500 });
  }

  if (validation.violations.length > 0) {
    const severity = premissasCritical > 0
      ? 'critical'
      : validation.violations.some((v) => v.severity === 'warning')
      ? 'warning'
      : 'info';
    await auth.supabase.from('fabric_validator_events').insert({
      workspace_id,
      mission_id: mission_id ?? null,
      target_kind: 'pr_diff',
      target_id: head_sha ?? null,
      severity,
      rules_violated: validation.rulesViolated,
      forbidden_terms: validation.forbiddenTermsHit,
      content_snippet: diff.slice(0, 800),
      detail: { pr_url, head_sha, violations: validation.violations },
    });
  }

  return NextResponse.json({
    ok: true,
    scan_id: row.id,
    verdict: row.verdict,
    summary: row.summary,
    stats: {
      files_changed: stats.filesChanged,
      lines_added: stats.linesAdded,
      lines_removed: stats.linesRemoved,
    },
    premissas_violations: validation.violations.length,
    file_guard_violations: guardResult.blocked.length,
  });
}
