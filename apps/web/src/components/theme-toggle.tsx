'use client';

import { Monitor, Moon, Sun } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from './theme-provider';
import { Button } from '@/components/ui/button';

// 3-state toggle: Light / Dark / System. Lives in the top bar.
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const Icon = resolved === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme" title="Theme">
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem onSelect={() => setTheme('light')}>
          <Sun className="size-4" /> Light
          {theme === 'light' ? <span className="ml-auto text-xs text-foreground-subtle">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}>
          <Moon className="size-4" /> Dark
          {theme === 'dark' ? <span className="ml-auto text-xs text-foreground-subtle">●</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('system')}>
          <Monitor className="size-4" /> System
          {theme === 'system' ? <span className="ml-auto text-xs text-foreground-subtle">●</span> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
