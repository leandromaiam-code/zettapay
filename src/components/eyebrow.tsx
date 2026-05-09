import { cn } from '@/lib/utils';

interface EyebrowProps {
  children: React.ReactNode;
  className?: string;
  tone?: 'default' | 'brass' | 'stone';
  size?: 'sm' | 'md';
}

export function Eyebrow({ children, className, tone = 'default', size = 'md' }: EyebrowProps) {
  const colors = {
    default: 'text-[var(--text-secondary)]',
    brass:   'text-[var(--color-brass)]',
    stone:   'text-[var(--text-muted)]',
  };
  const sizes = {
    sm: 'text-[9px] tracking-[0.22em]',
    md: 'text-[10px] tracking-[0.24em]',
  };
  return (
    <span className={cn('font-mono font-semibold uppercase', sizes[size], colors[tone], className)}>
      {children}
    </span>
  );
}
