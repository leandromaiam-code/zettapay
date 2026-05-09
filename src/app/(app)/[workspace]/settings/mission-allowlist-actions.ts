'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ALL_SQUADS, type Squad } from '@/lib/types';

const KNOWN_SQUADS = new Set<Squad>(ALL_SQUADS);

function normalizeSquads(input: string[]): Squad[] {
  const seen = new Set<Squad>();
  for (const raw of input) {
    const candidate = (raw ?? '').trim().toLowerCase() as Squad;
    if (KNOWN_SQUADS.has(candidate)) seen.add(candidate);
  }
  return ALL_SQUADS.filter((s) => seen.has(s));
}

export async function setAllowedMissionSquads(input: {
  workspaceId: string;
  workspaceSlug: string;
  squads: string[];
}): Promise<{ error?: string; squads?: Squad[] }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const next = normalizeSquads(input.squads);
  if (next.length === 0) {
    return { error: 'Pelo menos um squad precisa permanecer permitido.' };
  }

  const { data: ws, error: wsErr } = await supabase
    .from('fabric_core_workspaces')
    .select('owner_id, allowed_mission_squads')
    .eq('id', input.workspaceId)
    .single<{ owner_id: string; allowed_mission_squads: Squad[] | null }>();
  if (wsErr || !ws) return { error: wsErr?.message ?? 'Workspace nao encontrado.' };
  if (ws.owner_id !== user.id) {
    return { error: 'Apenas o owner pode alterar tipos de missao permitidos.' };
  }

  const previous = (ws.allowed_mission_squads ?? []).slice().sort().join(',');
  const target = next.slice().sort().join(',');
  if (previous === target) {
    return { squads: next };
  }

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({ allowed_mission_squads: next })
    .eq('id', input.workspaceId);
  if (error) return { error: error.message };

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: input.workspaceId,
    event_type: 'mission_allowlist_updated',
    payload: {
      before: ws.allowed_mission_squads ?? [],
      after: next,
      by: user.email,
    },
    actor: user.email ?? 'user',
  });

  revalidatePath(`/${input.workspaceSlug}/settings`);
  revalidatePath(`/${input.workspaceSlug}`);
  return { squads: next };
}
