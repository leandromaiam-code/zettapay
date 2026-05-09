import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Eyebrow } from '@/components/eyebrow';
import { SettingsForm } from './settings-form';
import { AutodevToggle } from '@/components/autodev-toggle';
import { MissionAllowlistSelector } from '@/components/mission-allowlist-selector';
import { ALL_SQUADS, type Workspace } from '@/lib/types';

interface PageProps {
  params: Promise<{ workspace: string }>;
}

interface MemberRow {
  user_id: string;
  role: string;
  created_at: string;
}

export default async function SettingsPage({ params }: PageProps) {
  const { workspace: slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('fabric_core_workspaces')
    .select('*')
    .eq('slug', slug)
    .single<Workspace>();

  if (!workspace) return null;

  // Backfill defensivo: workspaces antigos podem nao ter rodado a migration 0003.
  const safeWorkspace: Workspace = {
    ...workspace,
    allowed_mission_squads:
      workspace.allowed_mission_squads && workspace.allowed_mission_squads.length > 0
        ? workspace.allowed_mission_squads
        : [...ALL_SQUADS],
  };

  const { data: members } = await supabase
    .from('fabric_core_members')
    .select('user_id, role, created_at')
    .eq('workspace_id', workspace.id)
    .order('created_at');

  const isOwner = workspace.owner_id === user.id;

  return (
    <div className="animate-fade-in">
      <header className="mb-10">
        <Eyebrow tone="brass">Configuração · workspace · {workspace.slug}</Eyebrow>
        <h1 className="mt-3 font-display text-[2.6rem] font-semibold text-[var(--text-primary)] leading-[1.05] tracking-[-0.01em]">
          Settings
        </h1>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
        <div className="glass rounded-xl p-7">
          <Eyebrow className="mb-5">Identidade</Eyebrow>
          <SettingsForm workspace={safeWorkspace} canEdit={isOwner} />
        </div>

        <AutodevToggle workspace={safeWorkspace} canEdit={isOwner} />

        <MissionAllowlistSelector workspace={safeWorkspace} canEdit={isOwner} />

        <div className="glass rounded-xl p-7">
          <Eyebrow className="mb-5">Membros</Eyebrow>
          {(members ?? []).length === 0 ? (
            <p className="text-sm text-[var(--text-secondary)] font-medium">Nenhum membro.</p>
          ) : (
            <ul className="space-y-3">
              {(members as MemberRow[]).map((m) => (
                <li key={m.user_id} className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-[var(--text-muted)] truncate">
                    {m.user_id.slice(0, 8)}…
                  </span>
                  <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.18em] px-2 py-0.5 rounded ${m.role === 'owner' ? 'text-[var(--color-brass)] bg-[var(--color-brass)]/10' : 'text-[var(--text-secondary)] bg-[var(--color-emerald)]/20'}`}>
                    {m.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-5 text-xs text-[var(--text-muted)] font-medium leading-relaxed">
            Convite real fica para V1. Por ora, adicionar membros via SQL.
          </p>
        </div>
      </section>
    </div>
  );
}
