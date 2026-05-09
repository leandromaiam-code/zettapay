import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { NewWorkspaceForm } from './new-workspace-form';
import Image from 'next/image';

export default async function NewWorkspacePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <main className="min-h-screen flex items-center justify-center p-8 relative">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <Image src="/veridian-symbol.png" alt="" width={520} height={520} priority className="opacity-[0.04]" />
      </div>

      <div className="relative z-10 w-full max-w-[460px] animate-fade-in">
        <header className="mb-8">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--color-brass)]">
            I. Forjar
          </span>
          <h1 className="mt-3 font-display text-[2.6rem] font-semibold text-[var(--text-primary)] leading-[1.05]">
            Novo workspace
          </h1>
          <p className="mt-3 text-[15px] font-medium text-[var(--text-secondary)] leading-relaxed border-l-2 border-[var(--color-brass)] pl-4">
            Cada workspace é um produto autônomo. Premissas, hipóteses e missões vivem dentro dele.
          </p>
        </header>

        <div className="glass-strong rounded-2xl p-7">
          <NewWorkspaceForm />
        </div>
      </div>
    </main>
  );
}
