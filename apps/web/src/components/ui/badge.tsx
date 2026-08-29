import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

// Neutral-minimal — compact status pills. Default is neutral; semantic
// variants carry the meaning. Tight radius, small footprint.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-surface-elevated text-foreground-muted',
        brand: 'bg-brand-50 text-brand-700',
        muted: 'bg-surface-muted text-foreground-muted',
        success: 'bg-success-100 text-success',
        warning: 'bg-warning-100 text-warning',
        danger: 'bg-danger-100 text-danger',
        coral: 'bg-coral-100 text-coral-700',
        info: 'bg-info-100 text-info',
        outline: 'border border-border-strong text-foreground-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
