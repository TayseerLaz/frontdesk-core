'use client';

import { cn } from '@/lib/utils';
import * as React from 'react';

interface TabsContextValue {
  value: string;
  onValueChange: (v: string) => void;
}
const TabsContext = React.createContext<TabsContextValue | null>(null);

export function Tabs({
  value,
  onValueChange,
  defaultValue,
  className,
  children,
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  defaultValue?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [internal, setInternal] = React.useState(defaultValue ?? '');
  const v = value ?? internal;
  const setV = onValueChange ?? setInternal;
  return (
    <TabsContext.Provider value={{ value: v, onValueChange: setV }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-10 items-center justify-center rounded-md bg-surface-muted p-1 text-foreground-muted',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsTrigger must be used inside <Tabs>');
  const active = ctx.value === value;
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400',
        active ? 'bg-surface text-foreground shadow-sm' : 'hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error('TabsContent must be used inside <Tabs>');
  if (ctx.value !== value) return null;
  // Active panel mounts fresh on each switch → animate-in fires, giving a
  // subtle fade+rise as you move between tabs.
  return (
    <div
      role="tabpanel"
      className={cn(
        'mt-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200',
        className,
      )}
    >
      {children}
    </div>
  );
}
