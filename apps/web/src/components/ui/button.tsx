import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Neutral-minimal design system — compact, tight-radius controls. The primary
// (oxblood) action is the rare accent; everything else is neutral/ghost so
// hierarchy is obvious. No heavy brand glow — restrained shadow only.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-sm leading-none ring-offset-background transition-[background-color,border-color,color,transform] duration-[var(--dur-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      // Variant names are a SUPERSET of canonical shadcn. The project's own
      // names (primary/coral/soft/dark/danger) are kept so existing call sites
      // never break, and canonical shadcn names (default/destructive/outline)
      // are added as on-brand aliases so newly-migrated pages can use the
      // standard shadcn API. default === primary; destructive === danger.
      variant: {
        // ---- canonical shadcn aliases ----
        default:
          'bg-brand-500 text-on-brand hover:bg-brand-600 active:bg-brand-700 shadow-sm',
        destructive: 'bg-danger text-white hover:bg-danger/90',
        outline:
          'border border-border-strong bg-surface text-foreground hover:bg-surface-muted',
        // ---- project variants (kept) ----
        primary:
          'bg-brand-500 text-on-brand hover:bg-brand-600 active:bg-brand-700 shadow-sm',
        secondary:
          'bg-surface text-foreground border border-border-strong hover:bg-surface-muted',
        ghost: 'text-foreground-muted hover:bg-surface-muted hover:text-foreground',
        soft: 'bg-surface-elevated text-foreground hover:bg-brand-50',
        coral: 'bg-coral-500 text-white hover:bg-coral-600',
        dark: 'bg-foreground text-surface hover:opacity-90',
        danger: 'bg-danger text-white hover:bg-danger/90',
        link: 'text-brand-500 underline-offset-4 hover:underline',
      },
      size: {
        // `default` is the canonical shadcn name; `md` is the project's — same size.
        // Touch devices (pointer:coarse) get larger tap targets while pointer
        // (mouse) keeps the dense desktop sizing — so phones/tablets are comfy
        // without bloating the desktop toolbars.
        default: 'h-8 px-3.5 [@media(pointer:coarse)]:h-10',
        sm: 'h-7 px-2.5 text-xs gap-1 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:px-3',
        md: 'h-8 px-3.5 [@media(pointer:coarse)]:h-10',
        lg: 'h-10 px-5 text-[15px]',
        icon: 'h-8 w-8 p-0 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot
          ref={ref}
          className={cn(buttonVariants({ variant, size }), className)}
          {...props}
        >
          {children}
        </Slot>
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
