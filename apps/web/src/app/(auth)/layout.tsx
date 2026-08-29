// Two colours, period — bypassing the theme tokens because brand-500
// flips to Signal Red in dark mode. These literal hexes lock the
// auth shell to the brand-book pairing regardless of system theme.
const OXBLOOD = '#360516';
const SAND = '#cfc0a9';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 flex flex-col overflow-y-auto"
      style={{ backgroundColor: OXBLOOD, color: SAND }}
    >
      <header className="flex items-center justify-end px-6 py-6 sm:px-10 lg:px-14">
        <a
          href="https://hader.ai/"
          className="rounded-md px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[#cfc0a9]/70 transition hover:bg-[#cfc0a9] hover:text-[#360516]"
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
        style={{ color: `${SAND}80` }}
      >
        <span>Hader AI · Portal</span>
      </footer>
    </div>
  );
}
