'use client';

import * as React from 'react';

// Tiny dark-mode provider. No next-themes dep — we just toggle the `dark`
// class on <html> and persist the choice in localStorage. Defaults to the
// user's OS preference and watches for changes while their preference
// is set to "system".

export type Theme = 'light' | 'dark' | 'system';

interface ThemeCtx {
  theme: Theme;
  /** What's actually rendered right now ("dark" or "light"). */
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}

const Ctx = React.createContext<ThemeCtx | null>(null);

const STORAGE_KEY = 'aligned:theme';

function getSystem(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyClass(target: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', target === 'dark');
  // For things that hook `color-scheme` (form controls, scrollbars).
  root.style.colorScheme = target;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('system');
  const [resolved, setResolved] = React.useState<'light' | 'dark'>('light');

  // First-mount: read persisted choice (or system) and apply before paint
  // via useLayoutEffect to avoid a flash of the wrong theme.
  React.useLayoutEffect(() => {
    let stored: Theme | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    } catch {
      /* localStorage blocked → fall back to system */
    }
    const initial: Theme = stored ?? 'system';
    setThemeState(initial);
    const target = initial === 'system' ? getSystem() : initial;
    setResolved(target);
    applyClass(target);
  }, []);

  // When the choice is "system", track OS-level changes live.
  React.useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = mq.matches ? 'dark' : 'light';
      setResolved(next);
      applyClass(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = React.useCallback((t: Theme) => {
    setThemeState(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* noop */
    }
    const target = t === 'system' ? getSystem() : t;
    setResolved(target);
    applyClass(target);
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
