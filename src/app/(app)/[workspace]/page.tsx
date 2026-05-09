import { createClient } from '@/lib/supabase/server';
import { MissionCard } from '@/components/mission-card';
import { HeroInput } from '@/components/hero-input';
import { PlanMission } from '@/components/plan-mission';
import { DevTeamSubNav } from '@/components/dev-team-subnav';
import { PlanAgentCard } from '@/components/plan-agent-card';
import { AutoRefresh } from '@/components/auto-refresh';
import { PLAN_AGENTS, PLAN_CATEGORIES, type PlanAgent } from '@/lib/plan-agents';
import { Sparkles, FlaskConical, History, Activity, Layers } from 'lucide-react';
import type { Workspace, Mission, Artifact, ReasoningStep } from '@/lib/types';

interface PageProps {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ tab?: string }>;
}

type Tab = 'command' | 'plan' | 'execution' | 'improvement' | 'history';

const SUGGESTIONS_BY_SLUG: Record<string, string[]> = {
  knexo: [
    'Lançar onboarding gamificado em 3 etapas',
    'Análise de concorrente: Mint, Monarch, Copilot',
    'Roadmap Family v2 (compartilhamento + mesada)',
  ],
  conciera: [
    'Tese de pricing por especialidade médica',
    'Reduzir setup mágico de 14s para 8s',
    'Hipótese: tom direto vs acolhedor (A/B)',
  ],
  lovedopa: [
    'Critério de M&A pharma — quando aceitar?',
    'Validar Tribo (comunidade) antes de codar',
    'OCR de receita: pilot com 8 pacientes',
  ],
  veridian: [
    'Tese do Manager Core (Q3 2026)',
    'Pricing tiers do Veridian OS Licensing',
    'Strategy Q3: 10-20 SME clients FL',
  ],
};

