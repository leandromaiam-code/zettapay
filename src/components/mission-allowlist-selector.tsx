'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  Code2,
  Megaphone,
  TrendingUp,
  Cog,
  Loader2,
  Save,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { Eyebrow } from './eyebrow';
import { setAllowedMissionSquads } from '@/app/(app)/[workspace]/settings/mission-allowlist-actions';
import { ALL_SQUADS, type Squad, type Workspace } from '@/lib/types';
import { cn } from '@/lib/utils';

type SquadDef = {
  id: Squad;
  label: string;
  caption: string;
  description: string;
  icon: typeof Code2;
  iconBg: string;
};

const SQUADS: readonly SquadDef[] = [
  {
    id: 'dev',
    label: 'Dev',
    caption: 'Engineering',
    description: 'Roadmap canonical, refactors, infra. Padrao para toda venture.',
    icon: Code2,
    iconBg: 'icon-bg-emerald',
  },
  {
    id: 'marketing',
    label: 'Marketing',
    caption: 'Growth & brand',
    description: 'Campanhas, narrativa de marca, conteudo. Ainda em maturacao.',
    icon: Megaphone,
    iconBg: 'icon-bg-brass',
  },
  {
    id: 'sales',
    label: 'Sales',
    caption: 'Receita',
    description: 'Pipeline, outbound, expansion. Toca dados sensiveis de cliente.',
    icon: TrendingUp,
    iconBg: 'icon-bg-brass',
  },
  {
    id: 'ops',
    label: 'Ops',
    caption: 'Operacao',
    description: 'Infra, custo, observabilidade. Phase risk: high.',
    icon: Cog,
    iconBg: 'icon-bg-forest',
  },
] as const;

function sortedKey(squads: Squad[]): string {
  return ALL_SQUADS.filter((s) => squads.includes(s)).join(',');
}

