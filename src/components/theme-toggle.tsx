'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

type Theme = 'dark' | 'light';

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem('fabric-theme') as Theme | null) ?? 'dark';
    setTheme(stored);
    setMounted(true);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('fabric-theme', next); } catch {}
  }

  if (!mounted) {
    return <span className={`inline-block h-9 w-9 ${className}`} />;
  }

  const isLight = theme === 'light';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isLight ? 'Mudar para tema escuro' : 'Mudar para tema claro'}
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-surface)] transition-colors ${className}`}
      title={isLight ? 'Tema escuro' : 'Tema claro'}
    >
      {isLight ? (
        <Moon className="h-4 w-4" strokeWidth={2} />
      ) : (
        <Sun className="h-4 w-4" strokeWidth={2} />
      )}
    </button>
  );
}
