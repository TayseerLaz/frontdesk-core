// Phase 8 / 1.2 — post-LLM provenance scanner.
//
// Walks an outbound bot reply and produces two side-by-side lists:
//
//   citations[]      — for every catalog item / FAQ / business-info field
//                      mentioned in the reply, a row linking it back to its
//                      source plus the snippet that triggered the match.
//
//   hallucinations[] — for every product-or-price-shaped phrase that doesn't
//                      match anything we surfaced to the LLM, a red-flag row
//                      so the admin can audit "the bot just invented this".
//
// Pure CPU; no DB calls; <50 ms for typical replies. Runs synchronously
// inside recordProvenance() before the row is persisted, so citations +
// hallucinations land on the same INSERT as the rest of the provenance.
//
// Design notes:
// • We can't trust the LLM to self-cite (it ignores soft prompts), so all
//   matching is deterministic regex / substring against the candidate set
//   we packed into the prompt.
// • A product cited via substring also matches the cart/price-shaped
//   hallucination patterns; `citedNames` is a per-scan suppression list to
//   keep us from double-flagging.
// • Hallucinations are scored "critical" when the match is unambiguously
//   product-shaped (cart action + price-shape), "warning" otherwise.

export interface Citation {
  type:
    | 'product'
    | 'service'
    | 'faq'
    | 'policy'
    | 'business_info'
    // Phase 8 / 1.5 — `bot_config` covers fields from the BotConfig record
    // (greeting, persona, etc.). The UI renders these with a /bot link.
    | 'bot_config'
    // Phase 8 / 1.6 — `customer_profile` covers values pulled from the
    // customer side of the conversation (their WhatsApp display name,
    // their phone number). NOT operator-editable; comes from Meta.
    | 'customer_profile';
  // The catalog row's UUID; null for fields without their own row
  // (e.g. business_info field-name citations, policy kinds, bot config).
  id: string | null;
  // Human-readable label for the UI.
  label: string;
  // The snippet from the reply that triggered the match (~60 chars).
  snippet: string;
  // 0-1 confidence in the match.
  confidence: number;
  // Free-form per-type metadata: price comparison, matched n-gram, etc.
  meta?: Record<string, unknown>;
}

export interface Hallucination {
  type:
    // Product-shaped phrase not present in the candidate catalog.
    | 'unknown_product'
    // Cited a price that drifts >2 % from the catalog row.
    | 'price_drift'
    // Time / address / contact pattern that doesn't match BusinessInfo.
    | 'unknown_business_info';
  matchedText: string;
  context: string;
  severity: 'critical' | 'warning';
  reason: string;
}

export interface ScanCandidates {
  products: Array<{
    id: string;
    name: string;
    sku: string;
    priceMinor: number | null;
    currency: string | null;
  }>;
  services: Array<{
    id: string;
    name: string;
    basePriceMinor: number | null;
    currency: string | null;
  }>;
  faqs: Array<{ id: string; question: string; answer: string }>;
  policies: Array<{ kind: string; title: string; content: string }>;
  biz: {
    legalName: string | null;
    websiteUrl: string | null;
    operatingHours: unknown;
    currency: string;
    // Operator-configured public menu / catalog URL. Set on /business-info.
    menuUrl: string | null;
  } | null;
  // BotConfig-derived candidate fields used by the scanner. Currently
  // just the configured greeting; other fields (custom personality,
  // languages) can be added if we want citations for them.
  config: {
    greeting: string | null;
  } | null;
  // The customer's WhatsApp display name (Meta-provided) + the
  // operator-set nickname if any. The scanner cites whichever appears
  // in the reply — this is how the greet-by-name path is attributed.
  customer: {
    whatsappName: string | null;
    operatorNickname: string | null;
  } | null;
}

export interface ScanResult {
  citations: Citation[];
  hallucinations: Hallucination[];
}

// Phase 8 / 1.7 — operator-curated suppression list (union of GLOBAL +
// per-org rows from `provenance_suppressions`). The scanner skips any
// flagged matchedText whose normalised form matches a phrase in here.
// Pre-normalised by the loader so the scanner stays pure-CPU.
export type SuppressionSet = ReadonlySet<string>;

