/**
 * FR.1 Wave A — Auth helper para rotas internas (fabric-api → next).
 *
 * Aceita dois modos:
 *  1. Sessao logada do Supabase (cookie) — para uso pela UI / dev tools
 *  2. Header X-Fabric-Token == FABRIC_INTERNAL_TOKEN — para chamadas
 *     server-to-server vindas do fabric-api no droplet
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient, createAdminClient } from '@/lib/supabase/server';

export type AuthedActor =
  | { kind: 'user'; user: User; supabase: SupabaseClient; actor: string }
  | { kind: 'service'; supabase: SupabaseClient; actor: string };

export async function requireInternalAuth(request: Request): Promise<AuthedActor | NextResponse> {
  const headerToken = request.headers.get('x-fabric-token');
  const expected = process.env.FABRIC_INTERNAL_TOKEN ?? process.env.FABRIC_API_TOKEN ?? null;

  if (expected && headerToken && headerToken === expected) {
    return {
      kind: 'service',
      supabase: createAdminClient() as unknown as SupabaseClient,
      actor: 'fabric-api',
    };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    return {
      kind: 'user',
      user,
      supabase: supabase as unknown as SupabaseClient,
      actor: user.email ?? 'user',
    };
  }

  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}
