import { Eyebrow } from './eyebrow';
import { toRoman } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  numeral?: number;
  className?: string;
}

export function SectionHeader({ eyebrow, title, subtitle, numeral, className }: SectionHeaderProps) {
  return (
    <header className={cn('scan-line-host mb-12 animate-fade-in', className)}>
      <div className="flex items-center gap-3 mb-3">
        <span className="hr-eyebrow" />
        <Eyebrow>{eyebrow}</Eyebrow>
      </div>

      <div className="flex items-baseline gap-5">
        {numeral !== undefined && (
          <span className="roman-numeral-massive flex-shrink-0">
            {toRoman(numeral)}.
          </span>
        )}
        <h1 className="title-breathe font-display text-[3rem] md:text-[3.6rem] font-semibold leading-[1.02] tracking-[-0.022em] text-[var(--text-primary)]">
          {title}
        </h1>
      </div>

      {subtitle && (
        <p className="mt-5 max-w-2xl text-[15px] font-medium text-[var(--text-secondary)] leading-[1.65] border-l-2 border-[var(--color-emerald)] pl-4">
          {subtitle}
        </p>
      )}
    </header>
  );
}
