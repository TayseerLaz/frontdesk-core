import { cn } from '@/lib/utils';

/**
 * AlignedLogo — Hader AI brand mark + wordmark.
 *
 * Component name is kept as `AlignedLogo` so the dozen-or-so imports
 * around the app don't need touching. Both variants render the source
 * PNGs through CSS mask-image so the actual fill is `currentColor` —
 * the parent's text color decides whether the mark reads as oxblood
 * (light surface), cream (dark hero), or anything else context-driven.
 *
 *   iconOnly = true  → /hader-icon.png        (chat-bubble-E mark)
 *   iconOnly = false → /hader-wordmark.png    (mark + "Hader AI" text)
 *
 * Native aspect ratios:
 *   icon:     2695  × 2702  ≈ 1:1
 *   wordmark: 6452  × 1272  ≈ 5.07:1
 */
export function AlignedLogo({
  className,
  iconOnly = false,
}: {
  className?: string;
  variant?: 'default' | 'mono';
  iconOnly?: boolean;
}) {
  if (iconOnly) {
    return (
      <span
        role="img"
        aria-label="Hader AI"
        className={cn('inline-block size-9 shrink-0 text-brand-500', className)}
        style={{
          backgroundColor: 'currentColor',
          // Prefix with /app — basePath is not auto-applied to URLs
          // inside inline style attributes, and at the root domain
          // /hader-icon.png falls through Caddy's try_files to the
          // marketing site's index.html.
          WebkitMaskImage: 'url(/app/hader-icon.png)',
          maskImage: 'url(/app/hader-icon.png)',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
        }}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label="Hader AI"
      // Default height is the Tailwind class h-9 (36px) — NOT an inline style —
      // so callers can shrink/grow it via className (e.g. h-6/h-7); twMerge
      // dedupes the conflicting h-* and the caller wins. The aspect-ratio keeps
      // the wordmark from squishing at any height.
      className={cn('inline-block h-9 text-brand-500', className)}
      style={{
        aspectRatio: '6452 / 1272',
        backgroundColor: 'currentColor',
        // Prefixed with /app for the same basePath reason as the
        // iconOnly branch above.
        WebkitMaskImage: 'url(/app/hader-wordmark.png)',
        maskImage: 'url(/app/hader-wordmark.png)',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'left center',
        maskPosition: 'left center',
      }}
    />
  );
}
