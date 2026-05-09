'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight } from 'lucide-react';
import { createWorkspace } from './actions';

const PRESET_COLORS = ['#9B7F4E', '#C9A56B', '#E8C88A', '#2D5D4E', '#1E3B33'];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 32);
}

export function NewWorkspaceForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const result = await createWorkspace({ name, slug, brand_color: color });
      if (result.error) setError(result.error);
      else if (result.slug) router.push(`/${result.slug}`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div>
        <label htmlFor="name" className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          Nome do produto
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }}
          placeholder="ex. Knexo, LoveDopa, Conciera"
          required
          className="mt-2 w-full bg-transparent border-b border-[var(--border-1)] focus:border-[var(--color-brass)] py-2 text-[15px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
        />
      </div>

      <div>
        <label htmlFor="slug" className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          Slug · URL
        </label>
        <input
          id="slug"
          value={slug}
          onChange={(e) => setSlug(slugify(e.target.value))}
          placeholder="knexo"
          required
          pattern="[a-z0-9\-]+"
          className="mt-2 w-full bg-transparent border-b border-[var(--border-1)] focus:border-[var(--color-brass)] py-2 text-[15px] font-mono font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
        />
      </div>

      <div>
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          Cor da marca
        </span>
        <div className="mt-3 flex gap-3">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`h-10 w-10 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-2 ring-offset-[var(--color-forest-deep)] ring-[var(--color-brass)] scale-110' : 'opacity-70 hover:opacity-100'}`}
              style={{ backgroundColor: c }}
              aria-label={`Selecionar ${c}`}
            />
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm font-medium text-[#E89B8E] border-l-2 border-[#E89B8E] pl-3">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !name || !slug}
        className="btn-brass rounded-lg h-12 w-full inline-flex items-center justify-center gap-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : (
          <>
            Criar workspace <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
    </form>
  );
}
