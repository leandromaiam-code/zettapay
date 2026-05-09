'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export async function updateWorkspace(input: {
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  brand_color: string;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({ name: input.name.trim(), brand_color: input.brand_color })
    .eq('id', input.workspaceId);

  if (error) return { error: error.message };

  revalidatePath(`/${input.workspaceSlug}/settings`);
  revalidatePath(`/${input.workspaceSlug}`);
  return {};
}

export async function toggleAutodev(input: {
  workspaceId: string;
  workspaceSlug: string;
  enabled: boolean;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({ autodev_enabled: input.enabled })
    .eq('id', input.workspaceId);

  if (error) return { error: error.message };

  // Auditoria no journal
  await supabase.from('fabric_audit_journal').insert({
    workspace_id: input.workspaceId,
    event_type: input.enabled ? 'autodev_enabled' : 'autodev_disabled',
    payload: { by: user.email },
    actor: user.email ?? 'user',
  });

  revalidatePath(`/${input.workspaceSlug}/settings`);
  revalidatePath(`/${input.workspaceSlug}`);
  revalidatePath('/');
  return {};
}

export async function setAutodevSchedule(input: {
  workspaceId: string;
  workspaceSlug: string;
  startHour: number;
  stopHour: number;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  if (input.startHour < 0 || input.startHour > 23 || input.stopHour < 0 || input.stopHour > 23) {
    return { error: 'Horas devem estar entre 0 e 23' };
  }

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({
      autodev_start_hour: input.startHour,
      autodev_stop_hour: input.stopHour,
    })
    .eq('id', input.workspaceId);

  if (error) return { error: error.message };

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: input.workspaceId,
    event_type: 'autodev_schedule_updated',
    payload: { start: input.startHour, stop: input.stopHour, by: user.email },
    actor: user.email ?? 'user',
  });

  revalidatePath(`/${input.workspaceSlug}/settings`);
  return {};
}

export async function runAutodevForMinutes(input: {
  workspaceId: string;
  workspaceSlug: string;
  minutes: number;
}): Promise<{ error?: string; until?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const minutes = Math.max(1, Math.min(720, input.minutes));
  const until = new Date(Date.now() + minutes * 60_000).toISOString();

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({
      autodev_manual_until: until,
      autodev_enabled: true,
    })
    .eq('id', input.workspaceId);

  if (error) return { error: error.message };

  await supabase.from('fabric_audit_journal').insert({
    workspace_id: input.workspaceId,
    event_type: 'autodev_manual_run',
    payload: { minutes, until, by: user.email },
    actor: user.email ?? 'user',
  });

  // Dispara um tick imediato no fabric-api (sem esperar 8min do cron)
  try {
    const apiUrl = process.env.FABRIC_API_URL;
    const apiToken = process.env.FABRIC_API_TOKEN;
    if (apiUrl && apiToken) {
      // Dispara EXECUTION imediata: pega proxima mission do roadmap canonical e spawna claude-code
      await fetch(`${apiUrl}/pick-and-execute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(20_000),
      }).catch(() => { /* fire-and-forget */ });
    }
  } catch { /* nao bloqueia se falhar */ }

  revalidatePath(`/${input.workspaceSlug}/settings`);
  revalidatePath(`/${input.workspaceSlug}`);
  return { until };
}

export async function cancelAutodevManual(input: {
  workspaceId: string;
  workspaceSlug: string;
}): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { error } = await supabase
    .from('fabric_core_workspaces')
    .update({ autodev_manual_until: null })
    .eq('id', input.workspaceId);

  if (error) return { error: error.message };

  revalidatePath(`/${input.workspaceSlug}/settings`);
  return {};
}

export async function executeMission(input: {
  workspaceSlug: string;
  missionId: string;
}): Promise<{ error?: string; task_id?: string; branch_name?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // F2.11 — bloqueia despacho se squad da mission nao estiver na allowlist do workspace.
  const { data: gate } = await supabase
    .from('fabric_squad_missions')
    .select('squad, workspace_id, fabric_core_workspaces!inner(allowed_mission_squads)')
    .eq('id', input.missionId)
    .single<{
      squad: string;
      workspace_id: string;
      fabric_core_workspaces: { allowed_mission_squads: string[] | null } | null;
    }>();
  if (gate) {
    const allowed = gate.fabric_core_workspaces?.allowed_mission_squads ?? [];
    if (allowed.length > 0 && !allowed.includes(gate.squad)) {
      await supabase.from('fabric_audit_journal').insert({
        workspace_id: gate.workspace_id,
        event_type: 'mission_execute_blocked_by_allowlist',
        payload: {
          mission_id: input.missionId,
          squad: gate.squad,
          allowed,
          by: user.email,
        },
        actor: user.email ?? 'user',
      });
      return {
        error: `Squad "${gate.squad}" nao esta na allowlist do workspace. Habilite em Settings → Mission Type Allowlist.`,
      };
    }
  }

  const apiUrl = process.env.FABRIC_API_URL;
  const apiToken = process.env.FABRIC_API_TOKEN;
  if (!apiUrl || !apiToken) {
    return { error: 'fabric-api not configured' };
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
      return { error: `fabric-api ${r.status}: ${text.slice(0,200)}` };
    }
    const data = await r.json();

    await supabase.from('fabric_audit_journal').insert({
      workspace_id: data.workspace_id ?? null,
      event_type: 'mission_execute_dispatched',
      payload: { mission_id: input.missionId, task_id: data.task_id, branch: data.branch_name, by: user.email },
      actor: user.email ?? 'user',
    });

    revalidatePath(`/${input.workspaceSlug}`);
    revalidatePath(`/${input.workspaceSlug}/missions/${input.missionId}`);

    return { task_id: data.task_id, branch_name: data.branch_name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'unknown' };
  }
}
