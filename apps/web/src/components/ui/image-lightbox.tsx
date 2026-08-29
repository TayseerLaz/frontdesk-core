'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * Click-to-zoom image viewer. Controlled: pass the image `src` to open it,
 * `null` to keep it closed. Closes on the backdrop / X / Esc. Reused anywhere
 * a thumbnail should pop up full-size (catalog gallery, inbox media, …).
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string | null;
  alt?: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!src}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-4xl border-0 bg-transparent p-0 shadow-none">
        <DialogTitle className="sr-only">Image preview</DialogTitle>
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ''}
            className="mx-auto max-h-[85vh] w-auto rounded-lg object-contain"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
