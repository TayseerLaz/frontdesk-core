// Deterministic link selection for the ultra plan. Given the classified
// intent + the business's own URLs, decide which link(s) to surface and
// when — WITHOUT trusting the LLM to remember to paste them. The
// orchestration layer appends these to the reply only when the model
// didn't already include them. This is the deterministic backstop for the
// bot-engine lesson that soft "send the link" directives get dropped.

import type { BotIntent } from './intent.js';

export interface LinkCandidate {
  kind: 'menu' | 'website' | 'location' | 'booking' | 'catalog' | 'contact';
  label: string;
  url: string;
}

export interface LinkSources {
  menuUrl?: string | null;
  websiteUrl?: string | null;
  bookingUrl?: string | null;
  catalogUrl?: string | null;
  // First primary location's maps / address URL, if any.
  locationUrl?: string | null;
  // Primary contact channel that is itself a URL (e.g. wa.me, Instagram).
  contactUrl?: string | null;
}

// Pick the links that match the intent, in priority order. The caller
// decides how many to actually append (usually 1).
export function selectLinks(intent: BotIntent, src: LinkSources): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const push = (kind: LinkCandidate['kind'], label: string, url?: string | null) => {
    if (url && /^https?:\/\//i.test(url)) out.push({ kind, label, url });
  };

  switch (intent) {
    case 'order':
      push('menu', 'Menu', src.menuUrl);
      push('catalog', 'Catalogue', src.catalogUrl);
      push('website', 'Website', src.websiteUrl);
      break;
    case 'booking':
      push('booking', 'Book here', src.bookingUrl);
      push('website', 'Website', src.websiteUrl);
      break;
    case 'question':
      // Location questions get the map first; otherwise the website/menu.
      push('location', 'Location', src.locationUrl);
      push('website', 'Website', src.websiteUrl);
      push('menu', 'Menu', src.menuUrl);
      break;
    case 'support':
      push('contact', 'Contact us', src.contactUrl);
      break;
    case 'smalltalk':
    case 'other':
    default:
      break;
  }
  return out;
}

// Append the top-priority not-yet-present link to a reply. Returns the
// (possibly unchanged) reply. The deterministic backstop the LLM can't skip.
export function appendRelevantLink(reply: string, candidates: LinkCandidate[]): string {
  if (!reply || candidates.length === 0) return reply;
  const top = candidates.find((c) => !reply.includes(c.url));
  if (!top) return reply; // every candidate is already in the reply
  return `${reply.trimEnd()}\n\n${top.url}`;
}