export function normalisePhraseForSuppression(s: string): string {
  return normalize(s);
}

// ---------- helpers --------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Currency → (minorPerMajor, decimals). Mirrors formatMoney in bot-engine.ts.
function currencyMeta(currency: string | null): { minorPerMajor: number; decimals: number } {
  const code = (currency ?? 'USD').toUpperCase();
  const big3 = code === 'KWD' || code === 'BHD' || code === 'OMR' || code === 'JOD';
  return { minorPerMajor: big3 ? 1000 : 100, decimals: big3 ? 3 : 2 };
}

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor == null) return '';
  const { minorPerMajor, decimals } = currencyMeta(currency);
  return `${(minor / minorPerMajor).toFixed(decimals)} ${(currency ?? 'USD').toUpperCase()}`;
}

// Find the first case-insensitive, punctuation-tolerant occurrence of
// `needle` in `reply`. Returns the snippet (~60 chars, original casing).
function findSnippet(reply: string, needle: string, windowSize = 60): { index: number; snippet: string } | null {
  if (needle.trim().length === 0) return null;
  const nReply = normalize(reply);
  const nNeedle = normalize(needle);
  if (nNeedle.length < 2) return null;
  const idx = nReply.indexOf(nNeedle);
  if (idx < 0) return null;
  // Approximate the snippet from the ORIGINAL reply, not the normalized
  // copy — the admin UI shows what the customer actually saw.
  const ratio = reply.length / Math.max(nReply.length, 1);
  const origStart = Math.max(0, Math.floor(idx * ratio) - Math.floor(windowSize / 3));
  const origEnd = Math.min(
    reply.length,
    Math.ceil((idx + nNeedle.length) * ratio) + Math.floor((windowSize * 2) / 3),
  );
  const snippet = reply.slice(origStart, origEnd).replace(/\s+/g, ' ').trim();
  return { index: idx, snippet };
}

// All 3-grams from `text` built from words longer than 4 chars (skip
// fillers like "the", "and", "you"). Returned in source order so the
// caller can try them sequentially against a reply.
function candidateNgrams(text: string): string[] {
  const words = normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 4);
  if (words.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i + 3 <= words.length; i++) {
    out.push(words.slice(i, i + 3).join(' '));
  }
  return out;
}

// Find the first 3-gram from `body` that appears in `reply`. Returns the
// matched n-gram + the snippet from the reply, or null if none match.
function findMatchingNgram(
  reply: string,
  body: string,
): { ngram: string; snippet: string } | null {
  for (const ngram of candidateNgrams(body)) {
    const m = findSnippet(reply, ngram, 80);
    if (m) return { ngram, snippet: m.snippet };
  }
  return null;
}

// Find the price token associated with a product mention at `position`.
// Constrained to the SAME LINE so that in a multi-item bullet list like
//   - Blah Blah Milkshake, 1.000 KWD
//   - Enstein Milkshake,    0.150 KWD
// asking for the price of "Enstein Milkshake" doesn't bleed into the
// previous bullet's "1.000 KWD". Preference order:
//   1. Same-line FORWARD of `position` (matches "Name, PRICE" phrasings)
//   2. Same-line BACKWARD of `position` (matches "PRICE for Name")
function extractPriceNear(
  reply: string,
  position: number,
  currency: string | null,
): { rawText: string; minor: number } | null {
  const lineStart = Math.max(0, reply.lastIndexOf('\n', position - 1) + 1);
  const lineEndRaw = reply.indexOf('\n', position);
  const lineEnd = lineEndRaw < 0 ? reply.length : lineEndRaw;
  const forward = reply.slice(position, lineEnd);
  const backward = reply.slice(lineStart, position);

  const code = (currency ?? 'USD').toUpperCase();
  const codeRe = new RegExp(String.raw`\b(\d+(?:[.,]\d+)?)\s*${escapeRegex(code)}\b`, 'i');
  const symbolRe = /([$€£])\s*(\d+(?:[.,]\d+)?)/;

  const tryFind = (window: string): { rawText: string; numStr: string } | null => {
    const mCode = window.match(codeRe);
    if (mCode) return { rawText: mCode[0], numStr: mCode[1]! };
    const mSym = window.match(symbolRe);
    if (mSym) return { rawText: mSym[0], numStr: mSym[2]! };
    return null;
  };

  const hit = tryFind(forward) ?? tryFind(backward);
  if (!hit) return null;
  const major = parseFloat(hit.numStr.replace(',', '.'));
  if (!Number.isFinite(major)) return null;
  const { minorPerMajor } = currencyMeta(currency);
  return { rawText: hit.rawText, minor: Math.round(major * minorPerMajor) };
}

