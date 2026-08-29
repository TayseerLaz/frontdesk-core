# Brand assets

Swap these FILES. Never change the paths — code references
`/brand/wordmark.png` and `/brand/icon.png` via `brand.logoPath` / `brand.iconPath`.

| File           | Used for                          | Recommended size |
|----------------|-----------------------------------|------------------|
| `wordmark.png` | Sidebar + auth screens            | 512 × 128 (transparent) |
| `icon.png`     | Square mark, social card fallback | 512 × 512 |

PWA icons live in `../icons/` (`icon-32`, `icon-192`, `icon-512`,
`apple-touch-icon`) and are referenced by the generated manifest route at
`src/app/manifest.webmanifest/route.ts`.
