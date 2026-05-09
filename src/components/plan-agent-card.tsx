'use client';

import { useState, useTransition } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  ChevronRight,
  Play,
  Loader2,
  Lightbulb,
  Search,
  Users,
  FileText,
  Map,
  FlaskConical,
  Target,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanAgent, PlanAgentIcon } from '@/lib/plan-agents';

const ICONS: Record<PlanAgentIcon, LucideIcon> = {
  Lightbulb,
  Search,
  Users,
  FileText,
  Map,
  FlaskConical,
  Target,
  AlertTriangle,
};

const accentToBg = {
  brass:   'icon-bg-brass',
  emerald: 'icon-bg-emerald',
  forest:  'icon-bg-forest',
} as const;

export function PlanAgentCard({ agent }: { agent: PlanAgent }) {
  const router = useRouter();
  const params = useParams<{ workspace: string }>();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [taskInfo, setTaskInfo] = useState<{ id: string; mission_id: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const Icon = ICONS[agent.icon] ?? Lightbulb;

  function execute() {
    if (!input.trim()) {
      setError('Input requerido');
      return;
    }
    setError('');
    startTransition(async () => {
      try {
        const r = await fetch('/api/agents/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: agent.id,
            workspace_slug: params.workspace,
            input: input.trim(),
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error ?? 'erro desconhecido');
          return;
        }
        setTaskInfo({ id: data.task_id, mission_id: data.mission_id });
        setInput('');
        // Recarrega após 2s para mostrar a mission no Plan
        setTimeout(() => router.refresh(), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'erro de rede');
      }
    });
  }

  return (
    <article
      className={cn(
        'glass hud-scan-host rounded-2xl p-5 transition-all hover:translate-y-[-2px] hover:shadow-xl group',
        open && 'ring-1 ring-[var(--border-active)] shadow-2xl',
        !open && 'cursor-pointer'
      )}
      onClick={() => !open && setOpen(true)}
    >
      <div className="flex items-start gap-4">
        <div className={cn('icon-box', accentToBg[agent.accent])} style={{ width: 48, height: 48 }}>
          <Icon className="h-5 w-5 relative z-[1]" strokeWidth={2} />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-display text-[1.15rem] font-semibold text-[var(--text-primary)] leading-[1.2]">
            {agent.name}
          </h3>
          <p className="mt-1.5 text-[13px] font-medium text-[var(--text-secondary)] leading-[1.55]">
            {agent.description}
          </p>
        </div>

        <ChevronRight
          className={cn(
            'h-4 w-4 text-[var(--text-muted)] flex-shrink-0 mt-1.5 transition-transform',
            open && 'rotate-90'
          )}
          strokeWidth={2}
        />
      </div>

      {open && (
        <div className="mt-5 pt-5 border-t border-[var(--border-divider)] animate-fade-in">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
            <div>
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">
                Inputs esperados
              </span>
              <ul className="mt-2 space-y-1.5">
                {agent.inputs.map((i) => (
                  <li key={i} className="text-[13px] font-medium text-[var(--text-secondary)] flex items-start gap-2">
                    <span className="mt-2 h-1 w-1 rounded-full bg-[var(--text-muted)] flex-shrink-0" />
                    {i}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--color-brass)]">
                Outputs gerados
              </span>
              <ul className="mt-2 space-y-1.5">
                {agent.outputs.map((o) => (
                  <li key={o} className="text-[13px] font-medium text-[var(--text-primary)] flex items-start gap-2">
                    <span className="mt-2 h-1 w-1 rounded-full bg-[var(--color-brass)] flex-shrink-0" />
                    {o}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Input */}
          <div onClick={(e) => e.stopPropagation()}>
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
              Sua entrada
            </span>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ex: "${agent.inputs[0]?.toLowerCase()}..."`}
              rows={3}
              disabled={isPending || !!taskInfo}
              className="mt-2 w-full bg-[var(--surface-icon)] border border-[var(--border-1)] rounded-lg px-3 py-2.5 text-[13px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-active)] resize-y"
            />

            {error && (
              <p className="mt-2 text-xs font-medium text-[var(--color-ember-soft)]">{error}</p>
            )}

            {taskInfo && (
              <p className="mt-2 text-xs font-medium text-[var(--color-aurora-bright)]">
                ✓ Agente executando · task {taskInfo.id.slice(0, 6)}… · mission criada
              </p>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={execute}
                disabled={isPending || !input.trim() || !!taskInfo}
                className="btn-brass inline-flex items-center gap-2 px-4 h-10 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Disparando…
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" strokeWidth={2.5} />
                    Executar agente
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); setError(''); setTaskInfo(null); }}
                className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
