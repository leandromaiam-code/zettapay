'use client';

import { Cpu } from 'lucide-react';

export function AutodevDot({ className = '' }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex h-2 w-2 ${className}`}
      title="AutoDev ativo"
      aria-label="AutoDev ativo"
    >
      <span className="absolute inset-0 rounded-full bg-[var(--color-emerald-glow)] opacity-80 animate-[pulse-dot_1.6s_ease-in-out_infinite]" />
      <span className="absolute inset-0 rounded-full bg-[var(--color-emerald-glow)] blur-[3px] opacity-60" />
    </span>
  );
}

export function AutodevBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--color-aurora-bright)] border border-[var(--color-emerald-glow)]/40 bg-[var(--color-emerald)]/16"
      style={{ boxShadow: '0 0 12px -2px rgba(125, 216, 181, 0.32), inset 0 1px 0 rgba(125, 216, 181, 0.18)' }}
      title="AutoDev rodando — Plan agents executando autonomamente"
    >
      <Cpu className="h-3 w-3" strokeWidth={2.5} />
      <span className="animate-pulse">AutoDev</span>
    </span>
  );
}
