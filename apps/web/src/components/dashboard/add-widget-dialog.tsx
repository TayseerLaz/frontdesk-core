'use client';

import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { useSession } from '@/lib/session';

import { useEditMode } from './edit-mode-context';
import { WIDGETS_BY_ID, type WidgetId } from './widget-registry';

// The "widget bank" the operator asked for: a dialog that lists every
// available widget not currently on the dashboard, each with an ADD
// pill. Removing a widget happens inline on the widget itself (the
// KEEP pill), so this dialog only handles the inverse direction.

export function AddWidgetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { layout } = useEditMode();
  const { session } = useSession();
  const disabledFeatures = session?.organization?.disabledFeatures ?? [];
  const isSuperAdmin = !!session?.user.isSuperAdmin;
  // Don't offer widgets for features this tenant doesn't have, or admin-only
  // widgets to a regular tenant.
  const hidden = layout.hidden.filter((id) => {
    const def = WIDGETS_BY_ID[id as WidgetId];
    if (def?.adminOnly && !isSuperAdmin) return false;
    return !def?.feature || !disabledFeatures.includes(def.feature);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add widgets</DialogTitle>
          <DialogDescription>
            Pick anything you want back on your dashboard. Remove a widget anytime by
            clicking its KEEP pill while editing.
          </DialogDescription>
        </DialogHeader>
        {hidden.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-foreground-muted">
            Every widget is already on your dashboard.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {hidden.map((id) => {
              const def = WIDGETS_BY_ID[id as WidgetId];
              if (!def) return null;
              const Icon = def.icon;
              return (
                <li
                  key={def.id}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 transition hover:border-brand-300 hover:bg-brand-50/40"
                >
                  <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-50">
                    <Icon className="size-4 text-brand-500" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{def.title}</p>
                    <p className="mt-0.5 text-xs text-foreground-subtle">{def.description}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => layout.add(def.id)}
                    className="inline-flex items-center gap-1 rounded-full px-3 text-[10px] font-bold uppercase tracking-wider"
                  >
                    <Plus className="size-3" /> ADD
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter className="justify-between sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => layout.reset()}>
            Reset to defaults
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
