import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-semibold transition-all disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brass)]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-forest-deep)]',
  {
    variants: {
      variant: {
        primary: 'btn-brass rounded-lg',
        secondary:
          'rounded-lg border border-[var(--color-celadon)]/30 text-[var(--text-secondary)] bg-transparent hover:border-[var(--color-brass)]/60 hover:text-[var(--text-primary)]',
        ghost:
          'rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5',
        link: 'text-[var(--color-brass)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5',
        sm: 'h-9 px-4 text-xs',
        lg: 'h-12 px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
