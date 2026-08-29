import * as React from 'react';

import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

// Neutral-minimal — compact, tight-radius field with a quiet focus ring.
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-[var(--field-h)] w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground transition-colors',
        'placeholder:text-foreground-subtle',
        'focus-visible:outline-none focus-visible:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
