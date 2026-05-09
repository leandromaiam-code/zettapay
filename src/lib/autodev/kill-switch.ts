/**
 * FR.1 Wave A — Kill Switch
 *
 * Encapsula o estado do AutoDev por workspace. O DB tem o trigger
 * fabric_trg_track_mission_failure que conta falhas e dispara
 * circuit_broken; aqui ficam os helpers que o servidor usa para
 *   - checar antes de despachar uma mission
 *   - parar manualmente em < 5s (premissa V.10)
 *   - retomar (apenas owner)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type AutodevState = 'active' | 'paused' | 'circuit_broken';

export interface KillSwitchSnapshot {
  state: AutodevState;
  failure_count: number;
  threshold: number;
  killed_at: string | null;
  killed_reason: string | null;
}

export async function readKillSwitch(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<KillSwitchSnapshot | null> {
  const { data } = await supabase
    .from('fabric_core_workspaces')
    .select(
      'autodev_state, autodev_failure_count, autodev_circuit_threshold, autodev_killed_at, autodev_killed_reason'
    )
    .eq('id', workspaceId)
    .single();
  if (!data) return null;
  return {
    state: (data.autodev_state ?? 'active') as AutodevState,
    failure_count: data.autodev_failure_count ?? 0,
    threshold: data.autodev_circuit_threshold ?? 3,
    killed_at: data.autodev_killed_at ?? null,
    killed_reason: data.autodev_killed_reason ?? null,
  };
}

export async function pauseAutodev(
  supabase: SupabaseClient,
  workspaceId: string,
  reason: string,
  actor: string
): Promise<void> {
  await supabase
    .from('fabric_core_workspaces')
    .update({
      autodev_state: 'paused',
      autodev_killed_at: new Date().toISOString(),
      autodev_killed_reason: reason,
    })
    .eq('id', workspaceId);

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: workspaceId,
    event_type: 'autodev_paused',
    payload: { reason, by: actor },
    actor,
  });
}

export async function resumeAutodev(
  supabase: SupabaseClient,
  workspaceId: string,
  actor: string
): Promise<void> {
  await supabase
    .from('fabric_core_workspaces')
    .update({
      autodev_state: 'active',
      autodev_failure_count: 0,
      autodev_killed_at: null,
      autodev_killed_reason: null,
    })
    .eq('id', workspaceId);

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: workspaceId,
    event_type: 'autodev_resumed',
    payload: { by: actor },
    actor,
  });
}
