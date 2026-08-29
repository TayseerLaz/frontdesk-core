'use client';

import { LogOut, Settings, User } from 'lucide-react';
import Link from 'next/link';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '@/lib/session';
import { fullName, initials } from '@/lib/utils';

import { ThemeToggle } from '../theme-toggle';

import { NotificationsBell } from './notifications-bell';
import { StatusStrip } from './status-strip';

export function TopBar() {
  const { session, signOut } = useSession();
  if (!session) return null;

  const { user } = session;

  return (
    <div className="flex flex-1 items-center justify-between gap-3">
      {/* Org switcher removed — switch orgs via the ⌘K command palette. */}
      <div className="flex min-w-0 items-center gap-1">
        <StatusStrip />
      </div>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <NotificationsBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 px-1.5">
              <Avatar className="size-7">
                <AvatarFallback>{initials(user.firstName, user.lastName, user.email)}</AvatarFallback>
              </Avatar>
              <span className="hidden text-sm font-medium sm:inline">
                {fullName(user.firstName, user.lastName, user.email)}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-medium">{fullName(user.firstName, user.lastName, user.email)}</span>
                <span className="text-xs font-normal text-foreground-subtle">{user.email}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/profile">
                <User className="size-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
