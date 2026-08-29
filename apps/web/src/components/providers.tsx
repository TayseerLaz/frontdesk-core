'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';

import { SessionProvider } from '@/lib/session';

import { ThemeProvider } from './theme-provider';
import { ConfirmDialogRoot } from './ui/confirm-dialog';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>{children}</SessionProvider>
        <Toaster position="top-right" richColors closeButton theme="system" />
        <ConfirmDialogRoot />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
