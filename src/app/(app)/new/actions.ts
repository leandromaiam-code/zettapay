'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { notifyN8n } from '@/lib/n8n';

export async function createWorkspace(input: {
  name: string;
  slug: string;
  brand_color: string;
}): Promise<{ slug?: string; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  if (!input.name?.trim() || !input.slug?.trim()) {
    return { error: 'Nome e slug são obrigatórios.' };
  }
  if (!/^[a-z0-9\-]+$/.test(input.slug)) {
    return { error: 'Slug deve conter apenas letras minúsculas, números e hífens.' };
  }

  const { data, error } = await supabase
    .from('fabric_core_workspaces')
    .insert({
      slug: input.slug,
      name: input.name.trim(),
      brand_color: input.brand_color,
      owner_id: user.id,
    })
    .select('id, slug')
    .single();

  if (error) {
    if (error.code === '23505') return { error: 'Slug já existe. Escolha outro.' };
    return { error: error.message };
  }

  await notifyN8n({
    event: 'workspace.created',
    workspace: { id: data.id, slug: data.slug },
  });

  return { slug: data.slug };
}
