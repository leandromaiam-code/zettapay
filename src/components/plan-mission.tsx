'use client';

import { useTransition } from 'react';
import { Sparkles, Play, Pause } from 'lucide-react';
import { startMission } from '@/app/(app)/[workspace]/actions';
import { formatRelativeDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { Mission } from '@/lib/types';

function sourceMeta(src: string | null) {
  if (!src) return null;
  if (src === 'human') return { label: 'humano', cls: 'text-[var(--text-secondary)]' };
  if (src === 'auto')  return { label: 'autônomo', cls: 'text-[var(--color-brass)]' };
  if (src.startsWith('hipotese:')) return { label: `hipótese · ${src.split(':')[1]}`, cls: 'text-[var(--color-brass)]' };
  return { label: src, cls: 'text-[var(--text-secondary)]' };
}

export function PlanMission({ mission, workspaceSlug }: { mission: Mission; workspaceSlug: string }) {
  const [isPending, startTransition] = useTransition();
  const source = sourceMeta(mission.source);

  function start() {
    startTransition(async () => {
      await startMission({ missionId: mission.id, workspaceSlug });
    });
  }

  return (
    <article className="glass rounded-xl p-5 transition-all hover:border-[var(--color-brass)]/30 group animate-fade-in">
      <div className="flex items-start gap-4">
        <Sparkles className="h-5 w-5 text-[var(--color-brass)] mt-1 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-brass)]">
              · planejada
            </span>
            {source && (
              <span className={cn('font-mono text-[10px] font-semibold uppercase tracking-[0.18em]', source.cls)}>
                · {source.label}
              </span>
            )}
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              · há {formatRelativeDate(mission.created_at)}
            </span>
          </div>
          <h3 className="font-display text-[1.25rem] font-semibold leading-snug text-[var(--text-primary)]">
            {mission.name}
          </h3>
          {mission.description && (
            <p className="mt-2 text-[14px] font-medium text-[var(--text-secondary)] leading-relaxed">
              {mission.description}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={start}
          disabled={isPending}
          className="btn-brass rounded-lg h-9 px-4 inline-flex items-center gap-2 text-xs flex-shrink-0 disabled:opacity-50 transition-all"
          title="Promover para execução"
        >
          {isPending ? (
            <span className="h-3 w-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
          Forjar
        </button>
      </div>
    </article>
  );
}
