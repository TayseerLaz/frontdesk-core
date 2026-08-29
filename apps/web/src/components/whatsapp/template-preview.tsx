'use client';

import { Copy, ExternalLink, FileText, ImageIcon, Phone, Reply, Video } from 'lucide-react';
import { useState, type ReactNode } from 'react';

// A faithful WhatsApp-style preview of an approved message template — exactly
// how the message lands on the customer's phone (it's business→customer, so it
// renders as an INCOMING bubble: left-aligned, white, on the WhatsApp wallpaper).
// Driven by Meta's `components` array (HEADER / BODY / FOOTER / BUTTONS), with a
// graceful fallback to plain `bodyText` when components aren't available.

type Comp = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Replace {{1}},{{2}}… with the template's example values when present, else
// keep the token visible (highlighted) so it's clear it's a merge field.
function renderWithVars(text: string, examples: string[]): ReactNode {
  return text.split(/(\{\{\d+\}\})/g).map((part, i) => {
    const m = part.match(/^\{\{(\d+)\}\}$/);
    if (!m) return <span key={i}>{part}</span>;
    const ex = examples[Number(m[1]) - 1];
    return ex ? (
      <span key={i}>{ex}</span>
    ) : (
      <span key={i} className="rounded bg-brand-100 px-1 font-medium text-brand-700">
        {part}
      </span>
    );
  });
}

const BTN_ICON: Record<string, typeof Reply> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

// Render the real header image when we have a (freshly-signed) URL; fall back to
// the icon placeholder if there's no URL or it fails to load.
function ImageHeader({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="Header"
        className="mb-1.5 max-h-52 w-full rounded-md bg-black/5 object-contain dark:bg-white/10"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="mb-1.5 flex h-32 items-center justify-center rounded-md bg-black/5 text-foreground-subtle dark:bg-white/10">
      <ImageIcon className="size-8" />
    </div>
  );
}

export function TemplatePreview({
  components,
  bodyText,
}: {
  components: Comp[] | null;
  bodyText: string;
}) {
  const comps = components ?? [];
  const byType = (t: string) => comps.find((c) => str(c.type)?.toUpperCase() === t);
  const header = byType('HEADER');
  const body = byType('BODY');
  const footer = byType('FOOTER');
  const buttonsComp = byType('BUTTONS');

  const headerFormat = str(header?.format)?.toUpperCase();
  const headerText = str(header?.text);
  const headerMediaUrl = (header?.example as { header_handle?: string[] } | undefined)?.header_handle?.[0];
  const bodyResolved = str(body?.text) ?? bodyText ?? '';
  const bodyExamples = (body?.example as { body_text?: string[][] } | undefined)?.body_text?.[0] ?? [];
  const headerExamples =
    (header?.example as { header_text?: string[] } | undefined)?.header_text ?? [];
  const footerText = str(footer?.text);
  const buttons = (buttonsComp?.buttons as Comp[] | undefined) ?? [];

  return (
    // WhatsApp chat wallpaper.
    <div className="rounded-xl bg-[#efeae2] p-3 dark:bg-[#0b141a]">
      <div className="max-w-[88%]">
        {/* The incoming bubble (white, left-aligned, with the little corner tail). */}
        <div className="relative rounded-lg rounded-tl-none bg-white px-2.5 pb-1.5 pt-2 text-[14.5px] leading-snug text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
          {/* HEADER */}
          {header ? (
            headerFormat === 'TEXT' && headerText ? (
              <p className="mb-1 font-semibold">{renderWithVars(headerText, headerExamples)}</p>
            ) : headerFormat === 'IMAGE' ? (
              <ImageHeader url={headerMediaUrl} />
            ) : headerFormat === 'VIDEO' ? (
              <div className="mb-1.5 flex h-32 items-center justify-center rounded-md bg-black/5 text-foreground-subtle dark:bg-white/10">
                <Video className="size-8" />
              </div>
            ) : headerFormat === 'DOCUMENT' ? (
              <div className="mb-1.5 flex items-center gap-2 rounded-md bg-black/5 px-3 py-2.5 text-foreground-subtle dark:bg-white/10">
                <FileText className="size-6" />
                <span className="text-xs">Document</span>
              </div>
            ) : null
          ) : null}

          {/* BODY */}
          <p className="whitespace-pre-wrap break-words">
            {renderWithVars(bodyResolved, bodyExamples)}
          </p>

          {/* FOOTER */}
          {footerText ? (
            <p className="mt-1 text-[12.5px] text-[#667781] dark:text-[#8696a0]">{footerText}</p>
          ) : null}

          {/* timestamp, bottom-right inside the bubble (cosmetic) */}
          <span className="float-right ml-2 mt-1 select-none text-[11px] text-[#667781] dark:text-[#8696a0]">
            12:00
          </span>
          <div className="clear-both" />
        </div>

        {/* BUTTONS — WhatsApp renders these as tappable rows attached under the bubble. */}
        {buttons.length > 0 ? (
          <div className="mt-0.5 space-y-0.5">
            {buttons.map((b, i) => {
              const Icon = BTN_ICON[str(b.type)?.toUpperCase() ?? ''] ?? Reply;
              return (
                <div
                  key={i}
                  className="flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-[14px] font-medium text-[#0096de] shadow-sm dark:bg-[#202c33]"
                >
                  <Icon className="size-4" />
                  {str(b.text) ?? 'Button'}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
