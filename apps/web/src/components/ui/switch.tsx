'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

// Dependency-free toggle switch (no @radix-ui/react-switch in the bundle).
// Standard accessible pattern: a button with role="switch" + aria-checked,
// space/enter toggles it natively. Brand-on / muted-off, with a sliding thumb.
export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, disabled, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-500' : 'bg-surface-elevated',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none inline-block size-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  ),
);
Switch.displayName = 'Switch';