// True iff `frag` (a phrase pulled from the reply) is a substring-equivalent
// of any product/service name in the candidate set. Used to suppress
// hallucination false positives.
function fragmentMatchesAnyCandidate(
  fragment: string,
  c: ScanCandidates,
): boolean {
  const nFrag = normalize(fragment);
  if (nFrag.length < 2) return true;
  for (const p of c.products) {
    const np = normalize(p.name);
    if (np.length > 1 && (np.includes(nFrag) || nFrag.includes(np))) return true;
    // SKU match too — operator-typed SKUs sometimes appear in the reply.
    if (p.sku && nFrag === normalize(p.sku)) return true;
  }
  for (const s of c.services) {
    const ns = normalize(s.name);
    if (ns.length > 1 && (ns.includes(nFrag) || nFrag.includes(ns))) return true;
  }
  return false;
}

// Trim a captured fragment down to its leading Title-Case phrase, dropping
// trailing lowercase filler / numbers. Product names are Title Case, so
// "Waffle for 0.300" → "Waffle", "Oreo Milkshake now" → "Oreo Milkshake".
// This is what stops a noisy capture from failing the substring match against
// the real product name (the #1 false-positive class in the shadow replay).
function leadingTitlePhrase(frag: string): string {
  const m = frag.match(/^[A-Z][a-zA-Z'&-]*(?:\s+[A-Z][a-zA-Z'&-]*){0,3}/);
  return (m ? m[0] : frag).trim();
}

// ---------- main scanner --------------------------------------------------

