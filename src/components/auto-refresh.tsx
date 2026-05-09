'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  enabled?: boolean;
  intervalMs?: number;
}

/**
 * Re-roda os Server Components da pagina atual a cada intervalo.
 * Nao recarrega a pagina (sem flicker, mantem scroll).
 *
 * Uso tipico: <AutoRefresh enabled={hasRunningMissions} intervalMs={12000} />
 */
export function AutoRefresh({ enabled = true, intervalMs = 15000 }: Props) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, intervalMs, router]);

  return null;
}
