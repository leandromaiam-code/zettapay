import Image from 'next/image';
import { cn } from '@/lib/utils';
import type { Workspace } from '@/lib/types';

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

interface WorkspaceIconProps {
  workspace: Workspace;
  size?: number;
  rounded?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function WorkspaceIcon({
  workspace,
  size = 36,
  rounded = 'md',
  className,
}: WorkspaceIconProps) {
  const radius = rounded === 'lg' ? 'rounded-xl' : rounded === 'md' ? 'rounded-[10px]' : 'rounded-md';

  if (workspace.logo_url) {
    return (
      <div
        className={cn(
          'flex items-center justify-center overflow-hidden flex-shrink-0',
          "bg-white border border-white/40 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.18)]",
          radius,
          className
        )}
        style={{ width: size, height: size }}
      >
        <Image
          src={workspace.logo_url}
          alt={workspace.name}
          width={size}
          height={size}
          className="object-contain p-0.5"
          unoptimized
        />
      </div>
    );
  }

  // Fallback — colored initials box
  const fontSize = Math.max(11, Math.round(size * 0.36));
  return (
    <div
      className={cn('flex items-center justify-center font-display font-semibold flex-shrink-0 border border-white/10', radius, className)}
      style={{ width: size, height: size, fontSize, backgroundColor: workspace.brand_color, color: '#EFECE0' }}
    >
      {initials(workspace.name)}
    </div>
  );
}
