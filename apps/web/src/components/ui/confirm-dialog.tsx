'use client';

/**
 * Imperative confirm dialog. Replaces native window.confirm() with an in-app
 * modal that matches the rest of the UI.
 *
 * Usage:
 *   if (await confirmDialog({ title: 'Delete "Foo"?' })) {
 *     deleteFoo();
 *   }
 *
 *   if (
 *     await confirmDialog({
 *       title: 'Suspend this organisation?',
 *       body: "Members won't be able to sign in until you reactivate it.",
 *       confirmLabel: 'Suspend',
 *       destructive: true,
 *     })
 *   ) {
 *     suspend();
 *   }
 *
 * <ConfirmDialogRoot /> must be mounted once near the app root.
 */

import { useEffect, useState } from 'react';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input } from './input';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /**
   * When set, the confirm button stays disabled until the user types this exact
   * word (case-insensitive). Use for high-consequence actions, e.g.
   * `requireText: 'delete'` on org deletion.
   */
  requireText?: string;
}

type PendingRequest = { opts: ConfirmOptions; resolve: (ok: boolean) => void };

let present: ((req: PendingRequest) => void) | null = null;
const waiting: PendingRequest[] = [];

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req: PendingRequest = { opts, resolve };
    if (present) {
      present(req);
    } else if (typeof window !== 'undefined') {
      // Root hasn't mounted yet — fall back so nothing hangs at boot.
      resolve(window.confirm(`${opts.title}${opts.body ? `\n\n${opts.body}` : ''}`));
    } else {
      resolve(false);
    }
  });
}

export function ConfirmDialogRoot() {
  const [current, setCurrent] = useState<PendingRequest | null>(null);
  // Type-to-confirm input value; reset every time a new request is shown.
  const [typed, setTyped] = useState('');

  useEffect(() => {
    present = (req) => {
      if (current) waiting.push(req);
      else setCurrent(req);
    };
    return () => {
      present = null;
    };
  }, [current]);

  useEffect(() => {
    setTyped('');
  }, [current]);

  const close = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    const next = waiting.shift() ?? null;
    setCurrent(next);
  };

  const requireText = current?.opts.requireText;
  const textOk = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();

  return (
    <Dialog
      open={!!current}
      onOpenChange={(v) => {
        if (!v) close(false);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{current?.opts.title ?? ''}</DialogTitle>
          {current?.opts.body ? (
            <DialogDescription>{current.opts.body}</DialogDescription>
          ) : null}
        </DialogHeader>
        {requireText ? (
          <div className="space-y-1.5">
            <label htmlFor="confirm-require-text" className="text-sm text-foreground-muted">
              Type <span className="font-semibold text-foreground">{requireText}</span> to confirm
            </label>
            <Input
              id="confirm-require-text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && textOk) close(true);
              }}
              autoFocus
              autoComplete="off"
              placeholder={requireText}
            />
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {current?.opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            variant={current?.opts.destructive ? 'danger' : 'primary'}
            onClick={() => close(true)}
            disabled={!textOk}
            autoFocus={!requireText}
          >
            {current?.opts.confirmLabel ??
              (current?.opts.destructive ? 'Delete' : 'Confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
