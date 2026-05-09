import { Rocket, ExternalLink, Loader2, AlertTriangle, XOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VercelDeploymentState } from '@/lib/types';

interface PreviewBadgeProps {
  state: VercelDeploymentState | null;
  url: string | null;
  className?: string;
}

const STATE_LABEL: Record<VercelDeploymentState, string> = {
  queued:   'fila',
  building: 'forjando',
  ready:    'preview',
  error:    'falhou',
  canceled: 'cancelado',
};

const STATE_PILL: Record<VercelDeploymentState, string> = {
  queued:   'pill-pending',
  building: 'pill-pending',
  ready:    'pill-running',
  error:    'pill-failed',
  canceled: 'pill-paused',
};

export function PreviewBadge({ state, url, className }: PreviewBadgeProps) {
  if (!state) return null;

  const Icon =
    state === 'building' || state === 'queued' ? Loader2
      : state === 'ready'    ? Rocket
      : state === 'error'    ? AlertTriangle
      : XOctagon;

  const label = STATE_LABEL[state];
  const pillClass = STATE_PILL[state];
  const isReady = state === 'ready' && Boolean(url);

  const pill = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-md font-mono text-[10px] font-semibold uppercase tracking-[0.16em]',
        pillClass,
        isReady && 'transition-colors hover:brightness-110',
        className
      )}
    >
      <Icon
        className={cn('h-3 w-3', (state === 'building' || state === 'queued') && 'animate-spin')}
        strokeWidth={2.4}
      />
      <span>{label}</span>
      {isReady && <ExternalLink className="h-2.5 w-2.5 opacity-80" strokeWidth={2.4} />}
    </span>
  );

  if (isReady && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex"
        aria-label={`abrir preview deploy: ${url}`}
      >
        {pill}
      </a>
    );
  }

  return pill;
}
