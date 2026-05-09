'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Cpu, Loader2, Clock, Play, X, Save } from 'lucide-react';
import { Eyebrow } from './eyebrow';
import {
  toggleAutodev,
  setAutodevSchedule,
  runAutodevForMinutes,
  cancelAutodevManual,
} from '@/app/(app)/[workspace]/settings/actions';
import type { Workspace } from '@/lib/types';
import { cn } from '@/lib/utils';

const QUICK_DURATIONS = [
  { label: '15min', minutes: 15 },
  { label: '30min', minutes: 30 },
  { label: '1h',    minutes: 60 },
  { label: '2h',    minutes: 120 },
  { label: '4h',    minutes: 240 },
];

function formatRemaining(untilIso: string): string | null {
  const until = new Date(untilIso).getTime();
  const now = Date.now();
  if (until <= now) return null;
  const diff = until - now;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}min`;
}

export function AutodevToggle({
  workspace,
  canEdit,
}: { workspace: Workspace; canEdit: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(workspace.autodev_enabled);
  const [startHour, setStartHour] = useState(workspace.autodev_start_hour ?? 21);
  const [stopHour, setStopHour] = useState(workspace.autodev_stop_hour ?? 6);
  const [manualUntil, setManualUntil] = useState<string | null>(workspace.autodev_manual_until);
  const [remainingLabel, setRemainingLabel] = useState<string | null>(
    workspace.autodev_manual_until ? formatRemaining(workspace.autodev_manual_until) : null
  );
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');

  // Atualiza countdown a cada 30s
  useEffect(() => {
    if (!manualUntil) { setRemainingLabel(null); return; }
    const update = () => {
      const r = formatRemaining(manualUntil);
      setRemainingLabel(r);
      if (!r) setManualUntil(null);
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [manualUntil]);

  function flipToggle() {
    if (!canEdit) return;
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      await toggleAutodev({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        enabled: next,
      });
      router.refresh();
    });
  }

  function saveSchedule() {
    if (!canEdit) return;
    setError('');
    startTransition(async () => {
      const r = await setAutodevSchedule({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        startHour,
        stopHour,
      });
      if (r.error) setError(r.error);
      router.refresh();
    });
  }

  function startManual(minutes: number) {
    if (!canEdit) return;
    setError('');
    startTransition(async () => {
      const r = await runAutodevForMinutes({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        minutes,
      });
      if (r.error) setError(r.error);
      else if (r.until) {
        setManualUntil(r.until);
        setEnabled(true);
      }
      router.refresh();
    });
  }

  function cancelManual() {
    if (!canEdit) return;
    startTransition(async () => {
      await cancelAutodevManual({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
      });
      setManualUntil(null);
      router.refresh();
    });
  }

  const scheduleDirty =
    startHour !== (workspace.autodev_start_hour ?? 21) ||
    stopHour !== (workspace.autodev_stop_hour ?? 6);

  return (
    <div className="glass rounded-2xl p-6 space-y-6">
      {/* Linha 1: header + toggle global */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div
            className={cn(
              'icon-box flex-shrink-0',
              enabled ? 'icon-bg-emerald reactor-ring' : 'icon-bg-forest'
            )}
            style={{ width: 44, height: 44 }}
          >
            <Cpu className="h-5 w-5 relative z-[1]" strokeWidth={2} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display text-[1.15rem] font-semibold text-[var(--text-primary)] leading-tight">
                AutoDev
              </h3>
              {enabled && (
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--color-aurora-bright)]">
                  · ATIVO
                </span>
              )}
              {remainingLabel && (
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-[var(--color-brass-light)] px-2 py-0.5 bg-[var(--color-brass)]/15 rounded">
                  RUN MANUAL · {remainingLabel}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-[13px] font-medium text-[var(--text-secondary)] leading-[1.55]">
              Quando ligado, o orquestrador escolhe agentes do Plan Squad e dispara missões autonomamente
              durante a janela configurada abaixo.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={flipToggle}
          disabled={!canEdit || isPending}
          aria-pressed={enabled}
          aria-label={enabled ? 'Desligar AutoDev' : 'Ligar AutoDev'}
          className={cn(
            'relative h-7 w-12 rounded-full flex-shrink-0 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
            enabled
              ? 'bg-[var(--color-emerald)]'
              : 'bg-[var(--surface-icon)] border border-[var(--border-1)]'
          )}
        >
          <span
            className={cn(
              'absolute top-1 left-1 h-5 w-5 rounded-full transition-transform shadow-sm',
              enabled
                ? 'translate-x-5 bg-[var(--color-aurora-bright)]'
                : 'translate-x-0 bg-[var(--text-muted)]'
            )}
          />
        </button>
      </div>

      {/* Linha 2: Schedule */}
      <div className="border-t border-[var(--border-divider)] pt-5">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          <Eyebrow>Janela diária (horário Campo Grande · UTC-4)</Eyebrow>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex-1 min-w-[120px]">
            <label htmlFor="start-hour" className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)] block mb-1">
              Inicia às
            </label>
            <select
              id="start-hour"
              value={startHour}
              onChange={(e) => setStartHour(parseInt(e.target.value, 10))}
              disabled={!canEdit || isPending}
              className="w-full h-10 px-3 bg-[var(--surface-icon)] border border-[var(--border-1)] rounded-lg text-[14px] font-medium text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-active)]"
            >
              {Array.from({length: 24}, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>
              ))}
            </select>
          </div>
          <span className="text-[var(--text-muted)] pb-2.5">→</span>
          <div className="flex-1 min-w-[120px]">
            <label htmlFor="stop-hour" className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)] block mb-1">
              Para às
            </label>
            <select
              id="stop-hour"
              value={stopHour}
              onChange={(e) => setStopHour(parseInt(e.target.value, 10))}
              disabled={!canEdit || isPending}
              className="w-full h-10 px-3 bg-[var(--surface-icon)] border border-[var(--border-1)] rounded-lg text-[14px] font-medium text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-active)]"
            >
              {Array.from({length: 24}, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>
              ))}
            </select>
          </div>
          {scheduleDirty && (
            <button
              type="button"
              onClick={saveSchedule}
              disabled={!canEdit || isPending}
              className="btn-brass inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[12px] font-mono font-semibold uppercase tracking-[0.18em]"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" strokeWidth={2.5} />}
              Salvar
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] font-medium text-[var(--text-muted)]">
          {startHour < stopHour
            ? `Roda das ${String(startHour).padStart(2,'0')}:00 às ${String(stopHour).padStart(2,'0')}:00 (mesma data)`
            : `Roda das ${String(startHour).padStart(2,'0')}:00 (até virar o dia) às ${String(stopHour).padStart(2,'0')}:00`}
        </p>
      </div>

      {/* Linha 3: Manual run */}
      <div className="border-t border-[var(--border-divider)] pt-5">
        <div className="flex items-center gap-2 mb-3">
          <Play className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
          <Eyebrow>Run manual · ignora schedule</Eyebrow>
        </div>
        {remainingLabel ? (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-[var(--color-brass)]/10 border border-[var(--color-brass)]/30">
            <div>
              <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                Run manual ativo · termina em {remainingLabel}
              </p>
              <p className="text-[11px] font-medium text-[var(--text-muted)] mt-0.5">
                até {manualUntil ? new Date(manualUntil).toLocaleString('pt-BR', { timeZone: 'America/Campo_Grande' }) : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={cancelManual}
              disabled={!canEdit || isPending}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[11px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--color-ember-soft)] hover:bg-[var(--color-ember)]/15 transition-colors"
            >
              <X className="h-3 w-3" />
              Cancelar
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {QUICK_DURATIONS.map(({ label, minutes }) => (
              <button
                key={label}
                type="button"
                onClick={() => startManual(minutes)}
                disabled={!canEdit || isPending}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--text-primary)] border border-[var(--border-1)] hover:border-[var(--color-brass)] hover:bg-[var(--color-brass)]/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="h-3 w-3" strokeWidth={2.5} />
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="text-[12px] font-medium text-[var(--color-ember-soft)]">{error}</p>
      )}

      {!canEdit && (
        <p className="text-xs font-medium text-[var(--text-muted)]">
          Apenas o owner pode mudar essas configurações.
        </p>
      )}
    </div>
  );
}
