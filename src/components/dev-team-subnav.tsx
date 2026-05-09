'use client';

import Link from 'next/link';
import { motion, LayoutGroup } from 'framer-motion';
import { Sparkles, Activity, FlaskConical, History } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Counts {
  plan: number;
  execution: number;
  improvement: number;
  done: number;
}

interface Props {
  slug: string;
  active: string;
  counts: Counts;
}

const TABS = [
  { id: 'plan',        label: 'Plan',           icon: Sparkles,        accent: 'brass'   },
  { id: 'execution',   label: 'Execution',      icon: Activity,        accent: 'emerald' },
  { id: 'improvement', label: 'Improvement',    icon: FlaskConical,    accent: 'ember'   },
  { id: 'history',     label: 'History',        icon: History,         accent: 'forest'  },
] as const;

export function DevTeamSubNav({ slug, active, counts }: Props) {
  return (
    <div className="flex justify-end mb-6">
      <LayoutGroup id="devteam-subnav">
        <nav className="inline-flex items-center gap-1 p-1 rounded-xl bg-[var(--surface-elevated)] border border-[var(--border-1)] backdrop-blur-md">
          {TABS.map((t) => {
            const isActive = active === t.id;
            const href = `/${slug}?tab=${t.id}`;
            const Icon = t.icon;
            const count =
              t.id === 'plan' ? counts.plan :
              t.id === 'execution' ? counts.execution :
              t.id === 'improvement' ? counts.improvement :
              t.id === 'history' ? counts.done : null;

            return (
              <Link
                key={t.id}
                href={href}
                className={cn(
                  'relative px-3 h-8 inline-flex items-center gap-2 text-[12px] font-medium rounded-lg transition-colors whitespace-nowrap',
                  isActive
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="devteam-active-pill"
                    className="absolute inset-0 rounded-lg bg-[var(--hover-surface)] border border-[var(--border-2)]"
                    style={{
                      boxShadow: '0 4px 16px -6px rgba(212, 169, 97, 0.4), inset 0 1px 0 rgba(234, 200, 146, 0.18)',
                    }}
                    transition={{ type: 'spring', stiffness: 360, damping: 32 }}
                  />
                )}
                <span className="relative z-[1] flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                  <span className="hidden sm:inline">{t.label}</span>
                  {count !== null && count > 0 && (
                    <span className={cn(
                      'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-semibold',
                      isActive
                        ? 'bg-[var(--color-brass)]/20 text-[var(--color-brass)]'
                        : 'bg-[var(--surface-1)] text-[var(--text-muted)]'
                    )}>
                      {count}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </nav>
      </LayoutGroup>
    </div>
  );
}