export function scanReply(
  reply: string,
  c: ScanCandidates,
  suppressed?: SuppressionSet,
): ScanResult {
  // Helper closed over the optional suppression set. Returns true iff
  // the given text matches a phrase the operator has marked "not a
  // problem" — at which point the scanner drops the flag silently.
  const isSuppressed = (text: string): boolean => {
    if (!suppressed || suppressed.size === 0) return false;
    return suppressed.has(normalize(text));
  };
  const citations: Citation[] = [];
  const hallucinations: Hallucination[] = [];
  if (!reply || reply.trim().length === 0) return { citations, hallucinations };

  // Names we've already cited — used to suppress hallucination false
  // positives for the same phrase. Normalized form.
  const citedNames = new Set<string>();

  // ---- product citations ----
  for (const p of c.products) {
    const m = findSnippet(reply, p.name);
    if (!m) continue;
    citedNames.add(normalize(p.name));

    // Price extraction near the mention.
    const priceInfo = extractPriceNear(reply, m.index, p.currency ?? c.biz?.currency ?? null);
    const meta: Record<string, unknown> = { sku: p.sku, catalogPriceMinor: p.priceMinor };
    if (priceInfo) {
      meta.citedPrice = priceInfo.rawText;
      meta.citedPriceMinor = priceInfo.minor;
      if (p.priceMinor != null && p.priceMinor > 0) {
        const driftRatio = Math.abs(priceInfo.minor - p.priceMinor) / p.priceMinor;
        const matches = driftRatio <= 0.02; // ±2 %
        meta.priceMatchesDb = matches;
        if (!matches && !isSuppressed(priceInfo.rawText)) {
          hallucinations.push({
            type: 'price_drift',
            matchedText: priceInfo.rawText,
            context: m.snippet,
            severity: 'warning',
            reason: `Bot quoted ${priceInfo.rawText} for ${p.name}, catalog has ${formatMoney(p.priceMinor, p.currency)}`,
          });
        }
      }
    }

    citations.push({
      type: 'product',
      id: p.id,
      label: p.name,
      snippet: m.snippet,
      confidence: 0.95,
      meta,
    });
  }

  // ---- service citations ----
  for (const s of c.services) {
    const m = findSnippet(reply, s.name);
    if (!m) continue;
    citedNames.add(normalize(s.name));
    citations.push({
      type: 'service',
      id: s.id,
      label: s.name,
      snippet: m.snippet,
      confidence: 0.95,
      meta: { catalogPriceMinor: s.basePriceMinor },
    });
  }

  // ---- FAQ citations ----
  for (const f of c.faqs) {
    const hit = findMatchingNgram(reply, f.answer);
    if (!hit) continue;
    citations.push({
      type: 'faq',
      id: f.id,
      label: f.question,
      snippet: hit.snippet,
      confidence: 0.7,
      meta: { matchedPhrase: hit.ngram },
    });
  }

  // ---- policy citations ----
  for (const pol of c.policies) {
    const hit = findMatchingNgram(reply, pol.content);
    if (!hit) continue;
    citations.push({
      type: 'policy',
      id: null,
      label: `${pol.title} (${pol.kind})`,
      snippet: hit.snippet,
      confidence: 0.65,
      meta: { kind: pol.kind, matchedPhrase: hit.ngram },
    });
  }

  // ---- business-info citations ----
  if (c.biz) {
    if (c.biz.websiteUrl && reply.includes(c.biz.websiteUrl)) {
      citations.push({
        type: 'business_info',
        id: null,
        label: 'websiteUrl',
        snippet: c.biz.websiteUrl,
        confidence: 1.0,
      });
    }
    // Menu link from BusinessInfo.shopForm.menuUrl — appears verbatim in
    // replies to "what's on the menu" / "where can I order" / etc.
    if (c.biz.menuUrl && reply.includes(c.biz.menuUrl)) {
      citations.push({
        type: 'business_info',
        id: null,
        label: 'menuUrl',
        snippet: c.biz.menuUrl,
        confidence: 1.0,
        meta: { sourcePage: '/business-info', field: 'Menu link (optional)' },
      });
    }
    if (c.biz.legalName) {
      const m = findSnippet(reply, c.biz.legalName);
      if (m) {
        citations.push({
          type: 'business_info',
          id: null,
          label: 'legalName',
          snippet: m.snippet,
          confidence: 0.95,
        });
      }
    }
    // Weak signal: time-shaped tokens. Tells the admin the bot was
    // probably citing hours; the inline UI can render a side-by-side.
    const timeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm|AM|PM)\b/;
    const timeMatch = reply.match(timeRe);
    if (c.biz.operatingHours && timeMatch) {
      citations.push({
        type: 'business_info',
        id: null,
        label: 'operatingHours',
        snippet: timeMatch[0],
        confidence: 0.5,
        meta: { reason: 'Time-shaped token in reply' },
      });
    }
  }

  // ---- customer_profile citations ----
  // Customer's WhatsApp display name (or operator-set nickname) appears
  // in greetings when the greet-by-name fallback fires. We cite the
  // FIRST TOKEN since the bot-engine only uses the first word (avoids
  // form-letter "Dear Mr. Surname" awkwardness). Confidence is 1.0 —
  // the bot-engine literally injected this token into the reply.
  //
  // The snippet captured here is intentionally NARROW (≤30 chars) so
  // the admin UI doesn't display surrounding cart-add / price text as
  // if it came from the customer profile. Pre-fix we used the default
  // 60-char window which pulled "Hi Fadi, I've added Fawran to your
  // cart" into the citation — visually implying the customer profile
  // was the source of the Fawran add. Also: we suppress this citation
  // entirely on replies whose first 80 chars are clearly a product /
  // price line, so the name-detection doesn't dominate when the
  // operator should be looking at the product source instead.
  const replyLooksLikeProductOp = /(?:i(?:'ve)?\s+added|added|added to your cart|your order is|cart total|subtotal)/i.test(
    reply.slice(0, 100),
  );

  const pushCustomerProfileCitation = (
    label: 'WhatsApp display name' | 'Customer nickname (operator-set)',
    first: string,
    sourceDescription: string,
  ) => {
    if (first.length <= 1) return;
    // Suppress when the reply is dominated by a product / price line —
    // the real source for those phrases is a `product` citation that
    // the scanner already adds elsewhere; the name match here is a
    // spurious greeting-detector match and would mislead the operator.
    if (replyLooksLikeProductOp) {
      // Allow the citation ONLY when the name appears BEFORE any
      // product/price text — e.g. "Hi Fadi, ..." → the name still
      // earns its citation; the snippet stays tight.
      const nameIdx = reply.toLowerCase().indexOf(first.toLowerCase());
      const productIdx = reply.search(/(?:i(?:'ve)?\s+added|added\s+to|your order)/i);
      if (nameIdx < 0 || (productIdx >= 0 && nameIdx >= productIdx)) return;
    }
    const m = findSnippet(reply, first, 30); // narrow window
    if (!m) return;
    citations.push({
      type: 'customer_profile',
      id: null,
      label,
      snippet: m.snippet,
      confidence: 1.0,
      meta: { value: first, sourceDescription },
    });
  };

  if (c.customer?.whatsappName) {
    const first = c.customer.whatsappName.trim().split(/\s+/)[0] ?? '';
    pushCustomerProfileCitation(
      'WhatsApp display name',
      first,
      "Customer's WhatsApp profile (Meta-provided, not editable)",
    );
  } else if (c.customer?.operatorNickname) {
    // Fallback: when the customer has no WhatsApp display name, the
    // bot uses the nickname the operator typed into the thread row.
    const first = c.customer.operatorNickname.trim().split(/\s+/)[0] ?? '';
    pushCustomerProfileCitation(
      'Customer nickname (operator-set)',
      first,
      'Nickname an operator typed on this thread',
    );
  }

  // ---- bot_config citations ----
  // Greeting: BotConfig.greeting (set on /bot → Greeting section). Cited
  // when the reply opens with a substring of the configured greeting OR
  // (post-fallback) the configured greeting prefix appears anywhere in
  // the first 120 chars. Confidence is high because the bot-engine
  // greeting fallback often pastes the operator's exact wording in.
  if (c.config?.greeting) {
    const greeting = c.config.greeting.trim();
    if (greeting.length >= 4) {
      const head = reply.slice(0, Math.max(160, greeting.length + 60));
      const greetingHead = greeting.slice(0, Math.min(greeting.length, 40));
      if (normalize(head).includes(normalize(greetingHead))) {
        citations.push({
          type: 'bot_config',
          id: null,
          label: 'greeting',
          snippet: greeting.slice(0, 120),
          confidence: 0.9,
          meta: { sourcePage: '/bot', field: 'Greeting' },
        });
      }
    }
  }

  // ---- hallucination scan ----

  // The customer's own name (and operator nickname) frequently sits right
  // before a total in cart confirmations ("I'll put this under Tayseer, total
  // …") — the price-proximity pattern grabbed it as an "unknown product". Build
  // a suppression set of their name tokens so we never flag the customer's name.
  const customerTokens = new Set<string>();
  for (const nm of [c.customer?.whatsappName, c.customer?.operatorNickname]) {
    if (!nm) continue;
    customerTokens.add(normalize(nm));
    const first = nm.trim().split(/\s+/)[0];
    if (first) customerTokens.add(normalize(first));
  }
  const isCustomerName = (t: string): boolean => customerTokens.has(normalize(t));

  // Pattern 1: cart actions — "added one Oreo Milkshake" / "removed 2x foo"
  const cartActionRe =
    /(?:added|i(?:'ve)?\s+added|i\s+added|removed)\s+(?:one|two|three|four|five|\d+)\s*(?:×|x)?\s+([A-Z][^\n.;,]{2,60})/gi;
  for (const m of reply.matchAll(cartActionRe)) {
    const frag = leadingTitlePhrase((m[1] ?? '').trim());
    if (!frag) continue;
    if (fragmentMatchesAnyCandidate(frag, c)) continue;
    if (citedNames.has(normalize(frag))) continue;
    if (isCustomerName(frag)) continue;
    if (isSuppressed(frag)) continue;
    hallucinations.push({
      type: 'unknown_product',
      matchedText: frag,
      context: m[0].slice(0, 120),
      severity: 'critical',
      reason: 'Cart action references an item not in the candidate catalog',
    });
  }

  // Pattern 2: price-proximity. Two passes:
  //   (a) Find every price token (digits + currency code).
  //   (b) Look back up to 60 chars (or to the previous newline) for the
  //       RIGHTMOST capitalised noun phrase and treat that as the
  //       referenced item. Filters out common verbs ("Want", "Try", etc.)
  //       so we don't mis-blame the upsell verb instead of the noun.
  const currency = c.biz?.currency;
  if (currency) {
    const priceTokenRe = new RegExp(
      String.raw`\b(\d+(?:[.,]\d+)?)\s*${escapeRegex(currency)}\b`,
      'gi',
    );
    for (const m of reply.matchAll(priceTokenRe)) {
      const priceIdx = m.index!;
      const lineStart = Math.max(0, reply.lastIndexOf('\n', priceIdx - 1) + 1);
      const winStart = Math.max(lineStart, priceIdx - 60);
      const win = reply.slice(winStart, priceIdx);

      // Rightmost capitalised 1-3 word phrase in the window.
      const capRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/g;
      let lastCap: RegExpExecArray | null = null;
      let next: RegExpExecArray | null;
      while ((next = capRe.exec(win)) !== null) {
        lastCap = next;
      }
      if (!lastCap) continue;
      const frag = lastCap[1]!.trim();
      // Stoplist — capitalised tokens that are NEVER product names, even
      // when they appear right before a price. Three groups:
      //   1. Verbs / interjections / greetings (sentence-openers)
      //   2. Order-summary labels (Subtotal, Total, Delivery, …) —
      //      ALWAYS precede a price in a cart-confirmation reply and
      //      were the #1 source of false-positive hallucinations.
      //   3. Currency codes (KWD, USD, …) — the regex's capitalised-
      //      phrase matcher treats them as words. Without this entry
      //      a confirmation like "Subtotal 0.150 KWD, delivery 0.000
      //      KWD" flags KWD itself as an unknown product.
      const stop = new Set([
        // verbs / interjections
        'I', 'You', 'We', 'Hi', 'Hey', 'Hello', 'Welcome', 'Want', 'Try', 'Get',
        'Add', 'Order', 'Pick', 'Have', 'Take', 'Need', 'Yes', 'No', 'Sure',
        'Okay', 'Great', 'Perfect', 'Thanks', 'Thank', 'Sorry', 'The', 'Just',
        'Got', 'Done', 'Cool', 'Awesome', 'Lovely', 'Nice', 'Excellent',
        // prepositions / question-words / sentence openers that begin a line
        // containing a price ("For max protein, …", "It's plain vanilla for …")
        'For', 'It', 'About', 'From', 'When', 'Where', 'What', 'Which', 'If',
        'Why', 'How', 'Who', 'While', 'Since', 'Because', 'After', 'Before',
        // pronouns / determiners / openers that begin a sentence containing a
        // price ("Your subtotal is …", "That comes to …")
        'Your', 'My', 'Our', 'Their', 'His', 'Her', 'Its', 'This', 'That',
        'These', 'Those', 'There', 'So', 'And', 'With', 'Please', 'Would',
        'Could', 'Also', 'Then', 'Here', 'Now', 'Let', 'Well',
        // order-summary labels
        'Subtotal', 'Total', 'Grandtotal', 'Tax', 'Vat', 'Fee', 'Fees',
        'Delivery', 'Shipping', 'Discount', 'Discounts', 'Service', 'Tip',
        'Charge', 'Surcharge', 'Refund', 'Credit', 'Balance', 'Amount',
        'Price', 'Quantity', 'Qty',
        // ISO 4217 codes for currencies we support today + common ones. The
        // MENA set matters: LBP/IQD/LYD/TND/etc. followed the price token in
        // real replies and were flagged as "products" (e.g. "…150000.00 LBP").
        'USD', 'EUR', 'GBP', 'KWD', 'BHD', 'OMR', 'JOD', 'AED', 'SAR',
        'QAR', 'EGP', 'JPY', 'CNY', 'INR', 'TRY', 'CHF', 'CAD', 'AUD',
        'LBP', 'IQD', 'LYD', 'TND', 'MAD', 'DZD', 'YER', 'SYP', 'SDG', 'PKR',
        // size / quantity / descriptor words — these sit next to a price
        // ("Mango Ice Cream (Small), 0.085 KWD") but are qualifiers, not
        // standalone products; the real product is matched separately.
        'Small', 'Medium', 'Large', 'Big', 'Baby', 'Mini', 'Regular', 'Kids',
        'Kid', 'Single', 'Double', 'Triple', 'Extra', 'Half', 'Full', 'Fresh',
        'Hot', 'Cold', 'Iced', 'Spicy', 'Sweet', 'Sour', 'Nuts', 'Combo', 'Box',
        'Litre', 'Liter', 'Litres', 'Liters', 'Ml', 'Piece', 'Pieces', 'Pcs',
        // menu-structure headers — a list reply groups items under headings
        // ("Signature Drops:", "Popular Picks:") that precede a price line and
        // were flagged as products.
        'Signature', 'Signatures', 'Special', 'Specials', 'Popular', 'Featured',
        'New', 'Classic', 'Classics', 'Favorite', 'Favorites', 'Menu', 'Picks',
        'Pick', 'Options', 'Option', 'Selection', 'Bestseller', 'Recommended',
        'Drops', 'Sides', 'Side', 'Mains', 'Main', 'Starters', 'Starter',
        'Desserts', 'Dessert', 'Drinks', 'Drink', 'Beverages', 'Beverage',
        'Extras', 'Toppings', 'Topping', 'Here', 'Based',
        // prep / quality descriptors — adjectives, not products. NB: words that
        // are real product-name components for some tenants (Protein, Lean,
        // Fresh...) are deliberately NOT here — a real product is matched by
        // fragmentMatchesAnyCandidate, and stoplisting them could mask a real
        // hallucination that happens to start with one.
        'Freshly', 'Bottled', 'Homemade', 'Grilled', 'Fried', 'Baked', 'Roasted',
        'Crispy', 'Creamy', 'Loaded', 'Premium', 'Organic', 'Natural',
        // past-participle / descriptor words that lead a clause ending in a price
        // in elaborate replies ("Priced at 5.00 USD", "Rich and creamy for …") —
        // the better models write these, and they were mis-read as product names.
        'Priced', 'Rich', 'Served', 'Topped', 'Filled', 'Stuffed', 'Packed',
        'Seasoned', 'Marinated', 'Smoked', 'Toasted', 'Blended', 'Whipped',
        'Layered', 'Coated', 'Glazed', 'Garnished', 'Comes', 'Includes',
        'Featuring', 'Made', 'Perfectly', 'Deliciously', 'Generously',
      ]);
      if (stop.has(frag.split(/\s+/)[0]!)) {
        // Common opener captured — fall back to scanning ALL phrases and
        // pick the last non-stoplisted one.
        capRe.lastIndex = 0;
        const all: string[] = [];
        let next2: RegExpExecArray | null;
        while ((next2 = capRe.exec(win)) !== null) all.push(next2[1]!);
        const filtered = all.filter((p) => !stop.has(p.split(/\s+/)[0]!));
        const replacement = filtered[filtered.length - 1];
        if (!replacement) continue;
        const rfrag = replacement.trim();
        if (fragmentMatchesAnyCandidate(rfrag, c)) continue;
        if (citedNames.has(normalize(rfrag))) continue;
        if (isCustomerName(rfrag)) continue;
        if (isSuppressed(rfrag)) continue;
        hallucinations.push({
          type: 'unknown_product',
          matchedText: rfrag,
          context: reply.slice(winStart, priceIdx + m[0].length).trim(),
          severity: 'critical',
          reason: 'Price-adjacent phrase references an item not in the candidate catalog',
        });
        continue;
      }
      if (fragmentMatchesAnyCandidate(frag, c)) continue;
      if (citedNames.has(normalize(frag))) continue;
      if (isCustomerName(frag)) continue;
      if (isSuppressed(frag)) continue;
      hallucinations.push({
        type: 'unknown_product',
        matchedText: frag,
        context: reply.slice(winStart, priceIdx + m[0].length).trim(),
        severity: 'critical',
        reason: 'Price-adjacent phrase references an item not in the candidate catalog',
      });
    }
  }

  return { citations, hallucinations };
}
