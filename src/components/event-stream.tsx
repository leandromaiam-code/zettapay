'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Brain,
  FileText,
  Lightbulb,
  ScrollText,
  Wrench,
  Eye,
  ListChecks,
  Radio,
  Filter as FilterIcon,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { FabricEvent, EventCategory } from '@/lib/events';

// ── Visual map ────────────────────────────────────────────────────

const CATEGORY_META: Record<
  EventCategory,
  { label: string; accent: 'brass' | 'emerald' | 'forest' | 'ember'; Icon: React.ComponentType<{ className?: string; strokeWidth?: number }> }
> = {
  mission:   { label: 'Missions',   accent: 'emerald', Icon: Activity },
  reasoning: { label: 'Raciocínio', accent: 'forest',  Icon: Brain },
  artifact:  { label: 'Artefatos',  accent: 'brass',   Icon: FileText },
  hipotese:  { label: 'Hipóteses',  accent: 'ember',   Icon: Lightbulb },
  journal:   { label: 'Journal',    accent: 'forest',  Icon: ScrollText },
};

const ROLE_ICON: Record<string, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  reasoning_assistant:   Brain,
  reasoning_tool:        Wrench,
  reasoning_observation: Eye,
  reasoning_plan:        ListChecks,
};

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  initialEvents: FabricEvent[];
  /** Quantos eventos manter no buffer máximo. Default 200. */
  maxBuffer?: number;
}

type FilterValue = 'all' | EventCategory;

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: 'all',       label: 'Tudo' },
  { value: 'mission',   label: 'Missions' },
  { value: 'reasoning', label: 'Raciocínio' },
  { value: 'artifact',  label: 'Artefatos' },
  { value: 'hipotese',  label: 'Hipóteses' },
  { value: 'journal',   label: 'Journal' },
];

