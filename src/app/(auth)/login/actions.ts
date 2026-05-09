'use server';

import { createClient } from '@/lib/supabase/server';

export async function signInWithPassword(email: string, password: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.toLowerCase().includes('invalid login credentials')) {
      return { error: 'Email ou senha incorretos.' };
    }
    return { error: error.message };
  }
  return {};
}

export async function signUpWithPassword(email: string, password: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    if (error.message.toLowerCase().includes('already registered')) {
      return { error: 'Este email já tem conta. Use "Entrar".' };
    }
    return { error: error.message };
  }
  // Com mailer_autoconfirm=true no Supabase, signUp ja cria sessao
  return {};
}
