import { GitPullRequest, Rocket, FileText, FlaskConical, Sparkles, Brain, Wrench, Eye, ListChecks } from 'lucide-react';
import { MissionLiveReasoning } from './mission-live-reasoning';
import { StatusPill } from './status-pill';
import { PreviewBadge } from './preview-badge';
import { formatRelativeDate } from '@/lib/utils';
import type { Mission, Artifact, ReasoningStep } from '@/lib/types';
import { cn } from '@/lib/utils';

interface MissionCardProps {
  mission: Mission;
  artifacts?: Artifact[];
  reasoning?: ReasoningStep[];
  variant?: 'full' | 'compact';
}

function sourceMeta(src: string | null) {
  if (!src) return null;
  if (src === 'human') return { label: 'humano', cls: 'text-[var(--text-secondary)]' };
  if (src === 'auto')  return { label: 'autônomo', cls: 'text-[var(--color-brass)]' };
  if (src.startsWith('hipotese:')) return { label: `hipótese · ${src.split(':')[1]}`, cls: 'text-[var(--color-brass)]' };
  return { label: src, cls: 'text-[var(--text-secondary)]' };
}

const phaseAccentBg: Record<string, string> = {
  execution:   'icon-bg-emerald',
  improvement: 'icon-bg-brass',
  done:        'icon-bg-forest',
  plan:        'icon-bg-brass',
};

export function MissionCard({ mission, artifacts = [], reasoning = [], variant = 'full' }: MissionCardProps) {
  const isRunning = mission.status === 'running';
  const source = sourceMeta(mission.source);
  const accentBg = phaseAccentBg[mission.phase] ?? 'icon-bg-forest';

  return (
    <article className={cn(
      'glass rounded-2xl p-6 transition-all relative overflow-hidden animate-fade-in',
      isRunning && 'border-[var(--border-active)] glow-emerald reactor-ring',
      variant === 'compact' && 'p-5'
    )}>
      {isRunning && (
        <div className="absolute inset-x-0 top-0 h-[2px] shimmer" />
      )}

      <header className="flex items-start gap-4 mb-3">
        {/* Phase icon box — visual anchor */}
        <div className={cn('icon-box', accentBg)} style={{ width: 44, height: 44 }}>
          {mission.phase === 'execution' && <Sparkles className="h-5 w-5 relative z-[1]" strokeWidth={2} />}
          {mission.phase === 'improvement' && <FlaskConical className="h-5 w-5 relative z-[1]" strokeWidth={2} />}
          {mission.phase === 'done' && <ListChecks className="h-5 w-5 relative z-[1]" strokeWidth={2} />}
          {mission.phase === 'plan' && <Brain className="h-5 w-5 relative z-[1]" strokeWidth={2} />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <StatusPill status={mission.status} />
            <PreviewBadge state={mission.vercel_deployment_state} url={mission.preview_url} />
            {source && (
              <span className={cn('font-mono text-[10px] font-semibold uppercase tracking-[0.18em]', source.cls)}>
                · {source.label}
              </span>
            )}
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {mission.started_at
                ? `iniciada ${formatRelativeDate(mission.started_at)}`
                : `criada ${formatRelativeDate(mission.created_at)}`}
            </span>
          </div>

          <h3 className="font-display text-[1.5rem] font-semibold leading-[1.2] text-[var(--text-primary)]">
            {mission.name}
          </h3>
          {mission.description && (
            <p className="mt-2 text-[14px] font-medium text-[var(--text-secondary)] leading-[1.6]">
              {mission.description}
            </p>
          )}
        </div>

        <div className="flex-shrink-0">
          {mission.progress > 0 && mission.status === 'running' && (
            <div className="relative h-12 w-12">
              <svg className="h-12 w-12 -rotate-90" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="rgba(168, 196, 184, 0.16)" strokeWidth="2.5" />
                <circle
                  cx="18" cy="18" r="15.5" fill="none"
                  stroke="var(--color-brass)" strokeWidth="2.5" strokeLinecap="round"
                  strokeDasharray={`${mission.progress * 97.4} 97.4`}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-[var(--color-brass)]">
                {Math.round(mission.progress * 100)}
              </span>
            </div>
          )}
        </div>
      </header>

      {artifacts.length > 0 && (
        <div className="mt-5 pt-5 border-t border-[var(--border-divider)]">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)] mb-3 flex items-center gap-2">
            <ListChecks className="h-3 w-3" /> Artefatos · {artifacts.length}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {artifacts.map((a) => (
              <ArtifactRow key={a.id} artifact={a} />
            ))}
          </div>
        </div>
      )}

      <MissionLiveReasoning
        missionId={mission.id}
        initialSteps={reasoning}
        initialStatus={mission.status}
      />
    </article>
  );
}

const kindIcons: Record<string, typeof GitPullRequest> = {
  pr:         GitPullRequest,
  deploy:     Rocket,
  doc:        FileText,
  experiment: FlaskConical,
  analysis:   Sparkles,
};

const kindAccent: Record<string, 'brass' | 'emerald' | 'forest' | 'ember'> = {
  pr:         'brass',
  deploy:     'emerald',
  doc:        'forest',
  experiment: 'brass',
  analysis:   'emerald',
};

function ArtifactRow({ artifact }: { artifact: Artifact }) {
  const Icon = kindIcons[artifact.kind] ?? FileText;
  const accent = kindAccent[artifact.kind] ?? 'forest';
  const meta = artifact.meta as { winner?: boolean; leading?: boolean };
  const highlight = meta?.winner || meta?.leading;

  const content = (
    <div className={cn(
      'flex items-start gap-3 px-3 py-2.5 rounded-xl border transition-all',
      highlight
        ? 'bg-[var(--color-emerald)]/18 border-[var(--border-active)]'
        : 'bg-[var(--surface-icon)] border-[var(--border-divider)] hover:border-[var(--border-1)]'
    )}>
      <div className={cn('icon-box', `icon-bg-${accent}`)} style={{ width: 30, height: 30, borderRadius: 8 }}>
        <Icon className="h-3.5 w-3.5 relative z-[1]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)] leading-snug truncate">
          {artifact.label}
        </div>
        <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)] mt-0.5">
          {artifact.kind}
          {highlight && (
            <span className="text-[var(--color-brass)]"> · {meta.winner ? 'winner' : 'líder'}</span>
          )}
        </div>
      </div>
    </div>
  );

  return artifact.url ? (
    <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="block">
      {content}
    </a>
  ) : content;
}

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

function ReasoningRow({ step }: { step: ReasoningStep }) {
  const Icon = roleIcons[step.role];
  const accent = roleAccent[step.role];
  return (
    <li className="flex items-start gap-3">
      <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)] pt-2 w-6 flex-shrink-0">
        {String(step.step).padStart(2, '0')}
      </span>
      <div className={cn('icon-box mt-0.5', `icon-bg-${accent}`)} style={{ width: 26, height: 26, borderRadius: 7 }}>
        <Icon className="h-3 w-3 relative z-[1]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] mb-0.5">
          {step.role}
        </div>
        <p className="text-[13.5px] font-medium text-[var(--text-primary)] leading-[1.6]">
          {step.text}
        </p>
      </div>
    </li>
  );
}
