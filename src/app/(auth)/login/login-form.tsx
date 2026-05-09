'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight } from 'lucide-react';
import { signInWithPassword, signUpWithPassword } from './actions';

type Mode = 'signin' | 'signup';

export function LoginForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email || password.length < 6) {
      setError('Senha precisa ter ao menos 6 caracteres.');
      return;
    }
    startTransition(async () => {
      const result = mode === 'signin'
        ? await signInWithPassword(email, password)
        : await signUpWithPassword(email, password);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.push('/');
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label htmlFor="email" className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          Email
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@exemplo.com"
          required
          autoComplete="email"
          className="mt-2 w-full bg-transparent border-b border-[var(--border-1)] focus:border-[var(--color-brass)] py-2 text-[15px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
        />
      </div>

      <div>
        <label htmlFor="password" className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
          Senha
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          minLength={6}
          autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          className="mt-2 w-full bg-transparent border-b border-[var(--border-1)] focus:border-[var(--color-brass)] py-2 text-[15px] font-medium text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none transition-colors"
        />
      </div>

      {error && (
        <p className="text-sm font-medium text-[#E89B8E] border-l-2 border-[#E89B8E] pl-3">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !email || !password}
        className="btn-brass rounded-lg h-12 w-full inline-flex items-center justify-center gap-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-all"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            {mode === 'signin' ? 'Entrar' : 'Criar conta'}
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>

      <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)] pt-2">
        {mode === 'signin' ? (
          <>
            <span className="font-medium">Primeira vez aqui?</span>
            <button
              type="button"
              onClick={() => { setMode('signup'); setError(''); }}
              className="font-mono uppercase tracking-[0.2em] text-[var(--color-brass)] hover:text-[var(--color-brass-light)]"
            >
              Criar conta →
            </button>
          </>
        ) : (
          <>
            <span className="font-medium">Já tem conta?</span>
            <button
              type="button"
              onClick={() => { setMode('signin'); setError(''); }}
              className="font-mono uppercase tracking-[0.2em] text-[var(--color-brass)] hover:text-[var(--color-brass-light)]"
            >
              Entrar →
            </button>
          </>
        )}
      </div>
    </form>
  );
}