export default async function WorkspacePage({ params, searchParams }: PageProps) {
  const { workspace: slug } = await params;
  const { tab: tabParam } = await searchParams;
  const tab: Tab = (['plan', 'execution', 'improvement', 'history'].includes(tabParam ?? '')
    ? tabParam
    : 'command') as Tab;

  const supabase = await createClient();

  const { data: workspace } = await supabase
    .from('fabric_core_workspaces')
    .select('*')
    .eq('slug', slug)
    .single<Workspace>();

  if (!workspace) return null;

  const { data: missions } = await supabase
    .from('fabric_squad_missions')
    .select('*')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false });

  const allMissions = (missions ?? []) as Mission[];

  const counts = {
    plan:        allMissions.filter((m) => m.phase === 'plan').length,
    execution:   allMissions.filter((m) => m.phase === 'execution').length,
    improvement: allMissions.filter((m) => m.phase === 'improvement').length,
    done:        allMissions.filter((m) => m.phase === 'done').length,
  };

  // ── COMMAND CENTER ───────────────────────────────────────────
  if (tab === 'command') {
    const recent = allMissions.slice(0, 5);
    const ids = recent.map((m) => m.id);
    const [{ data: artifacts }, { data: reasoning }] = await Promise.all([
      ids.length
        ? supabase.from('fabric_squad_artifacts').select('*').in('mission_id', ids)
        : Promise.resolve({ data: [] }),
      ids.length
        ? supabase.from('fabric_squad_reasoning').select('*').in('mission_id', ids).order('step')
        : Promise.resolve({ data: [] }),
    ]);

    const aMap = new Map<string, Artifact[]>();
    ((artifacts ?? []) as Artifact[]).forEach((a) => {
      if (!aMap.has(a.mission_id)) aMap.set(a.mission_id, []);
      aMap.get(a.mission_id)!.push(a);
    });
    const rMap = new Map<string, ReasoningStep[]>();
    ((reasoning ?? []) as ReasoningStep[]).forEach((r) => {
      if (!rMap.has(r.mission_id)) rMap.set(r.mission_id, []);
      rMap.get(r.mission_id)!.push(r);
    });

    return (
      <>
        <HeroInput
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          workspaceName={workspace.name}
          suggestions={SUGGESTIONS_BY_SLUG[slug] ?? []}
        />

        {tab !== 'command' && <DevTeamSubNav slug={slug} active={tab} counts={counts} />}

        <AutoRefresh enabled={recent.some((m) => m.status === 'running')} intervalMs={15000} />

        <section className="space-y-5">
          <header className="mb-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
              Stream
            </span>
            <h2 className="mt-1 font-display text-[1.5rem] font-semibold text-[var(--text-primary)] leading-tight">
              Movimentações recentes
            </h2>
          </header>

          {recent.length === 0 ? (
            <div className="glass rounded-xl p-12 text-center">
              <p className="font-display text-lg font-semibold text-[var(--text-primary)] mb-1">Workspace silencioso</p>
              <p className="text-sm font-medium text-[var(--text-secondary)]">Use o input acima ou ative os agentes do Plan Squad.</p>
            </div>
          ) : (
            recent.map((m) =>
              m.phase === 'plan' ? (
                <div key={m.id} className="stagger-item"><PlanMission mission={m} workspaceSlug={slug} /></div>
              ) : (
                <div key={m.id} className="stagger-item"><MissionCard mission={m} artifacts={aMap.get(m.id) ?? []} reasoning={rMap.get(m.id) ?? []} /></div>
              )
            )
          )}
        </section>
      </>
    );
  }

  // ── PLAN SQUAD ───────────────────────────────────────────────
  if (tab === 'plan') {
    const planMissions = allMissions.filter((m) => m.phase === 'plan');
    const grouped = (Object.keys(PLAN_CATEGORIES) as Array<keyof typeof PLAN_CATEGORIES>)
      .map((cat) => ({
        cat,
        meta: PLAN_CATEGORIES[cat],
        agents: PLAN_AGENTS.filter((a) => a.category === cat),
      }));

    return (
      <>
        <header className="mb-10 animate-fade-in">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--color-brass)]">
            Plan Squad · {planMissions.length} missions · {PLAN_AGENTS.length} agentes
          </span>
          <h1 className="mt-2 font-display text-[2.4rem] font-semibold text-[var(--text-primary)] leading-tight tracking-[-0.01em]">
            Forjar antes de executar
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] font-medium text-[var(--text-secondary)] leading-[1.65] border-l-2 border-[var(--color-emerald)] pl-4">
            Agentes transformam ideias, pesquisas e requisitos em premissas, hipóteses e roadmap.
            Missões geradas alimentam diretamente o Execution Squad.
          </p>
        </header>

        <AutoRefresh enabled={planMissions.some((m) => m.status === 'running')} intervalMs={12000} />

        {planMissions.length > 0 && (
          <section className="mb-14">
            <div className="flex items-center gap-2 mb-5">
              <Layers className="h-4 w-4 text-[var(--color-brass)]" />
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
                Plano · missões geradas
              </span>
              <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">· {planMissions.length}</span>
            </div>
            <div className="space-y-4">
              {planMissions.slice(0, 50).map((m) => (
                <div key={m.id} className="stagger-item"><PlanMission mission={m} workspaceSlug={slug} /></div>
              ))}
              {planMissions.length > 50 && (
                <p className="text-center text-xs font-medium text-[var(--text-muted)] pt-3">
                  Mostrando 50 de {planMissions.length}.
                </p>
              )}
            </div>
          </section>
        )}

        <details className="mt-10 pt-10 border-t border-[var(--border-1)] group" open={planMissions.length === 0}>
          <summary className="flex items-center gap-3 cursor-pointer list-none mb-6">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
              Disparar agente manualmente
            </span>
            <span className="font-mono text-[10px] font-semibold text-[var(--text-muted)]">· {PLAN_AGENTS.length} agentes</span>
            <span className="ml-auto text-[var(--text-muted)] text-xs font-medium group-open:hidden">expandir →</span>
            <span className="ml-auto text-[var(--text-muted)] text-xs font-medium hidden group-open:inline">recolher ↑</span>
          </summary>

          <div className="space-y-12">
            {grouped.map(({ cat, meta, agents }) => (
              <section key={cat}>
                <div className="flex items-baseline justify-between mb-5 gap-6">
                  <div>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">
                      {cat}
                    </span>
                    <h2 className="mt-1 font-display text-[1.4rem] font-semibold text-[var(--text-primary)] leading-tight">
                      {meta.label}
                    </h2>
                  </div>
                  <p className="hidden md:block text-[13px] font-medium text-[var(--text-secondary)] max-w-sm text-right">
                    {meta.description}
                  </p>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {agents.map((a: PlanAgent) => (
                    <div key={a.id} className="stagger-item"><PlanAgentCard agent={a} /></div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </details>
      </>
    );
  }

  // ── EXECUTION / IMPROVEMENT / HISTORY ────────────────────────
  const phase = tab === 'history' ? 'done' : tab;
  const filtered = tab === 'execution'
    ? allMissions.filter((m) => m.phase === 'execution' || m.status === 'running')
    : allMissions.filter((m) => m.phase === phase);
  const ids = filtered.map((m) => m.id);

  const [{ data: artifacts }, { data: reasoning }] = await Promise.all([
    ids.length
      ? supabase.from('fabric_squad_artifacts').select('*').in('mission_id', ids).order('created_at')
      : Promise.resolve({ data: [] }),
    ids.length
      ? supabase.from('fabric_squad_reasoning').select('*').in('mission_id', ids).order('step')
      : Promise.resolve({ data: [] }),
  ]);

  const aMap = new Map<string, Artifact[]>();
  ((artifacts ?? []) as Artifact[]).forEach((a) => {
    if (!aMap.has(a.mission_id)) aMap.set(a.mission_id, []);
    aMap.get(a.mission_id)!.push(a);
  });
  const rMap = new Map<string, ReasoningStep[]>();
  ((reasoning ?? []) as ReasoningStep[]).forEach((r) => {
    if (!rMap.has(r.mission_id)) rMap.set(r.mission_id, []);
    rMap.get(r.mission_id)!.push(r);
  });

  const titles: Record<string, { eyebrow: string; title: string; sub: string }> = {
    execution: {
      eyebrow: 'Execution Squad · ativa agora',
      title: 'O que está rodando',
      sub: 'Missões em andamento. Cada uma tem PR aberto, deploy preview e raciocínio em tempo real.',
    },
    improvement: {
      eyebrow: 'Improvement Squad · loops ativos',
      title: 'O que está sendo otimizado',
      sub: 'A/B tests, post-mortem e refinamentos contínuos. Output volta como decisão pra Plan.',
    },
    history: {
      eyebrow: 'History · auditoria',
      title: 'Missões concluídas',
      sub: 'Tudo que rodou e finalizou. Read-only, com artefatos finais e estatísticas agregadas.',
    },
  };
  const t = titles[tab];

  return (
    <>
      <header className="mb-10 animate-fade-in">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--color-brass)]">
          {t.eyebrow}
        </span>
        <h1 className="mt-2 font-display text-[2.4rem] font-semibold text-[var(--text-primary)] leading-tight tracking-[-0.01em]">
          {t.title}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] font-medium text-[var(--text-secondary)] leading-[1.65] border-l-2 border-[var(--color-emerald)] pl-4">
          {t.sub}
        </p>
      </header>

      <AutoRefresh enabled={tab === 'execution' && filtered.some((m) => m.status === 'running')} intervalMs={12000} />

      {tab === 'history' && filtered.length > 0 && (() => {
        const total = filtered.length;
        const succeeded = filtered.filter((m) => m.status === 'succeeded').length;
        const failed = filtered.filter((m) => m.status === 'failed').length;
        const totalReasoning = (reasoning ?? []).length;
        const totalArtifacts = (artifacts ?? []).length;
        const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;
        const avgDurationMs = filtered
          .filter((m) => m.completed_at && m.started_at)
          .reduce((acc, m, _, arr) => acc + (new Date(m.completed_at!).getTime() - new Date(m.started_at!).getTime()) / arr.length, 0);
        const avgDurationStr = avgDurationMs < 60_000 ? `${Math.round(avgDurationMs/1000)}s` : `${Math.round(avgDurationMs/60_000)}min`;
        const byAgent = filtered.reduce((acc, m) => {
          const a = m.source?.replace('agent:', '') ?? 'manual';
          acc[a] = (acc[a] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>);
        const topAgents = Object.entries(byAgent).sort(([,a],[,b]) => b - a).slice(0, 3);
        return (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-10">
            <div className="glass rounded-xl p-4">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block">Total missions</span>
              <span className="count-shine font-display text-[2rem] font-semibold leading-none mt-2 block tracking-[-0.02em]">{total}</span>
            </div>
            <div className="glass rounded-xl p-4">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block">% sucesso</span>
              <span className="font-display text-[2rem] font-semibold leading-none mt-2 block text-[var(--color-emerald-glow)] tracking-[-0.02em]">{successRate}%</span>
              <span className="text-xs font-medium text-[var(--text-muted)] mt-1 block">{succeeded}✓ {failed > 0 ? `· ${failed}✗` : ''}</span>
            </div>
            <div className="glass rounded-xl p-4">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block">Reasoning steps</span>
              <span className="font-display text-[2rem] font-semibold leading-none mt-2 block tracking-[-0.02em]">{totalReasoning}</span>
            </div>
            <div className="glass rounded-xl p-4">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block">Artifacts</span>
              <span className="font-display text-[2rem] font-semibold leading-none mt-2 block tracking-[-0.02em]">{totalArtifacts}</span>
            </div>
            <div className="glass rounded-xl p-4">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block">Duração média</span>
              <span className="font-display text-[2rem] font-semibold leading-none mt-2 block tracking-[-0.02em]">{avgDurationStr}</span>
            </div>
            {topAgents.length > 0 && (
              <div className="glass rounded-xl p-4 col-span-2 md:col-span-5">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)] block mb-2">Top agentes</span>
                <div className="flex items-center gap-3 flex-wrap">
                  {topAgents.map(([a, n]) => (
                    <span key={a} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[var(--surface-icon)] border border-[var(--border-1)]">
                      <span className="font-mono text-[11px] font-semibold text-[var(--text-primary)]">{a}</span>
                      <span className="font-mono text-[10px] font-semibold text-[var(--color-brass)]">×{n}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })()}

      <section className="space-y-5">
        {filtered.length === 0 ? (
          <div className="glass rounded-xl p-12 text-center">
            <p className="font-display text-lg font-semibold text-[var(--text-primary)] mb-1">
              {tab === 'execution' ? 'Nada rodando agora' : tab === 'improvement' ? 'Sem experimentos ativos' : 'Histórico vazio'}
            </p>
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              {tab === 'execution'
                ? 'Promova uma missão do Plan para começar.'
                : tab === 'improvement'
                  ? 'A/B tests aparecem aqui após missões concluídas.'
                  : 'Missões concluídas aparecem aqui com seus artefatos finais.'}
            </p>
          </div>
        ) : (
          filtered.map((m) => (
            <div key={m.id} className="stagger-item"><MissionCard mission={m} artifacts={aMap.get(m.id) ?? []} reasoning={rMap.get(m.id) ?? []} /></div>
          ))
        )}
      </section>
    </>
  );
}

function PhaseCounter({
  href, icon, label, count, pulse, accent = 'brass',
}: { href: string; icon: React.ReactNode; label: string; count: number; pulse?: boolean; accent?: 'brass' | 'emerald' | 'forest' | 'ember' }) {
  const accentVar = {
    brass:   'var(--color-brass)',
    emerald: 'var(--color-emerald-glow)',
    forest:  'var(--color-celadon)',
    ember:   'var(--color-ember-soft)',
  }[accent];
  return (
    <a
      href={href}
      className="counter-card glass rounded-2xl p-5 transition-all hover:translate-y-[-2px] group"
      style={{ ['--accent-color' as string]: accentVar }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`icon-box icon-bg-${accent}`} style={{ width: 32, height: 32, borderRadius: 9 }}>
          <span className="relative z-[1] flex items-center justify-center">{icon}</span>
        </div>
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.26em] text-[var(--text-secondary)]">
          {label}
        </span>
        {pulse && (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brass)] pulse-dot ml-auto" />
        )}
      </div>
      <div className="count-shine font-display text-[2.4rem] font-semibold leading-none tracking-[-0.02em]">
        {count}
      </div>
    </a>
  );
}
