'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, Check, CheckCheck, AlertTriangle, AlertCircle, Sparkles, Info, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale/pt-BR';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  fetchNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/lib/notifications';
import type { Notification, NotificationSeverity } from '@/lib/types';

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  initialNotifications: Notification[];
  initialUnread: number;
}

const severityIcon: Record<NotificationSeverity, typeof Bell> = {
  info: Info,
  success: Sparkles,
  warning: AlertTriangle,
  critical: AlertCircle,
};

const severityClass: Record<NotificationSeverity, string> = {
  info: 'icon-bg-forest text-[var(--text-secondary)]',
  success: 'icon-bg-emerald text-[var(--color-aurora-bright)]',
  warning: 'icon-bg-brass text-[var(--color-brass-light)]',
  critical: 'bg-[var(--color-ember)]/22 border border-[var(--color-ember)]/40 text-[var(--color-ember-soft)]',
};

const POLL_MS = 30_000;

export function NotificationsBell({
  workspaceId,
  workspaceSlug,
  initialNotifications,
  initialUnread,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>(initialNotifications);
  const [unread, setUnread] = useState<number>(initialUnread);
  const [, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync from server props (after RSC revalidation)
  useEffect(() => {
    setItems(initialNotifications);
    setUnread(initialUnread);
  }, [initialNotifications, initialUnread]);

  // Click outside / Esc to close
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Realtime + polling fallback
  useEffect(() => {
    const supabase = createClient();

    async function refresh() {
      const fresh = await fetchNotifications(workspaceId);
      setItems(fresh);
      setUnread(fresh.filter((n) => !n.read_at).length);
    }

    const poll = setInterval(refresh, POLL_MS);

    const channel = supabase
      .channel(`notifications-${workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'fabric_notifications',
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => {
          refresh();
        }
      )
      .subscribe();

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  function onItemClick(n: Notification) {
    if (!n.read_at) {
      // Optimistic
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))
      );
      setUnread((u) => Math.max(0, u - 1));
      startTransition(() => {
        markNotificationRead({ notificationId: n.id, workspaceSlug });
      });
    }
    if (n.href) {
      setOpen(false);
      router.push(n.href);
    }
  }

  function onMarkAll() {
    if (unread === 0) return;
    const now = new Date().toISOString();
    setItems((prev) => prev.map((x) => (x.read_at ? x : { ...x, read_at: now })));
    setUnread(0);
    startTransition(() => {
      markAllNotificationsRead({ workspaceId, workspaceSlug });
    });
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label={`Notificações${unread > 0 ? ` (${unread} não lidas)` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative h-9 w-9 rounded-lg flex items-center justify-center transition-colors',
          open
            ? 'text-[var(--color-brass)] bg-[var(--hover-surface)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)]'
        )}
      >
        <Bell className="h-4 w-4" strokeWidth={2} />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-mono font-bold flex items-center justify-center bg-[var(--color-ember)] text-[var(--color-parchment)]"
            style={{ boxShadow: '0 0 8px -1px rgba(194, 107, 94, 0.7)' }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }}
            className="absolute right-0 top-[calc(100%+8px)] w-[min(92vw,380px)] max-h-[78vh] flex flex-col rounded-xl border border-[var(--border-2)] bg-[var(--surface-1-strong)] backdrop-blur-xl z-30 overflow-hidden"
            style={{ boxShadow: '0 24px 56px -16px rgba(0,0,0,0.55), 0 0 0 1px rgba(212, 169, 97, 0.12)' }}
          >
            <div className="flex items-center justify-between px-4 h-12 border-b border-[var(--border-divider)] flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
                  Notificações
                </span>
                {unread > 0 && (
                  <span className="font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[var(--color-aurora-bright)]">
                    · {unread} não lidas
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onMarkAll}
                  disabled={unread === 0}
                  className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)] disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)] transition-colors"
                  title="Marcar todas como lidas"
                >
                  <CheckCheck className="h-3 w-3" strokeWidth={2.5} />
                  <span className="hidden sm:inline">Marcar lidas</span>
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)] transition-colors"
                  aria-label="Fechar"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {items.length === 0 ? (
                <div className="px-6 py-10 flex flex-col items-center justify-center gap-2 text-center">
                  <Bell className="h-6 w-6 text-[var(--text-muted)]" strokeWidth={1.5} />
                  <p className="text-[13px] font-medium text-[var(--text-secondary)]">Tudo silencioso por aqui.</p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Eventos importantes do workspace aparecem aqui.
                  </p>
                </div>
              ) : (
                <ul className="py-1">
                  {items.map((n) => {
                    const Icon = severityIcon[n.severity] ?? Info;
                    const isUnread = !n.read_at;
                    const ts = formatDistanceToNow(new Date(n.created_at), {
                      addSuffix: true,
                      locale: ptBR,
                    });
                    const Inner = (
                      <div
                        className={cn(
                          'flex items-start gap-3 px-4 py-3 transition-colors cursor-pointer',
                          isUnread ? 'bg-[var(--color-emerald)]/8' : 'bg-transparent',
                          'hover:bg-[var(--hover-surface)]'
                        )}
                      >
                        <span
                          className={cn(
                            'icon-box flex-shrink-0 mt-0.5',
                            severityClass[n.severity]
                          )}
                          style={{ width: 28, height: 28, borderRadius: 8 }}
                        >
                          <Icon className="h-3.5 w-3.5 relative z-[1]" strokeWidth={2} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <h4
                              className={cn(
                                'text-[13px] leading-tight truncate',
                                isUnread
                                  ? 'font-semibold text-[var(--text-primary)]'
                                  : 'font-medium text-[var(--text-secondary)]'
                              )}
                            >
                              {n.title}
                            </h4>
                            {isUnread && (
                              <span
                                aria-hidden
                                className="h-1.5 w-1.5 rounded-full bg-[var(--color-aurora-bright)] flex-shrink-0"
                                style={{ boxShadow: '0 0 6px rgba(125, 216, 181, 0.7)' }}
                              />
                            )}
                          </div>
                          {n.body && (
                            <p className="mt-0.5 text-[12px] text-[var(--text-secondary)] leading-snug line-clamp-2 break-words">
                              {n.body}
                            </p>
                          )}
                          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                            {ts}
                          </p>
                        </div>
                        {!isUnread && (
                          <Check
                            className="h-3 w-3 mt-2 text-[var(--text-muted)] flex-shrink-0"
                            strokeWidth={2.5}
                            aria-hidden
                          />
                        )}
                      </div>
                    );
                    return (
                      <li key={n.id} className="border-b border-[var(--border-divider)] last:border-b-0">
                        {n.href ? (
                          <Link
                            href={n.href}
                            onClick={(e) => {
                              e.preventDefault();
                              onItemClick(n);
                            }}
                            className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brass)]/60 focus-visible:ring-inset"
                          >
                            {Inner}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onItemClick(n)}
                            className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brass)]/60 focus-visible:ring-inset"
                          >
                            {Inner}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
