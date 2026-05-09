import type { SupabaseClient } from '@supabase/supabase-js';

export type EventCategory =
  | 'mission'
  | 'reasoning'
  | 'artifact'
  | 'hipotese'
  | 'journal';

export interface FabricEvent {
  /** Stable identity: `${category}:${sourceId}` (ou um sufixo para variações) */
  id: string;
  category: EventCategory;
  /** Tipo legível (ex: 'mission_running', 'reasoning_step', 'artifact_created') */
  kind: string;
  /** Resumo curto, plain text */
  title: string;
  /** Descrição opcional, plain text */
  detail?: string | null;
  /** Quem disparou (system, n8n, agent:<id>, user:<email>) */
  actor: string;
  /** ISO timestamp de quando o evento ocorreu */
  at: string;
  /** Mission relacionada (para deep link) */
  missionId?: string | null;
  /** Hipótese relacionada (para deep link) */
  hipoteseId?: string | null;
  /** Payload original (para inspeção) */
  meta?: Record<string, unknown>;
}

const PAGE = 60;

/**
 * Busca os eventos recentes de um workspace consolidando 5 fontes:
 * journal, missions, reasoning steps, artifacts, hipóteses.
 *
 * RLS garante que só dados do workspace acessível ao usuário voltem.
 */
export async function getRecentEvents(
  supabase: SupabaseClient,
  workspaceId: string,
  limit = PAGE,
): Promise<FabricEvent[]> {
  const [
    { data: journal },
    { data: missions },
    { data: reasoning },
    { data: artifacts },
    { data: hipoteses },
  ] = await Promise.all([
    supabase
      .from('fabric_audit_journal')
      .select('id, event_type, payload, actor, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('fabric_squad_missions')
      .select('id, name, phase, status, source, started_at, completed_at, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('fabric_squad_reasoning')
      .select('id, mission_id, step, role, text, ts')
      .eq('workspace_id', workspaceId)
      .order('ts', { ascending: false })
      .limit(limit),
    supabase
      .from('fabric_squad_artifacts')
      .select('id, mission_id, kind, label, url, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('fabric_layer1_hipoteses')
      .select('id, source, title, status, created_at, decided_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const events: FabricEvent[] = [];

  for (const j of journal ?? []) {
    const payload = (j.payload ?? {}) as Record<string, unknown>;
    events.push({
      id: `journal:${j.id}`,
      category: 'journal',
      kind: j.event_type,
      title: humanizeJournal(j.event_type, payload),
      detail: typeof payload.detail === 'string' ? payload.detail : null,
      actor: j.actor ?? 'system',
      at: j.created_at,
      missionId: typeof payload.mission_id === 'string' ? payload.mission_id : null,
      hipoteseId: typeof payload.hipotese_id === 'string' ? payload.hipotese_id : null,
      meta: payload,
    });
  }

  for (const m of missions ?? []) {
    // started → running, completed → succeeded/failed, criada → created
    if (m.completed_at) {
      events.push({
        id: `mission:${m.id}:done`,
        category: 'mission',
        kind: m.status === 'succeeded' ? 'mission_succeeded' : m.status === 'failed' ? 'mission_failed' : 'mission_completed',
        title: `${m.status === 'failed' ? 'Mission falhou' : 'Mission concluída'} — ${m.name}`,
        detail: `phase ${m.phase}`,
        actor: m.source ?? 'system',
        at: m.completed_at,
        missionId: m.id,
        meta: { phase: m.phase, status: m.status, source: m.source },
      });
    }
    if (m.started_at) {
      events.push({
        id: `mission:${m.id}:start`,
        category: 'mission',
        kind: 'mission_running',
        title: `Mission em execução — ${m.name}`,
        detail: `phase ${m.phase}`,
        actor: m.source ?? 'system',
        at: m.started_at,
        missionId: m.id,
        meta: { phase: m.phase, status: m.status, source: m.source },
      });
    }
    events.push({
      id: `mission:${m.id}:created`,
      category: 'mission',
      kind: 'mission_created',
      title: `Mission criada — ${m.name}`,
      detail: `phase ${m.phase}`,
      actor: m.source ?? 'system',
      at: m.created_at,
      missionId: m.id,
      meta: { phase: m.phase, status: m.status, source: m.source },
    });
  }

  for (const r of reasoning ?? []) {
    events.push({
      id: `reasoning:${r.id}`,
      category: 'reasoning',
      kind: `reasoning_${r.role}`,
      title: truncate(r.text, 140),
      detail: `passo ${String(r.step).padStart(2, '0')} · ${r.role}`,
      actor: 'agent',
      at: r.ts,
      missionId: r.mission_id,
      meta: { step: r.step, role: r.role },
    });
  }

  for (const a of artifacts ?? []) {
    events.push({
      id: `artifact:${a.id}`,
      category: 'artifact',
      kind: 'artifact_created',
      title: `Artefato — ${a.label}`,
      detail: a.kind,
      actor: 'agent',
      at: a.created_at,
      missionId: a.mission_id,
      meta: { kind: a.kind, url: a.url, label: a.label },
    });
  }

  for (const h of hipoteses ?? []) {
    events.push({
      id: `hipotese:${h.id}:created`,
      category: 'hipotese',
      kind: 'hipotese_created',
      title: `Hipótese (${h.source}) — ${h.title}`,
      detail: `status ${h.status}`,
      actor: h.source,
      at: h.created_at,
      hipoteseId: h.id,
      meta: { source: h.source, status: h.status },
    });
    if (h.decided_at && h.status !== 'pending') {
      events.push({
        id: `hipotese:${h.id}:decided`,
        category: 'hipotese',
        kind: `hipotese_${h.status}`,
        title: `Hipótese ${labelizeStatus(h.status)} — ${h.title}`,
        actor: 'operator',
        at: h.decided_at,
        hipoteseId: h.id,
        meta: { source: h.source, status: h.status },
      });
    }
  }

  return events
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function labelizeStatus(s: string): string {
  switch (s) {
    case 'approved': return 'aprovada';
    case 'rejected': return 'rejeitada';
    case 'deferred': return 'adiada';
    default:         return s;
  }
}

function humanizeJournal(eventType: string, payload: Record<string, unknown>): string {
  // Mapeia event_types conhecidos para PT-BR. Fallback: o próprio event_type.
  const title = typeof payload.title === 'string' ? payload.title : null;
  switch (eventType) {
    case 'workspace_created':
      return `Workspace criado${payload.name ? ` — ${payload.name}` : ''}`;
    case 'hipotese_inserted':
      return title ? `Hipótese ingerida — ${title}` : 'Hipótese ingerida';
    case 'metric_recorded':
      return 'Métrica capturada';
    case 'mission_started':
      return title ? `Mission iniciada — ${title}` : 'Mission iniciada';
    case 'mission_paused':
      return title ? `Mission pausada — ${title}` : 'Mission pausada';
    default:
      return eventType.replace(/_/g, ' ');
  }
}
