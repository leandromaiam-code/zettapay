import Image from 'next/image';
import { LoginForm } from './login-form';
import { ThemeToggle } from '@/components/theme-toggle';

export const metadata = {
  title: 'Acesso · Veridian Fabric',
};

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 relative overflow-hidden">
      <div className="absolute top-6 right-6 z-30">
        <ThemeToggle />
      </div>

      {/* Wallpaper de fundo — entra com reactor-boot */}
      <div className="absolute inset-0 reactor-boot">
        <Image
          src="/fabric-login.png"
          alt=""
          fill
          priority
          className="object-cover select-none pointer-events-none"
          sizes="100vw"
        />
      </div>

      <div className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, rgba(4, 13, 11, 0.35) 0%, rgba(4, 13, 11, 0.78) 100%)',
        }}
      />

      <div className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0, 0, 0, 0.45) 100%)',
        }}
      />

      <div className="relative z-10 w-full max-w-[420px]">
        <header className="text-center mb-10">
          <div className="flex items-center justify-center gap-3">
            <span className="hr-eyebrow hr-grow" style={{ marginRight: 0, transformOrigin: 'right' }} />
            <span className="wordmark-reveal font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-[var(--color-brass-light)]">
              Fabric · v0 · MMXXVI
            </span>
            <span className="hr-eyebrow hr-grow" style={{ marginLeft: 0, transformOrigin: 'left' }} />
          </div>
        </header>

        <div
          className="glass-strong rounded-2xl p-8 wordmark-reveal"
          style={{
            background: 'rgba(8, 20, 16, 0.78)',
            backdropFilter: 'blur(28px) saturate(160%)',
            WebkitBackdropFilter: 'blur(28px) saturate(160%)',
            animationDelay: '0.7s',
          }}
        >
          <span className="font-numeral text-[var(--color-brass-light)] text-2xl">I.</span>
          <h2 className="mt-2 font-display text-[2.2rem] font-semibold text-[var(--color-parchment)] leading-[1.1]">
            Entrar
          </h2>
          <p className="mt-2 text-sm font-medium text-[var(--color-celadon)]">
            Email e senha. Sem cerimônia.
          </p>

          <div className="mt-7">
            <LoginForm />
          </div>
        </div>

        <p
          className="wordmark-reveal mt-8 text-center font-mono text-[9px] font-semibold uppercase tracking-[0.32em] text-[var(--color-celadon)]/60"
          style={{ animationDelay: '1.2s' }}
        >
          Autonomous intelligence, forged.
        </p>
      </div>
    </main>
  );
}
