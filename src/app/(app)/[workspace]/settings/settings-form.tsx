'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Check, Save } from 'lucide-react';
import { Eyebrow } from '@/components/eyebrow';
import { updateWorkspace } from './actions';
import type { Workspace } from '@/lib/types';

const PRESET_COLORS = ['#9B7F4E', '#C9A56B', '#E8C88A', '#2D5D4E', '#1E3B33'];

export function SettingsForm({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [color, setColor] = useState(workspace.brand_color);
  const [isPending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const dirty = name !== workspace.name || color !== workspace.brand_color;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || !dirty) return;
    startTransition(async () => {
      await updateWorkspace({
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        name,
        brand_color: color,
      });
      setSavedAt(new Date().toISOString());
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="block">
          <Eyebrow>Nome</Eyebrow>
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          className="mt-2 w-full bg-transparent border-b border-[var(--border-1)] focus:border-[var(--color-brass)] py-2 text-[15px] font-medium text-[var(--text-primary)] focus:outline-none transition-colors disabled:opacity-40"
        />
      </div>

      <div>
        <Eyebrow>Cor da marca</Eyebrow>
        <div className="mt-3 flex gap-3">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={!canEdit}
              onClick={() => setColor(c)}
              className={`h-10 w-10 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-2 ring-offset-[var(--color-forest-deep)] ring-[var(--color-brass)] scale-110' : 'opacity-70 hover:opacity-100'} disabled:opacity-30`}
              style={{ backgroundColor: c }}
              aria-label={`Selecionar ${c}`}
            />
          ))}
        </div>
      </div>

      <div>
        <Eyebrow>Slug · imutável</Eyebrow>
        <p className="mt-2 font-mono text-sm text-[var(--text-muted)] font-medium">{workspace.slug}</p>
      </div>

      {canEdit ? (
        <button
          type="submit"
          disabled={isPending || !dirty}
          className="btn-brass rounded-lg h-10 px-5 inline-flex items-center gap-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : savedAt ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {isPending ? 'Salvando…' : savedAt ? 'Salvo' : 'Salvar'}
        </button>
      ) : (
        <p className="text-xs text-[var(--text-muted)] font-medium border-l-2 border-[var(--color-brass)] pl-3">
          Somente o owner do workspace pode editar identidade.
        </p>
      )}
    </form>
  );
}
