import { cn } from '@/lib/utils';
import type { MissionStatus } from '@/lib/types';

const labels: Record<MissionStatus, string> = {
  pending:   'pendente',
  running:   'em andamento',
  succeeded: 'concluída',
  failed:    'falhou',
  paused:    'pausada',
};

export function StatusPill({ status, className }: { status: MissionStatus; className?: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-2 px-2.5 py-1 rounded-md font-mono text-[10px] font-semibold uppercase tracking-[0.16em]',
      `pill-${status}`,
      className
    )}>
      {status === 'running' && (
        <span className="h-1.5 w-1.5 rounded-full bg-current pulse-dot" />
      )}
      {status === 'succeeded' && (
        <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current"><path d="M5 8.5L2 5.5l1-1 2 2 4-4 1 1z"/></svg>
      )}
      {labels[status]}
    </span>
  );
}
