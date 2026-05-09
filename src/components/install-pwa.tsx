'use client';

import { useEffect, useState } from 'react';
import { Download, Check } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export function InstallPWA({ className = '' }: { className?: string }) {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Detecta se ja esta rodando como PWA standalone
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.navigator as any).standalone === true;
    if (isStandalone) {
      setInstalled(true);
      return;
    }

    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    }

    function onInstalled() {
      setInstalled(true);
      setPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const result = await prompt.userChoice;
    if (result.outcome === 'accepted') {
      setInstalled(true);
    }
    setPrompt(null);
  }

  if (installed) {
    return (
      <span
        className={`hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-mono font-semibold uppercase tracking-[0.18em] text-[var(--color-aurora-bright)] ${className}`}
        title="App instalado"
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
        Instalado
      </span>
    );
  }

  if (!prompt) {
    // Sem prompt disponivel — mostra dica iOS / outros
    return (
      <span
        className={`hidden xl:inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[11px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-help ${className}`}
        title="Para instalar como app: Chrome (...) > Instalar app · Safari iOS: Compartilhar > Adicionar à Tela de Início"
      >
        <Download className="h-3.5 w-3.5" strokeWidth={2} />
        App
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={install}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[11px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--color-brass-light)] border border-[var(--border-2)] hover:border-[var(--border-active)] hover:bg-[var(--hover-surface)] transition-all ${className}`}
      title="Instalar como aplicativo"
    >
      <Download className="h-3.5 w-3.5" strokeWidth={2.5} />
      Instalar app
    </button>
  );
}
