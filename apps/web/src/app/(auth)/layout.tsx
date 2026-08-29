import { brand } from '@/lib/brand';

// Two colours, deliberately literal. The theme tokens are bypassed here
// because brand-500 inverts in dark mode, and the auth shell must hold the
// same pairing on any system theme. Rebranding: change these two hexes (and
// the matching pair in app-shell.tsx) alongside the ramp in globals.css.
const BRAND_PANEL = '#11334d';
const BRAND_PANEL_INK = '#cddfee';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 flex flex-col overflow-y-auto"
      style={{ backgroundColor: BRAND_PANEL, color: BRAND_PANEL_INK }}
    >
      <header className="flex items-center justify-end px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://example.com/"
          className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#cddfee]/70 transition hover:bg-[#cddfee] hover:text-[#11334d]"
        >
          ← Back to site
        </a>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10 lg:px-14">
        <div className="flex w-full flex-col items-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500">
          {children}
        </div>
      </main>

      <footer
        className="hidden items-center px-14 pb-7 font-mono text-[12px] uppercase tracking-[0.18em] sm:flex"
        style={{ color: `${BRAND_PANEL_INK}80` }}
      >
        <span>{brand.name} · Portal</span>
      </footer>
    </div>
  );
}