export function MissionAllowlistSelector({
  workspace,
  canEdit,
}: {
  workspace: Workspace;
  canEdit: boolean;
}) {
  const router = useRouter();
  const initial = useMemo<Squad[]>(
    () =>
      workspace.allowed_mission_squads && workspace.allowed_mission_squads.length > 0
        ? ([...workspace.allowed_mission_squads] as Squad[])
        : ([...ALL_SQUADS] as Squad[]),
    [workspace.allowed_mission_squads]
  );

  const [selected, setSelected] = useState<Squad[]>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string>('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const dirty = sortedKey(selected) !== sortedKey(initial);
  const tooFew = selected.length === 0;
  const restricted = selected.length < ALL_SQUADS.length;

  function toggle(id: Squad) {
    if (!canEdit || isPending) return;
    setSavedAt(null);
    setError('');
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  }

  function save() {
    if (!canEdit || !dirty || tooFew) return;
    setError('');
    startTransition(async () => {
      const r = await setAllowedMissionSquads({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        squads: selected,
      });
      if (r.error) {
        setError(r.error);
        return;
      }
      setSavedAt(new Date().toISOString());
      router.refresh();
    });
  }

  return (
    <div className="glass rounded-2xl p-6 space-y-6">
      <div className="flex items-start gap-4">
        <div
          className={cn('icon-box flex-shrink-0', restricted ? 'icon-bg-brass' : 'icon-bg-emerald')}
          style={{ width: 44, height: 44 }}
          aria-hidden
        >
          <ShieldCheck className="h-5 w-5 relative z-[1]" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display text-[1.15rem] font-semibold text-[var(--text-primary)] leading-tight">
              Mission Type Allowlist
            </h3>
            {restricted ? (
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--color-brass-light)] px-2 py-0.5 bg-[var(--color-brass)]/15 rounded">
                · LOCK {selected.length}/{ALL_SQUADS.length}
              </span>
            ) : (
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--color-aurora-bright)]">
                · TODOS
              </span>
            )}
          </div>
          <p className="mt-1.5 text-[13px] font-medium text-[var(--text-secondary)] leading-[1.55]">
            Quais squads podem rodar missoes neste workspace. AutoDev e execucao manual
            so disparam tipos marcados aqui — gate aplicado tanto na UI quanto no
            despacho do fabric-api.
          </p>
        </div>
      </div>

      <div className="border-t border-[var(--border-divider)] pt-4">
        <Eyebrow className="mb-3 block">Squads · marque os permitidos</Eyebrow>
        <ul className="space-y-2" role="group" aria-label="Tipos de missao permitidos">
          {SQUADS.map((squad) => {
            const checked = selected.includes(squad.id);
            const disabled = !canEdit || isPending;
            const Icon = squad.icon;
            return (
              <li key={squad.id}>
                <button
                  type="button"
                  onClick={() => toggle(squad.id)}
                  disabled={disabled}
                  role="switch"
                  aria-checked={checked}
                  aria-label={`${checked ? 'Remover' : 'Permitir'} squad ${squad.label}`}
                  className={cn(
                    'group w-full text-left flex items-start gap-3 px-3.5 py-3 rounded-xl border transition-all',
                    'focus:outline-none focus-visible:border-[var(--border-active)]',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    checked
                      ? 'border-[var(--border-2)] bg-[var(--color-brass)]/8 hover:bg-[var(--color-brass)]/12'
                      : 'border-[var(--border-divider)] bg-[var(--surface-icon)] hover:border-[var(--border-1)]'
                  )}
                >
                  <div
                    className={cn(
                      'icon-box flex-shrink-0 transition-opacity',
                      squad.iconBg,
                      !checked && 'opacity-55'
                    )}
                    style={{ width: 36, height: 36 }}
                    aria-hidden
                  >
                    <Icon className="h-4 w-4 relative z-[1]" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display text-[15px] font-semibold text-[var(--text-primary)] leading-tight">
                        {squad.label}
                      </span>
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
                        · {squad.caption}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] font-medium text-[var(--text-secondary)] leading-[1.5]">
                      {squad.description}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'mt-0.5 h-5 w-5 rounded-md border-2 flex-shrink-0 grid place-items-center transition-all',
                      checked
                        ? 'border-[var(--color-brass)] bg-[var(--color-brass)]'
                        : 'border-[var(--border-1)] bg-transparent group-hover:border-[var(--border-2)]'
                    )}
                    aria-hidden
                  >
                    {checked && (
                      <Check
                        className="h-3 w-3 text-[var(--color-forest-deep)]"
                        strokeWidth={3.2}
                      />
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {tooFew && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--color-ember)]/40 bg-[var(--color-ember)]/12 px-3 py-2.5">
          <AlertTriangle
            className="h-3.5 w-3.5 mt-0.5 text-[var(--color-ember-soft)] flex-shrink-0"
            strokeWidth={2.5}
          />
          <p className="text-[12px] font-medium text-[var(--color-ember-soft)] leading-[1.5]">
            Pelo menos um squad precisa permanecer permitido. Selecione ao menos uma opcao.
          </p>
        </div>
      )}

      {error && !tooFew && (
        <p className="text-[12px] font-medium text-[var(--color-ember-soft)]">{error}</p>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {canEdit ? (
          <button
            type="button"
            onClick={save}
            disabled={!dirty || tooFew || isPending}
            className="btn-brass inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[12px] font-mono font-semibold uppercase tracking-[0.18em] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : savedAt ? (
              <Check className="h-3.5 w-3.5" strokeWidth={2.8} />
            ) : (
              <Save className="h-3.5 w-3.5" strokeWidth={2.5} />
            )}
            {isPending ? 'Salvando…' : savedAt && !dirty ? 'Salvo' : 'Salvar'}
          </button>
        ) : (
          <p className="text-xs text-[var(--text-muted)] font-medium border-l-2 border-[var(--color-brass)] pl-3">
            Apenas o owner pode editar a allowlist.
          </p>
        )}

        {canEdit && !dirty && !restricted && (
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-muted)]">
            todos os squads ativos · workspace permissivo
          </span>
        )}
        {canEdit && !dirty && restricted && !tooFew && (
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-brass-light)]">
            allowlist ativa · {selected.length} de {ALL_SQUADS.length}
          </span>
        )}
      </div>
    </div>
  );
}
