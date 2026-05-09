'use client';

import { useEffect, useRef, useState } from 'react';
import { Brain, Wrench, Eye, ListChecks, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { ReasoningStep, Mission } from '@/lib/types';

const roleIcons = {
  plan:        ListChecks,
  tool:        Wrench,
  observation: Eye,
  assistant:   Brain,
};

const roleAccent = {
  plan:        'brass',
  tool:        'emerald',
  observation: 'forest',
  assistant:   'forest',
} as const;

interface Props {
  missionId: string;
  initialSteps: ReasoningStep[];
  initialStatus: Mission['status'];
}

export function MissionLiveReasoning({ missionId, initialSteps, initialStatus }: Props) {
  const [steps, setSteps] = useState<ReasoningStep[]>(initialSteps);
  const [status, setStatus] = useState<Mission['status']>(initialStatus);
  const containerRef = useRef<HTMLOListElement>(null);
  const seenIds = useRef<Set<string>>(new Set(initialSteps.map((s) => s.id)));

  function appendIfNew(newSteps: ReasoningStep[]) {
    const fresh = newSteps.filter((s) => !seenIds.current.has(s.id));
    if (fresh.length === 0) return;
    fresh.forEach((s) => seenIds.current.add(s.id));
    setSteps((prev) => [...prev, ...fresh].sort((a, b) => a.step - b.step));
    requestAnimationFrame(() => {
      containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
    });
  }

  useEffect(() => {
    const supabase = createClient();
    const isActive = status === 'running' || status === 'pending';

    // 1. POLLING — funciona sempre, dedup via seenIds
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (isActive) {
      const poll = async () => {
        const [{ data: stepData }, { data: missionData }] = await Promise.all([
          supabase.from('fabric_squad_reasoning')
            .select('*')
            .eq('mission_id', missionId)
            .order('step', { ascending: true }),
          supabase.from('fabric_squad_missions')
            .select('status')
            .eq('id', missionId)
            .maybeSingle(),
        ]);
        if (stepData) appendIfNew(stepData as ReasoningStep[]);
        if (missionData?.status) {
          setStatus(missionData.status as Mission['status']);
        }
      };
      poll(); // imediato
      pollTimer = setInterval(poll, 3000);
    }

    // 2. REALTIME — bonus (se conectar, evita esperar 3s)
    const channel = supabase
      .channel(`mission-${missionId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'fabric_squad_reasoning',
          filter: `mission_id=eq.${missionId}`,
        },
        (payload) => {
          appendIfNew([payload.new as ReasoningStep]);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'fabric_squad_missions',
          filter: `id=eq.${missionId}`,
        },
        (payload) => {
          const m = payload.new as Mission;
          setStatus(m.status);
        }
      )
      .subscribe();

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      supabase.removeChannel(channel);
    };
  }, [missionId, status]);

  // Cleanup polling quando status muda para finalizado
  useEffect(() => {
    if (status === 'succeeded' || status === 'failed') {
      // drain final once
      const supabase = createClient();
      supabase.from('fabric_squad_reasoning')
        .select('*')
        .eq('mission_id', missionId)
        .order('step', { ascending: true })
        .then(({ data }) => {
          if (data) appendIfNew(data as ReasoningStep[]);
        });
    }
  }, [status, missionId]);

  const isRunning = status === 'running';

  return (
    <details
      className="mt-5 pt-5 border-t border-[var(--border-divider)] group"
      open={isRunning || steps.length > 0}
    >
      <summary className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)] mb-3 cursor-pointer flex items-center gap-2 list-none">
        {isRunning ? (
          <Loader2 className="h-3 w-3 animate-spin text-[var(--color-aurora-bright)]" strokeWidth={2.5} />
        ) : (
          <Brain className="h-3 w-3" strokeWidth={2} />
        )}
        Raciocínio do Fabric · {steps.length} passos
        {isRunning && (
          <span className="font-mono text-[10px] font-medium normal-case tracking-normal text-[var(--color-aurora-bright)] ml-1">
            · ao vivo
          </span>
        )}
        <span className="ml-auto text-[var(--text-muted)] group-open:hidden font-medium normal-case tracking-normal">expandir →</span>
        <span className="ml-auto text-[var(--text-muted)] hidden group-open:inline font-medium normal-case tracking-normal">recolher ↑</span>
      </summary>

      <ol
        ref={containerRef}
        className="mt-4 space-y-4 max-h-[600px] overflow-y-auto pr-2 relative"
      >
        <span className="absolute left-[26px] top-3 bottom-3 w-px bg-[var(--border-divider)]" />

        {steps.length === 0 && (
          <li className="text-sm text-[var(--text-muted)] italic ml-8">
            {isRunning ? 'Aguardando primeiro passo do agente…' : 'Sem reasoning steps.'}
          </li>
        )}

        {steps.map((step, idx) => {
          const Icon = roleIcons[step.role] ?? Brain;
          const accent = roleAccent[step.role] ?? 'forest';
          const isLatest = idx === steps.length - 1;
          return (
            <li
              key={step.id}
              className="flex items-start gap-3 relative animate-fade-in"
              style={{ animationDelay: idx >= initialSteps.length ? '0s' : `${Math.min(idx * 0.04, 0.5)}s` }}
            >
              <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)] pt-2 w-6 flex-shrink-0 text-right">
                {String(step.step).padStart(2, '0')}
              </span>
              <div
                className={cn(
                  'icon-box relative z-[1]',
                  `icon-bg-${accent}`,
                  isLatest && isRunning && 'reactor-ring'
                )}
                style={{ width: 28, height: 28, borderRadius: 8 }}
              >
                <Icon className="h-3 w-3 relative z-[1]" />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
                    {step.role}
                  </span>
                  {isLatest && isRunning && (
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--color-aurora-bright)] animate-pulse">
                      · agora
                    </span>
                  )}
                </div>
                <p className="text-[13.5px] font-medium text-[var(--text-primary)] leading-[1.6] whitespace-pre-wrap break-words">
                  {step.text}
                </p>
              </div>
            </li>
          );
        })}

        {isRunning && steps.length > 0 && (
          <li className="flex items-center gap-3 ml-9 text-[var(--text-muted)] italic text-sm">
            <Loader2 className="h-3 w-3 animate-spin" />
            agente continuando…
          </li>
        )}
      </ol>
    </details>
  );
}
