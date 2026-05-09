'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import type { Notification } from '@/lib/types';

const FETCH_LIMIT = 30;

export async function fetchNotifications(
  workspaceId: string,
  limit = FETCH_LIMIT
): Promise<Notification[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fabric_notifications')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []) as Notification[];
}

export async function fetchUnreadCount(workspaceId: string): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('fabric_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .is('read_at', null);
  return count ?? 0;
}

export async function markNotificationRead(input: {
  notificationId: string;
  workspaceSlug: string;
}): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  await supabase
    .from('fabric_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', input.notificationId)
    .is('read_at', null);
  revalidatePath(`/${input.workspaceSlug}`);
  return { ok: true };
}

export async function markAllNotificationsRead(input: {
  workspaceId: string;
  workspaceSlug: string;
}): Promise<{ ok: boolean; count: number }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fabric_notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('workspace_id', input.workspaceId)
    .is('read_at', null)
    .select('id');
  revalidatePath(`/${input.workspaceSlug}`);
  return { ok: true, count: data?.length ?? 0 };
}
