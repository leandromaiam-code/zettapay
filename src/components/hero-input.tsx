'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Sparkles, ArrowRight, Loader2 } from 'lucide-react';
import { createMission } from '@/app/(app)/[workspace]/actions';
import { cn } from '@/lib/utils';

interface HeroInputProps {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  suggestions: string[];
}

export function HeroInput({ workspaceId, workspaceSlug, workspaceName, suggestions }: HeroInputProps) {
  const router = useRouter();
  const [value, setValue] = useState(''); const [showFlare, setShowFlare] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit(text: string) {
    if (!text.trim()) return;
    setShowFlare(true);
    setTimeout(() => setShowFlare(false), 900);
    startTransition(async () => {
      await createMission({
        workspaceId,
        workspaceSlug,
        name: text.trim(),
        source: 'human',
      });
      setValue('');
      router.refresh();
    });
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit(value);
  }

  return (
    <section className="command-glow mb-12 animate-fade-in">
      {showFlare && <div className="reactor-flare" />}
      <div className="command-wallpaper"><Image src="/fabric-wallpaper.png" alt="" fill priority sizes="100vw" className="select-none" /></div>
      <div className="text-center mb-7">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--color-brass)]">
          Comando · Dev Team de {workspaceName}
        </span>
        <h2 className="mt-3 font-display text-[2.4rem] md:text-[2.8rem] font-semibold leading-[1.05] text-[var(--text-primary)] tracking-[-0.01em]">
          O que vamos fazer hoje?
        </h2>
      </div>

      <form onSubmit={onSubmit} className="relative max-w-3xl mx-auto">
        <div className={cn(
          'hero-input glass-strong rounded-2xl flex items-center gap-3 px-5 py-4 transition-all',
          
        )}>
          <Sparkles className="h-5 w-5 text-[var(--color-brass)] flex-shrink-0" />
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Descreva uma missão para o squad executar autonomamente..."
            className="flex-1 bg-transparent text-[15px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            disabled={isPending}
            autoFocus
          />
          <button
            type="submit"
            disabled={isPending || !value.trim()}
            className="btn-brass rounded-xl h-11 px-5 inline-flex items-center gap-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Forjando…
              </>
            ) : (
              <>
                Forjar <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>

        {suggestions.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                disabled={isPending}
                className="chip-suggest rounded-full px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </form>
    </section>
  );
}
