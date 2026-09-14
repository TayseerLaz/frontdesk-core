import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * BrandLogo — the platform brand mark + wordmark.
 *
 * Component name is kept as `BrandLogo` so the dozen-or-so imports
 * around the app don't need touching. Both variants render the source
 * PNGs through CSS mask-image so the actual fill is `currentColor` —
 * the parent's text color decides whether the mark reads as brand-panel
 * (light surface), cream (dark hero), or anything else context-driven.
 *
 *   iconOnly = true  → /platform-icon.png        (chat-bubble-E mark)
 *   iconOnly = false → /platform-wordmark.png    (mark + "the platform" text)
 *
 * Native aspect ratios:
 *   icon:     512  × 512  ≈ 1:1
 *   wordmark: 1382 × 224  ≈ 6.17:1
 */
export function BrandLogo({
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
        aria-label={brand.name}
        className={cn('inline-block size-9 shrink-0 text-brand-500', className)}
        style={{
          backgroundColor: 'currentColor',
          // Prefix with /app — basePath is not auto-applied to URLs
          // inside inline style attributes, and at the root domain
          // /platform-icon.png falls through Caddy's try_files to the
          // marketing site's index.html.
          WebkitMaskImage: 'url(/app/platform-icon.png)',
          maskImage: 'url(/app/platform-icon.png)',
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
      aria-label={brand.name}
      // Default height is the Tailwind class h-9 (36px) — NOT an inline style —
      // so callers can shrink/grow it via className (e.g. h-6/h-7); twMerge
      // dedupes the conflicting h-* and the caller wins. The aspect-ratio keeps
      // the wordmark from squishing at any height.
      className={cn('inline-block h-9 text-brand-500', className)}
      style={{
        aspectRatio: '1382 / 224',
        backgroundColor: 'currentColor',
        // Prefixed with /app for the same basePath reason as the
        // iconOnly branch above.
        WebkitMaskImage: 'url(/app/platform-wordmark.png)',
        maskImage: 'url(/app/platform-wordmark.png)',
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
