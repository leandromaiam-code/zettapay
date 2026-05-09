import Image from 'next/image';

export const metadata = {
  title: 'Offline · Veridian Fabric',
};

export default function OfflinePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 text-center">
      <div className="max-w-sm">
        <Image
          src="/veridian-symbol.png"
          alt="Veridian"
          width={88}
          height={88}
          className="mx-auto mb-6 opacity-80"
          priority
        />
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-[var(--color-brass)]">
          Offline · sem conexão
        </span>
        <h1 className="mt-3 font-display text-[2rem] font-semibold text-[var(--text-primary)] leading-tight">
          O substrato precisa de rede.
        </h1>
        <p className="mt-4 text-sm font-medium text-[var(--text-secondary)]">
          Fabric depende do orquestrador para executar missões. Reconecte e tente novamente.
        </p>
      </div>
    </main>
  );
}
