'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Plus, LogOut, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceIcon } from './workspace-icon';
import { AutodevDot } from './autodev-indicator';
import type { Workspace } from '@/lib/types';

interface RailProps {
  workspaces: Workspace[];
  user: { email: string };
}

export function WorkspaceRail({ workspaces, user }: RailProps) {
  const params = useParams<{ workspace?: string }>();
  const currentSlug = params.workspace;
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(document.documentElement.dataset.rail === 'expanded');
  }, []);

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    document.documentElement.dataset.rail = next ? 'expanded' : 'collapsed';
    try { localStorage.setItem('fabric-rail', next ? 'expanded' : 'collapsed'); } catch {}
  }

  return (
    <aside className="rail fixed left-0 top-0 h-screen bg-[var(--surface-rail)] backdrop-blur-xl border-r border-[var(--border-1)] flex flex-col py-5 z-30">
      {/* Veridian symbol */}
      <Link href="/" className="rail-section flex items-center gap-3 mb-5 group min-h-11 px-4">
        <Image src="/veridian-symbol.png" alt="Veridian" width={42} height={42} priority className="flex-shrink-0 transition-transform group-hover:scale-105" />
        <div className="rail-text">
          <div className="font-wordmark text-base font-semibold text-[var(--color-parchment)] leading-none">VERIDIAN</div>
          <div className="mt-1 font-mono text-[9px] font-semibold uppercase tracking-[0.24em] text-[var(--color-brass)]">Fabric · v0</div>
        </div>
      </Link>

      <div className="rail-section mx-auto h-px bg-[var(--border-1)] mb-3" style={{ width: expanded ? 'calc(100% - 24px)' : '32px' }} />

      {/* Workspaces */}
      <div className="rail-section flex-1 flex flex-col gap-2 overflow-y-auto overflow-x-hidden">
        {workspaces.map((w) => {
          const active = w.slug === currentSlug;
          return (
            <Link
              key={w.id}
              href={`/${w.slug}`}
              className="group relative flex items-center gap-3 min-h-11 hover:bg-[var(--hover-surface)] rounded-lg transition-colors px-3 -mx-1"
              title={!expanded ? w.name : undefined}
            >
              {active && (
                <span className="absolute -left-1 top-1/2 -translate-y-1/2 h-7 w-[3px] bg-[var(--color-brass)] rounded-r" />
              )}
              <div className="relative">{w.autodev_enabled && (<span className="absolute -top-1 -right-1 z-[2]"><AutodevDot /></span>)}</div>
              <WorkspaceIcon
                workspace={w}
                size={36}
                rounded="md"
                className={cn(
                  'transition-all',
                  active
                    ? 'ring-1 ring-[var(--color-brass)]/60 shadow-[0_4px_18px_-6px] shadow-[var(--color-brass)]/40'
                    : 'opacity-85 group-hover:opacity-100'
                )}
              />
              <span className={cn(
                'rail-text font-medium text-sm truncate',
                active ? 'text-[var(--color-parchment)]' : 'text-[var(--color-celadon)]'
              )}>
                {w.name}
              </span>

              {/* Tooltip (só no collapsed) */}
              <span className="rail-tooltip pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 px-2.5 py-1 bg-[var(--color-forest-deep)] text-[var(--color-parchment)] text-[11px] font-medium rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 border border-[var(--border-1)]">
                {w.name}
              </span>
            </Link>
          );
        })}

        {/* New workspace */}
        <Link
          href="/new"
          className="group flex items-center gap-3 min-h-11 hover:bg-[var(--hover-surface)] rounded-lg transition-colors px-3 -mx-1 mt-2"
          title={!expanded ? 'Novo workspace' : undefined}
        >
          <div className="h-9 w-9 rounded-[10px] flex items-center justify-center text-[var(--color-celadon)] border border-dashed border-[var(--color-celadon)]/30 group-hover:border-[var(--color-brass)] group-hover:text-[var(--color-brass)] transition-colors flex-shrink-0">
            <Plus className="h-4 w-4" strokeWidth={2} />
          </div>
          <span className="rail-text font-medium text-sm text-[var(--color-celadon)] group-hover:text-[var(--color-brass)] transition-colors">
            Novo workspace
          </span>
        </Link>
      </div>

      {/* Toggle expand/collapse */}
      <div className="rail-section mt-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={expanded ? 'Recolher menu' : 'Expandir menu'}
          className="flex items-center gap-3 min-h-9 w-full hover:bg-[var(--hover-surface)] rounded-lg transition-colors px-3 -mx-1 text-[var(--color-celadon)] hover:text-[var(--color-parchment)]"
        >
          <div className="h-9 w-9 flex items-center justify-center flex-shrink-0">
            {expanded ? <ChevronsLeft className="h-4 w-4" strokeWidth={2} /> : <ChevronsRight className="h-4 w-4" strokeWidth={2} />}
          </div>
          <span className="rail-text font-mono text-[10px] font-semibold uppercase tracking-[0.22em]">
            Recolher
          </span>
        </button>
      </div>

      {/* User */}
      <div className="rail-section mt-2 pt-3 border-t border-[var(--border-1)]">
        <div className="flex items-center gap-3 min-h-9 px-3 -mx-1">
          <div
            className="h-9 w-9 rounded-full bg-[var(--color-brass)] flex items-center justify-center text-[var(--color-forest-deep)] text-xs font-bold flex-shrink-0"
            title={user.email}
          >
            {user.email.charAt(0).toUpperCase()}
          </div>
          <div className="rail-text flex-1 min-w-0">
            <div className="text-xs font-medium text-[var(--color-celadon)] truncate">{user.email}</div>
          </div>
          <form action="/auth/sign-out" method="post" className="rail-text">
            <button
              type="submit"
              className="text-[var(--color-stone-soft)] hover:text-[var(--color-brass)] transition-colors p-1.5"
              title="Sair"
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