export function EventStream({ workspaceId, workspaceSlug, initialEvents, maxBuffer = 200 }: Props) {
  const [events, setEvents] = useState<FabricEvent[]>(initialEvents);
  const [filter, setFilter] = useState<FilterValue>('all');
  const [live, setLive] = useState(false);
  const seenIds = useRef<Set<string>>(new Set(initialEvents.map((e) => e.id)));

  const append = (incoming: FabricEvent[]) => {
    if (!incoming.length) return;
    setEvents((prev) => {
      const next = [...prev];
      let added = 0;
      for (const ev of incoming) {
        if (seenIds.current.has(ev.id)) continue;
        seenIds.current.add(ev.id);
        next.push(ev);
        added++;
      }
      if (added === 0) return prev;
      next.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      return next.slice(0, maxBuffer);
    });
  };

  // ── Realtime + polling ────────────────────────────────────────
  useEffect(() => {
    const supabase = createClient();
    const wsFilter = `workspace_id=eq.${workspaceId}`;

    // POLLING — fonte da verdade, dedup via seenIds
    const poll = async () => {
      const { getRecentEvents } = await import('@/lib/events');
      const fresh = await getRecentEvents(supabase, workspaceId, 60);
      append(fresh);
    };
    const pollTimer = setInterval(poll, 5000);

    // REALTIME — bonus: encurta latência abaixo do tick do poll
    const channel = supabase
      .channel(`events-${workspaceId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fabric_audit_journal', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fabric_squad_reasoning', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fabric_squad_artifacts', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fabric_squad_missions', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'fabric_squad_missions', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'fabric_layer1_hipoteses', filter: wsFilter },
        () => poll(),
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'fabric_layer1_hipoteses', filter: wsFilter },
        () => poll(),
      )
      .subscribe((status) => {
        setLive(status === 'SUBSCRIBED');
      });

    return () => {
      clearInterval(pollTimer);
      supabase.removeChannel(channel);
    };
  }, [workspaceId, maxBuffer]);

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.category === filter)),
    [events, filter],
  );

  const counts = useMemo(() => {
    const c: Record<FilterValue, number> = { all: events.length, mission: 0, reasoning: 0, artifact: 0, hipotese: 0, journal: 0 };
    for (const e of events) c[e.category]++;
    return c;
  }, [events]);

  return (
    <section className="space-y-6">
      {/* ── Filter bar ───────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          <FilterIcon className="h-3 w-3" strokeWidth={2.2} /> Filtro
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTERS.map((f) => {
            const isActive = f.value === filter;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={cn(
                  'h-8 px-3 rounded-lg text-[12px] font-semibold transition-colors inline-flex items-center gap-2 border',
                  isActive
                    ? 'bg-[var(--hover-surface)] border-[var(--border-2)] text-[var(--text-primary)]'
                    : 'bg-transparent border-[var(--border-divider)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]',
                )}
                aria-pressed={isActive}
              >
                {f.label}
                <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">
                  {counts[f.value]}
                </span>
              </button>
            );
          })}
        </div>

        <span className="ml-auto inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.24em]">
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              live ? 'bg-[var(--color-aurora-bright)] pulse-dot' : 'bg-[var(--text-muted)]',
            )}
            aria-hidden
          />
          <Radio className={cn('h-3 w-3', live ? 'text-[var(--color-aurora-bright)]' : 'text-[var(--text-muted)]')} strokeWidth={2.2} />
          <span className={live ? 'text-[var(--color-aurora-bright)]' : 'text-[var(--text-muted)]'}>
            {live ? 'ao vivo' : 'polling'}
          </span>
        </span>
      </div>

      {/* ── Event list ───────────────────────────────────────────── */}
      <ol className="relative space-y-3">
        {filtered.length === 0 && (
          <li className="glass rounded-xl p-10 text-center">
            <p className="font-display text-base font-semibold text-[var(--text-primary)] mb-1">
              Sem eventos {filter !== 'all' ? `de ${labelOf(filter)}` : ''} ainda
            </p>
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              Conforme agentes rodarem, eventos aparecem aqui em tempo real.
            </p>
          </li>
        )}

        {filtered.map((ev, idx) => (
          <EventRow key={ev.id} event={ev} index={idx} workspaceSlug={workspaceSlug} />
        ))}

        {filtered.length >= maxBuffer && (
          <li className="text-center text-xs font-medium text-[var(--text-muted)] pt-3">
            Mostrando últimos {maxBuffer} eventos.
          </li>
        )}
      </ol>
    </section>
  );
}

// ── Event row ────────────────────────────────────────────────────

function EventRow({ event, index, workspaceSlug }: { event: FabricEvent; index: number; workspaceSlug: string }) {
  const meta = CATEGORY_META[event.category];
  const Icon =
    event.category === 'reasoning' ? (ROLE_ICON[event.kind] ?? meta.Icon) : meta.Icon;
  const href = event.missionId ? `/${workspaceSlug}/missions/${event.missionId}` : null;
  const at = new Date(event.at);
  const isFresh = Date.now() - at.getTime() < 60_000;

  const inner = (
    <article
      className={cn(
        'glass rounded-xl p-4 sm:p-5 group transition-all',
        'hover:translate-y-[-1px] hover:shadow-[0_6px_24px_-12px_rgba(212,169,97,0.35)]',
        href && 'cursor-pointer',
      )}
    >
      <div className="flex items-start gap-3 sm:gap-4">
        <div
          className={cn(
            'icon-box flex-shrink-0',
            `icon-bg-${meta.accent}`,
            isFresh && 'reactor-ring',
          )}
          style={{ width: 32, height: 32, borderRadius: 9 }}
        >
          <Icon className="h-3.5 w-3.5 relative z-[1]" strokeWidth={2.2} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
              {meta.label}
            </span>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--color-brass-deep)]">
              · {event.kind}
            </span>
            {isFresh && (
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--color-aurora-bright)] animate-pulse">
                · agora
              </span>
            )}
          </div>

          <p className="text-[14px] font-semibold text-[var(--text-primary)] leading-snug break-words">
            {event.title}
          </p>

          {event.detail && (
            <p className="mt-1 text-[12.5px] font-medium text-[var(--text-secondary)] leading-relaxed break-words">
              {event.detail}
            </p>
          )}

          <div className="mt-2 flex items-center gap-2 flex-wrap text-[11px] font-mono text-[var(--text-muted)]">
            <time dateTime={event.at} title={at.toLocaleString('pt-BR')}>
              {formatRelative(at)}
            </time>
            <span aria-hidden>·</span>
            <span className="truncate max-w-[200px]">por {event.actor}</span>
            {href && (
              <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-[var(--color-brass)]">
                abrir →
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );

  return (
    <li className="stagger-item" style={{ animationDelay: `${Math.min(index * 0.02, 0.4)}s` }}>
      {href ? (
        <Link href={href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-active)] rounded-xl">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function labelOf(f: FilterValue): string {
  if (f === 'all') return '';
  return CATEGORY_META[f].label.toLowerCase();
}

function formatRelative(d: Date): string {
  const diff = Math.max(0, Date.now() - d.getTime());
  const sec = Math.round(diff / 1000);
  if (sec < 30)  return 'agora há pouco';
  if (sec < 60)  return `há ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60)  return `há ${min} min`;
  const hr = Math.round(min / 60);
  if (hr  < 24)  return `há ${hr}h`;
  const days = Math.round(hr / 24);
  if (days < 7)  return `há ${days}d`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

