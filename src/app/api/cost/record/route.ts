import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireInternalAuth } from '@/lib/api-auth';
import { buildLedgerRow } from '@/lib/cost';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspace_id: z.string().uuid(),
  mission_id: z.string().uuid().nullable().optional(),
  agent_id: z.string().max(80).nullable().optional(),
  source: z.enum(['autodev', 'plan_squad', 'validator', 'manual', 'other']).optional(),
  model: z.string().min(1).max(80),
  prompt_tokens: z.number().int().min(0).max(50_000_000),
  completion_tokens: z.number().int().min(0).max(50_000_000),
  usd_amount: z.number().min(0).max(10_000).optional(),
  meta: z.record(z.unknown()).optional(),
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

  const row = buildLedgerRow(parsed.data);
  const { data, error } = await auth.supabase
    .from('fabric_cost_ledger')
    .insert(row)
    .select('id, usd_amount, total_tokens')
    .single();

  if (error) {
    return NextResponse.json({ error: 'insert failed', detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: data.id, usd_amount: data.usd_amount, total_tokens: data.total_tokens });
}
