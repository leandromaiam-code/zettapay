'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Settings, BookOpen, Layers, Map as MapIcon, Sparkles, Radio, LayoutDashboard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';
import { InstallPWA } from './install-pwa';
import { AutodevBadge } from './autodev-indicator';
import { NotificationsBell } from './notifications-bell';
import { WorkspaceIcon } from './workspace-icon';
import type { Notification, Workspace } from '@/lib/types';

interface HeaderProps {
  workspace: Workspace;
  initialNotifications: Notification[];
  initialUnread: number;
}


export function WorkspaceHeader({ workspace, initialNotifications, initialUnread }: HeaderProps) {
  const pathname = usePathname();
  const search = useSearchParams();
  const isWorkspaceRoot = pathname === `/${workspace.slug}`;
  const isPremissas = pathname.startsWith(`/${workspace.slug}/premissas`);
  const isSettings  = pathname.startsWith(`/${workspace.slug}/settings`);
  const tabParam = search.get('tab');
  const isCommandCenter = isWorkspaceRoot && !tabParam;
  const isDevTeam = isWorkspaceRoot && !!tabParam && ['plan','execution','improvement','history'].includes(tabParam);

  return (
    <header className="sticky top-0 z-20 backdrop-blur-xl bg-[var(--surface-header)] border-b border-[var(--border-1)] transition-colors">
      <div className="px-8 lg:px-10 h-14 flex items-center gap-6">
        <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
          <WorkspaceIcon workspace={workspace} size={32} rounded="md" />
          <div className="min-w-0 hidden md:flex flex-col leading-tight">
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
              workspace · {workspace.slug}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-[15px] font-semibold leading-tight text-[var(--text-primary)] truncate">
                {workspace.name}
              </h1>
              {workspace.autodev_enabled && <AutodevBadge />}
            </div>
          </div>
        </div>

        <span className="hidden lg:inline-block h-7 w-px bg-[var(--border-1)] flex-shrink-0" />

        <div className="flex-1" />

        <nav className="flex items-center gap-1 flex-shrink-0">
          <Link href={`/${workspace.slug}`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors',
            isCommandCenter
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Command Center</span>
          </Link>
          <Link href={`/${workspace.slug}?tab=plan`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors',
            isDevTeam
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Dev Team</span>
          </Link>
          <Link href={`/${workspace.slug}/premissas`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors',
            isPremissas
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <BookOpen className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Premissas</span>
          </Link>
          <Link href={`/${workspace.slug}/roadmap`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors',
            pathname.startsWith(`/${workspace.slug}/roadmap`)
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <MapIcon className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Roadmap</span>
          </Link>
          <Link href={`/${workspace.slug}/canon`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors',
            pathname.startsWith(`/${workspace.slug}/canon`)
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <Layers className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Canon</span>
          </Link>
          <Link href={`/${workspace.slug}/events`} className={cn(
            'h-9 px-3 rounded-lg flex items-center gap-2 text-[13px] font-medium transition-colors relative',
            pathname.startsWith(`/${workspace.slug}/events`)
              ? 'text-[var(--text-primary)] bg-[var(--color-emerald)]/30'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )}>
            <Radio className="h-4 w-4" strokeWidth={2} />
            <span className="hidden xl:inline">Stream</span>
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-aurora-bright)] pulse-dot" aria-hidden />
          </Link>
          <Link href={`/${workspace.slug}/settings`} className={cn(
            'h-9 w-9 rounded-lg flex items-center justify-center transition-colors',
            isSettings
              ? 'text-[var(--color-brass)] bg-[var(--hover-surface)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
          )} aria-label="Settings">
            <Settings className="h-4 w-4" strokeWidth={2} />
          </Link>
          <NotificationsBell
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
            initialNotifications={initialNotifications}
            initialUnread={initialUnread}
          />
          <InstallPWA />
          <span className="mx-1 h-6 w-px bg-[var(--border-1)]" />
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
