// Markdown → channel-native text normalization.
//
// gpt-4o-mini writes standard Markdown: **bold**, __bold__, ## headings,
// ***bold-italic***. None of that renders on our messaging channels:
//   - WhatsApp bold is a SINGLE asterisk (*bold*), italic _italic_,
//     strike ~strike~. Markdown's ** and ## show as literal characters.
//   - Messenger / Instagram DMs render NO markup at all — everything is
//     plain text, so every marker leaks.
//   - Voice replies are read aloud (TTS), so markers must be stripped to
//     plain prose or they'd be spoken / mangled.
//
// This runs as the last text transform before send. 'whatsapp' maps bold
// to WhatsApp's single-asterisk syntax; 'plain' strips all emphasis.
//
// Bullet lists (`- item`, `1. item`) are intentionally left alone — WhatsApp
// renders them and they read fine everywhere else. Line-start `* item`
// bullets are preserved too (the asterisk-strip requires non-space on both
// sides, which a bullet never has).

export type MarkdownMode = 'whatsapp' | 'plain';

// Bold content must not start/end with whitespace and must be non-empty —
// mirrors Markdown's own rule and avoids eating "a ** b" style stray pairs.
const BOLD_INNER = '(\\S(?:[\\s\\S]*?\\S)?)';

export function normalizeMarkdownForChannel(text: string, mode: MarkdownMode): string {
  if (!text) return text;
  const bold = mode === 'whatsapp' ? '*$1*' : '$1';
  let t = text;

  // ATX headings: "## Title" / "### Title" (optional trailing #'s) → emphasise
  // (WhatsApp) or drop the hashes (plain). Anchored to line start.
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, mode === 'whatsapp' ? '*$1*' : '$1');

  // Collapse bold-italic (3+ asterisks) to bold so the next rule catches it.
  t = t.replace(/\*{3,}/g, '**');

  // **bold** and __bold__ → channel bold / plain.
  t = t.replace(new RegExp(`\\*\\*${BOLD_INNER}\\*\\*`, 'g'), bold);
  t = t.replace(new RegExp(`(?<![A-Za-z0-9_])__${BOLD_INNER}__(?![A-Za-z0-9_])`, 'g'), bold);

  // Plain channels: also strip single-asterisk *emphasis* (WhatsApp keeps it —
  // it's valid bold there). Requires non-space neighbours so line-start
  // "* item" bullets and lone asterisks are untouched.
  if (mode === 'plain') {
    t = t.replace(/(?<![A-Za-z0-9*])\*(\S(?:[^*\n]*?\S)?)\*(?![A-Za-z0-9*])/g, '$1');
  }

  // Any leftover run of 2+ asterisks is never valid on these channels (usually
  // an orphaned marker from a truncated reply) — remove it so it never leaks.
  t = t.replace(/\*{2,}/g, '');

  return t;
}
