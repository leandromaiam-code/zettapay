import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="text-center max-w-md animate-fade-in">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--color-brass)]">
          404 · ausente
        </span>
        <h1 className="mt-3 font-display text-[3.5rem] font-semibold text-[var(--text-primary)] leading-tight">
          Substrato não encontrado
        </h1>
        <p className="mt-3 text-[15px] font-medium text-[var(--text-secondary)]">
          A rota que você procurou não existe — ou não está no seu workspace.
        </p>
        <Link href="/" className="mt-8 btn-brass rounded-lg h-11 px-6 inline-flex items-center gap-2 text-sm transition-all">
          Voltar ao Fabric
        </Link>
      </div>
    </main>
  );
}
