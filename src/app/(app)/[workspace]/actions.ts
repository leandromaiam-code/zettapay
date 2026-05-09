'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function createMission(input: {
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  description?: string;
  source?: string;
}): Promise<{ id?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  if (!input.name.trim()) return { error: 'Nome obrigatório.' };

  const { data, error } = await supabase
    .from('fabric_squad_missions')
    .insert({
      workspace_id: input.workspaceId,
      squad: 'dev',
      name: input.name.trim(),
      description: input.description ?? null,
      phase: 'plan',
      status: 'pending',
      source: input.source ?? 'human',
    })
    .select('id')
    .single();

  if (error) return { error: error.message };

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: input.workspaceId,
    event_type: 'mission_created',
    payload: { mission_id: data.id, name: input.name, source: input.source ?? 'human' },
    actor: user.email ?? 'user',
  });

  revalidatePath(`/${input.workspaceSlug}`);
  return { id: data.id };
}

export async function startMission(input: {
  missionId: string;
  workspaceSlug: string;
}): Promise<{ ok: boolean; error?: string; pr_url?: string; branch_name?: string }> {
  const apiUrl = process.env.FABRIC_API_URL;
  const apiToken = process.env.FABRIC_API_TOKEN;
  if (!apiUrl || !apiToken) {
    return { ok: false, error: 'fabric-api not configured' };
  }

  try {
    const r = await fetch(`${apiUrl}/execute-mission`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ mission_id: input.missionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, error: `fabric-api ${r.status}: ${text.slice(0,200)}` };
    }
    const data = await r.json();
    revalidatePath(`/${input.workspaceSlug}`);
    revalidatePath(`/${input.workspaceSlug}/missions/${input.missionId}`);
    return { ok: true, branch_name: data.branch_name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}

export async function pauseMission(input: {
  missionId: string;
  workspaceSlug: string;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  await supabase
    .from('fabric_squad_missions')
    .update({ status: 'paused' })
    .eq('id', input.missionId);
  revalidatePath(`/${input.workspaceSlug}`);
  return { ok: true };
}
