import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { WorkspaceRail } from '@/components/workspace-rail';
import { WorkspaceHeader } from '@/components/workspace-header';
import { fetchNotifications, fetchUnreadCount } from '@/lib/notifications';
import type { Workspace } from '@/lib/types';

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}

export default async function WorkspaceLayout({ children, params }: LayoutProps) {
  const { workspace: slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspaces } = await supabase
    .from('fabric_core_workspaces')
    .select('*')
    .order('created_at');

  const current = (workspaces ?? []).find((w) => w.slug === slug) as Workspace | undefined;
  if (!current) notFound();

  const [initialNotifications, initialUnread] = await Promise.all([
    fetchNotifications(current.id),
    fetchUnreadCount(current.id),
  ]);

  return (
    <div className="relative min-h-screen">
      <WorkspaceRail workspaces={workspaces as Workspace[]} user={{ email: user.email ?? '' }} />
      <main className="canvas relative z-10">
        <WorkspaceHeader
          workspace={current}
          initialNotifications={initialNotifications}
          initialUnread={initialUnread}
        />
        <div className="px-8 lg:px-12 py-10">
          <div className="mx-auto max-w-[1080px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
