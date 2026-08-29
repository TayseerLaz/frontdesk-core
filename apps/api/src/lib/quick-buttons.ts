// F11 — operator-configured quick buttons (roadmap 2026-08-26).
//
// Pure logic only: defensively parse the BotConfig.customButtons JSONB, merge
// configured always-on buttons into a reply's button set, and match an inbound
// tap against a configured auto-reply. NO env/db imports — this file runs in
// the pure HARD gate (test/pure/quick-buttons.test.ts).
//
// Why this exists at the engine level: gpt-4o-mini drops prompt-level button
// instructions (see [[feedback_bot_engine_directives]] — soft "also do X"
// rules are unreliable; configured strings must be enforced by deterministic
// post-process). The owner decided 2026-08-26 that configured buttons WIN the
// slots over the model's own suggestions.

export interface CustomButton {
  /** Tappable label. WhatsApp caps interactive button titles at 20 chars. */
  label: string;
  /** Optional canned answer: when the customer taps (or types) the label,
      this text is sent deterministically and the LLM is skipped. */
  replyText: string | null;
  /** Append this button to every AI reply (except handoff turns). */
  always: boolean;
}

export const MAX_CUSTOM_BUTTONS = 3;
export const MAX_BUTTON_LABEL_CHARS = 20;

/** Defensive parse of the JSONB column — never throws, never trusts shape. */
export function parseCustomButtons(raw: unknown): CustomButton[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomButton[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const labelRaw = (item as { label?: unknown }).label;
    const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
    // Length is counted in code points, not UTF-16 units, so a label ending in
    // an emoji (e.g. "Place an order 🛍") isn't unfairly rejected.
    if (!label || [...label].length > MAX_BUTTON_LABEL_CHARS) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const replyRaw = (item as { replyText?: unknown }).replyText;
    const replyText =
      typeof replyRaw === 'string' && replyRaw.trim().length > 0 ? replyRaw.trim() : null;
    out.push({ label, replyText, always: (item as { always?: unknown }).always === true });
    if (out.length >= MAX_CUSTOM_BUTTONS) break;
  }
  return out;
}

/**
 * Decide the button set a reply carries. Policy (owner amendment 2026-08-30,
 * supersedes the original "configured buttons win the slots"):
 *   • When the MODEL emitted its own [BUTTONS:] marker, the model's choice is
 *     authoritative — the AI decides what fits the moment. Configured buttons
 *     reach it as a palette in the prompt, not by force-merging here.
 *   • When the model offered nothing, configured always-on buttons come first
 *     and the caller's deterministic defaults fill the rest.
 *   • The button the customer JUST tapped (their inbound text equals a label)
 *     is never shown again on the direct reply — answering "Talk to an agent"
 *     with another "Talk to an agent" button reads like a loop.
 * Case-insensitive dedupe throughout.
 */
export function mergeQuickButtons(
  replyButtons: string[],
  configured: CustomButton[],
  opts: { cap?: number; modelChose?: boolean; justPressed?: string | null } = {},
): string[] {
  const cap = opts.cap ?? 3;
  const pressed = (opts.justPressed ?? '').trim().toLowerCase();
  const source = opts.modelChose
    ? replyButtons
    : [...configured.filter((b) => b.always).map((b) => b.label), ...replyButtons];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of source) {
    const label = raw.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key) || key === pressed) continue;
    seen.add(key);
    merged.push(label);
  }
  return merged.slice(0, cap);
}

/**
 * Deterministic tap handling: an interactive-button tap arrives as inbound
 * text equal to the button title (typing the label by hand counts too).
 * Returns the configured canned answer, or null to fall through to the LLM.
 * Long inbound text never matches — a sentence that merely CONTAINS a label
 * is a real message, not a tap.
 */
export function matchButtonReply(
  inbound: string | null | undefined,
  configured: CustomButton[],
): string | null {
  const text = (inbound ?? '').trim().toLowerCase();
  if (!text || [...text].length > MAX_BUTTON_LABEL_CHARS + 4) return null;
  for (const b of configured) {
    if (b.replyText && b.label.trim().toLowerCase() === text) return b.replyText;
  }
  return null;
}
