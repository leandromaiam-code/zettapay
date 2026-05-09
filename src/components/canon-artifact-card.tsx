'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronRight, ExternalLink, Sparkles } from 'lucide-react';
import { formatRelativeDate, cn } from '@/lib/utils';
import type { Artifact, Mission } from '@/lib/types';

interface Props {
  artifact: Artifact;
  mission?: Mission;
  workspaceSlug: string;
}

export function CanonArtifactCard({ artifact, mission, workspaceSlug }: Props) {
  const [open, setOpen] = useState(false);
  const meta = (artifact.meta ?? {}) as Record<string, unknown>;
  const title = (meta.title as string) || artifact.label;
  const phases = meta.phases as Array<Record<string, unknown>> | undefined;
  const items = (meta.hipoteses || meta.experiments || meta.risks || meta.competitors || meta.jtbd || meta.diff) as Array<Record<string, unknown>> | undefined;

  return (
    <article className={cn('glass rounded-2xl p-5 transition-all', open && 'ring-1 ring-[var(--border-active)]')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start justify-between gap-4 text-left"
      >
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-[1.2rem] font-semibold text-[var(--text-primary)] leading-tight">
            {title}
          </h3>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {formatRelativeDate(artifact.created_at)}
            </span>
            {mission && (
              <Link
                href={`/${workspaceSlug}?tab=plan`}
                className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-brass-deep)] hover:text-[var(--color-brass)] inline-flex items-center gap-1"
              >
                <Sparkles className="h-3 w-3" />
                {mission.source?.replace('agent:', '') ?? 'manual'}
              </Link>
            )}
            {phases && (
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-emerald-glow)]">
                {phases.length} fases
              </span>
            )}
            {items && Array.isArray(items) && (
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-emerald-glow)]">
                {items.length} itens
              </span>
            )}
          </div>
        </div>
        <ChevronRight
          className={cn(
            'h-4 w-4 text-[var(--text-muted)] flex-shrink-0 mt-1.5 transition-transform',
            open && 'rotate-90'
          )}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="mt-5 pt-5 border-t border-[var(--border-divider)] animate-fade-in space-y-4">
          {/* Phases (roadmap) */}
          {phases && phases.length > 0 && (
            <div>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--color-brass)] block mb-3">
                Fases
              </span>
              <div className="space-y-3">
                {phases.map((p, i) => (
                  <div key={i} className="border-l-2 border-[var(--border-2)] pl-4">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-brass-deep)]">
                        {String(p.id ?? p.phase ?? '')}
                      </span>
                      <span className="font-display text-[1.05rem] font-semibold text-[var(--text-primary)]">
                        {String(p.name ?? '')}
                      </span>
                      {Boolean(p.horizon || p.effort) && (
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          {String(p.horizon ?? '')} {p.effort ? `· ${p.effort}` : ''}
                        </span>
                      )}
                    </div>
                    {Boolean(p.goal) && (
                      <p className="mt-1 text-[13px] font-medium text-[var(--text-secondary)] leading-relaxed">
                        {String(p.goal)}
                      </p>
                    )}
                    {Array.isArray(p.milestones) && (
                      <ul className="mt-2 space-y-1">
                        {(p.milestones as string[]).map((m, j) => (
                          <li key={j} className="text-[12.5px] font-medium text-[var(--text-primary)] flex items-start gap-2">
                            <span className="mt-1.5 h-1 w-1 rounded-full bg-[var(--color-brass)] flex-shrink-0" />
                            {m}
                          </li>
                        ))}
                      </ul>
                    )}
                    {Array.isArray(p.missions_recommended) && (p.missions_recommended as string[]).length > 0 && (
                      <details className="mt-2">
                        <summary className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--color-emerald-glow)] cursor-pointer">
                          {(p.missions_recommended as string[]).length} missions recomendadas
                        </summary>
                        <ul className="mt-2 space-y-1 ml-2">
                          {(p.missions_recommended as string[]).map((mr, k) => (
                            <li key={k} className="text-[12px] font-medium text-[var(--text-secondary)]">
                              · {mr}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Itens (hipóteses, experiments, riscos, competitors, jtbd, diff) */}
          {items && Array.isArray(items) && items.length > 0 && !phases && (
            <div className="space-y-3">
              {items.map((item, i) => (
                <div key={i} className="border-l-2 border-[var(--border-2)] pl-4">
                  <h4 className="font-display text-[1rem] font-semibold text-[var(--text-primary)]">
                    {String(item.title ?? item.text ?? item.risk ?? item.name ?? item.job ?? item.section ?? `Item ${i+1}`)}
                  </h4>
                  {Boolean(item.rationale || item.body || item.description || item.context) && (
                    <p className="mt-1 text-[13px] font-medium text-[var(--text-secondary)] leading-relaxed">
                      {String(item.rationale ?? item.body ?? item.description ?? item.context)}
                    </p>
                  )}
                  {Boolean(item.criteria || item.success_criteria || item.mitigation || item.outcome || item.method) && (
                    <p className="mt-1 text-[12.5px] font-medium text-[var(--color-aurora-bright)]">
                      {String(item.criteria ?? item.success_criteria ?? item.mitigation ?? item.outcome ?? item.method)}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-3 flex-wrap font-mono text-[10px] text-[var(--text-muted)]">
                    {Boolean(item.score) && <span>score {String(item.score)}</span>}
                    {Boolean(item.effort) && <span>· effort {String(item.effort)}</span>}
                    {Boolean(item.impact) && <span>· impact {String(item.impact)}</span>}
                    {Boolean(item.probability) && <span>· prob {String(item.probability)}</span>}
                    {Boolean(item.severity) && <span>· sev {String(item.severity)}</span>}
                    {Boolean(item.category) && <span>· {String(item.category)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Fit premissa / why now */}
          {Boolean(meta.fit_premissa || meta.white_space || meta.recommendation) && (
            <div className="glass-brass rounded-lg p-3">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--color-brass)] block mb-1">
                Insight
              </span>
              <p className="text-[13px] font-medium text-[var(--text-primary)] leading-relaxed">
                {String(meta.fit_premissa ?? meta.white_space ?? meta.recommendation)}
              </p>
            </div>
          )}

          {/* Raw JSON fallback */}
          <details className="border-t border-[var(--border-divider)] pt-4">
            <summary className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] cursor-pointer">
              JSON bruto
            </summary>
            <pre className="mt-3 font-mono text-[11px] text-[var(--text-secondary)] bg-[var(--surface-icon)] p-3 rounded overflow-x-auto whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
              {JSON.stringify(meta, null, 2)}
            </pre>
          </details>

          {artifact.url && (
            <a
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-emerald-glow)] hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Ver fonte externa
            </a>
          )}
        </div>
      )}
    </article>
  );
}
