// Stateful-cart helper. The bot's "[CART:]" marker is fragile —
// GPT-4o-mini sometimes drops items from it on long carts — so we
// instead track the cart as it builds, by parsing the bot's own
// reply text for "added N× <product>" lines and persisting items
// into a `status='draft'` Cart row in real time. At confirmation
// the draft is promoted to a real cart and the marker's items are
// IGNORED. Outcome: cart contents always match what the bot
// actually agreed to add.
//
// Same parsing also powers the auto-image fix — for each parsed
// add we inject [IMAGE: <sku>] into the reply so the existing
// image-send pipeline fires even when the LLM forgot the marker.

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: number | null;
}

export interface ParsedAdd {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
}

// Detect the bot's "I've added N× <name>" / "added N <name>" lines.
// The bot is multilingual so we match Arabic ("أضفت") + English variants.
// We pull the integer quantity + the rest of the line for fuzzy product
// matching against the catalog (the LLM sometimes paraphrases — "Oreo
// Milkshake (vanilla)" — so exact-match on name doesn't cut it).
// NOTE: the quantity group is OPTIONAL on the verb-anchored patterns
// (English "added", Arabic "أضفت"). The bot frequently confirms a
// single-item add WITHOUT a number — "أضفت Waffle بـ 0.300 KWD" /
// "Added Mango Ice Cream" — and an earlier version of these patterns
// REQUIRED a digit, so those confirmations parsed to nothing, the draft
// cart stayed empty, and checkout silently fell back to the unreliable
// [CART:] marker (which drops items). Missing quantity now defaults to 1.
// The bare "N× X" running-total pattern keeps its REQUIRED digit — making
// it optional there would match almost any sentence.
const ADD_PATTERNS = [
  // English: "Got it — 4× Oreo …", "I've added 1× Oreo …", "Added 4 Oreo …",
  // and the quantity-less "Added Oreo …" / "I've added Oreo Milkshake …".
  /(?:i(?:'ve|\s+have)?\s+added|got\s+it\s*[—\-,]?\s*|added)\s+(?:(\d{1,3})\s*[x×]?\s+)?([^\n.;]{2,80})/gi,
  // English: "4× Oreo Milkshake at 0.150 KWD" (running-total line variant)
  /\b(\d{1,3})\s*[x×]\s+([a-z][^.\n;]{2,80})/gi,
  // Arabic: "أضفت 4× Oreo Milkshake", "تمت إضافة X", and the quantity-less
  // "أضفت Waffle بـ 0.300 KWD".
  /(?:أضفت|أَضَفْتُ|تمت\s+إضافة)\s+(?:(\d{1,3})\s*[x×]?\s+)?([^\n.؛.]{2,80})/g,
];

// Signals that a reply is CONFIRMING a cart add / showing an order summary —
// used to gate the bullet-list pass so a plain MENU listing ("here are our
// options: - X - Y") is never mistaken for cart additions. Must be present in
// the reply before any bullet line is treated as an add.
const CART_CONFIRM_HEADER_RE =
  /(تمت?\s*(?:إضافة|اضافة)|أضفت|added to (?:your )?(?:cart|order)|added the following|i'?ve added|here'?s your order|order summary|ملخص الطلب|الطلب الحالي|طلبك)/i;

// Payment-method words customers say in response to "how would you
// like to pay?". These must NEVER be matched as products even if the
// catalog accidentally contains a phonetically-similar item — a real
// failure-mode in prod: customer typed "fawran" (Kuwaiti instant-pay)
// and the parser matched "Farouhah Frappe" as the product. We check
// the customer's most-recent inbound message + the bot's reply BEFORE
// running product extraction, and short-circuit when one of these
// keywords is the dominant content.
//
// Country-agnostic by design — the platform serves merchants on every
// continent. Adding a new market typically means adding one or two
// rails here (e.g. PromptPay for Thailand, Yape for Peru). When in
// doubt, add it: false positives here only mean "this turn doesn't
// auto-add to cart", which fails closed — operators can still
// intervene from the inbox.
const PAYMENT_METHOD_WORDS: readonly string[] = [
  // Card networks (global)
  'visa', 'mastercard', 'master card', 'amex', 'american express',
  'discover', 'jcb', 'unionpay', 'rupay', 'troy',
  // Digital wallets (global)
  'apple pay', 'applepay', 'google pay', 'googlepay', 'samsung pay',
  'wechat pay', 'alipay', 'paypal', 'venmo', 'cash app', 'cashapp',
  'zelle',
  // Gulf / MENA instant-pay
  'knet', 'k-net', 'knetpay', 'mada', 'benefit', 'benefitpay',
  'fawran', 'sadad', 'stc pay', 'urpay',
  // South / SE Asia
  'upi', 'paytm', 'razorpay', 'phonepe', 'gpay', 'bhim',
  'grabpay', 'gcash', 'dana', 'ovo', 'truemoney', 'promptpay',
  // Europe
  'ideal', 'sepa', 'sofort', 'klarna', 'bizum', 'blik',
  'multibanco', 'mb way', 'swish', 'vipps', 'mobilepay',
  // LATAM
  'pix', 'oxxo', 'boleto', 'mercado pago', 'mercadopago',
  'yape', 'plin',
  // Africa
  'm-pesa', 'mpesa', 'mtn momo', 'airtel money', 'flutterwave',
  'paystack',
  // Gateways / processors
  'myfatoorah', 'tap', 'tabby', 'tamara', 'paymob', 'checkout.com',
  'stripe', 'square', 'adyen', 'braintree',
  // Generic (every market)
  'cash', 'cod', 'cash on delivery', 'bank transfer', 'wire transfer',
  'transfer', 'crypto', 'bitcoin', 'usdt',
  // Arabic
  'كاش', 'نقدا', 'نقداً', 'تحويل', 'كي نت', 'فوران', 'مدى', 'تابي', 'تمارا',
];

/**
 * True iff the customer's message OR the bot's reply mostly looks like
 * a payment-method exchange. When true the cart parser refuses to add
 * any new line — payment-method words sometimes phonetically match
 * frappe / shake / other catalog names and we never want that.
 */
export function isPaymentMethodTurn(userMessage: string, botReply: string): boolean {
  const u = userMessage.toLowerCase().trim();
  const r = botReply.toLowerCase().trim();
  // Hit on the user's message — the affirmative answer to "how to pay?".
  for (const w of PAYMENT_METHOD_WORDS) {
    const pattern = new RegExp(`(^|[^a-z])${escapeRegExp(w)}([^a-z]|$)`, 'i');
    if (pattern.test(u)) return true;
  }
  // Hit on the bot's reply — when the bot itself is talking payment
  // methods (sending the payment link, confirming the choice) we
  // never want to parse "Fawran" as an add either.
  if (/payment\s+(link|method|option)|how would you like to pay|what payment/i.test(r)) {
    return true;
  }
  return false;
}

/**
 * True iff the supplied catalog product name is also a payment-method
 * keyword. Used by parseAddedItems as a last-line guard: even if the
 * extracted line really did mention the catalog item by name, we
 * refuse to add it when its name overlaps with a payment-channel word
 * (e.g. a catalog entry literally called "Fawran").
 */
function isProductNameAlsoPayment(productName: string): boolean {
  const n = productName.toLowerCase().trim();
  return PAYMENT_METHOD_WORDS.some((w) => n === w || n.startsWith(`${w} `) || n.endsWith(` ${w}`));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cancel / restart phrases the customer might use to wipe the cart
// before confirming. Conservative — we only match clear intents so
// "nevermind, what about the oreo" doesn't nuke the cart.
const CANCEL_PATTERNS = [
  /^\s*(cancel|nevermind|never\s*mind|forget\s+it|start\s+over|clear\s+(my\s+)?(cart|order)|reset)\s*[.!?]?\s*$/i,
  /^\s*(actually\s+(no|nevermind|cancel))\s*[.!?]?\s*$/i,
  // Arabic
  /(إلغاء|ألغي\s*(الطلب|السلة)|ابدأ\s*من\s*جديد)/,
];

/**
 * True iff the customer's message clearly says "cancel / start over".
 * Used to delete the draft cart before the bot replies.
 */
export function detectCancelIntent(userMessage: string): boolean {
  const m = userMessage.trim();
  if (m.length === 0 || m.length > 200) return false;
  return CANCEL_PATTERNS.some((re) => re.test(m));
}

/**
 * Lowercase + strip punctuation + collapse whitespace.
 * Used both for catalog name + the bot's quoted name so we can
 * substring-match across the LLM's paraphrasing.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort match of an extracted name fragment against the catalog.
 * Returns the most specific match — prefers the longest catalog name
 * that's a substring of the parsed fragment.
 */
function findProduct(fragment: string, catalog: CatalogProduct[]): CatalogProduct | null {
  const fragNorm = normalise(fragment);
  if (!fragNorm) return null;
  let best: { product: CatalogProduct; score: number } | null = null;
  for (const p of catalog) {
    const nameNorm = normalise(p.name);
    if (!nameNorm) continue;
    if (fragNorm.includes(nameNorm)) {
      const score = nameNorm.length;
      if (!best || score > best.score) best = { product: p, score };
    } else if (p.sku && fragNorm.includes(normalise(p.sku))) {
      // Last-ditch: maybe the bot leaked a SKU into the line.
      if (!best) best = { product: p, score: 1 };
    }
  }
  return best?.product ?? null;
}

export interface ParseAddedItemsOptions {
  /**
   * The customer's most recent inbound message. When set, we only
   * accept an "added X" line if the customer's message also mentions
   * the matched product name — this stops the LLM hallucinating an
   * "I've added Mango Ice Cream" line when the user only said
   * "Done send". When unset (back-compat), the explicit-name check
   * is skipped.
   */
  userMessage?: string;
  /** The bot's previous outbound. Used only for context heuristics. */
  previousBotReply?: string;
}

/**
 * Parse a single bot reply for all "added N× <name>" lines.
 * Returns one ParsedAdd per item that resolves against the catalog.
 * Unresolved fragments are silently dropped (the bot might hallucinate
 * a name; we'd rather skip than fabricate a cart row).
 *
 * Multiple matches for the same SKU within one reply collapse to a
 * single entry — quantity is the LARGEST mentioned (bot saying "I've
 * added 1× X. Running total 1× X" shouldn't double-count).
 *
 * Three guards prevent the parser inventing items:
 *   1. The PAYMENT_METHOD_WORDS short-circuit (no adds when the turn
 *      is about payment channels).
 *   2. Explicit-user-name guard: when options.userMessage is supplied,
 *      we only accept the add if the user's message also references
 *      the product name (or one of its tokens ≥4 chars). Stops the
 *      LLM bolting an unrequested item onto an order.
 *   3. Catalog-name-is-payment-method block: even a fully-explicit
 *      "add Fawran" is refused if there's any catalog row literally
 *      called Fawran — the customer almost certainly meant the
 *      payment channel.
 */
// Bounded Levenshtein edit distance — used so the user-mention guard below
// tolerates customer typos ("mago" ≈ "mango", "icream" ≈ "ice cream"). The
// LLM corrects typos in its reply, but the guard reads the RAW user text.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  let curr = new Array<number>(bl + 1);
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl]!;
}

export function parseAddedItems(
  reply: string,
  catalog: CatalogProduct[],
  options: ParseAddedItemsOptions = {},
): ParsedAdd[] {
  if (!reply || catalog.length === 0) return [];

  // Guard 1: payment-method turn — never auto-add when the customer's
  // message OR the bot's reply is clearly about payment channels.
  if (options.userMessage != null) {
    if (isPaymentMethodTurn(options.userMessage, reply)) return [];
  }

  const userTextNorm = options.userMessage ? normalise(options.userMessage) : null;

  const bySku = new Map<string, ParsedAdd>();

  // Guards 2 + 3, shared by every parsing pass. Returns true if `product` may
  // be added given the customer's last message + the bot's prior offer.
  const accept = (product: CatalogProduct): boolean => {
    // Guard 3: refuse a product whose own name is a payment word (likelier an
    // operator catalog-naming accident than a genuine order).
    if (isProductNameAlsoPayment(product.name)) return false;
    // Guard 2: when we have the user's last message, the user must have
    // actually mentioned the product (full name or a meaningful token) —
    // otherwise the bot is inventing the add. Exception: the bot OFFERED it
    // last turn and the customer affirmed (upsell acceptance).
    if (!userTextNorm) return true;
    const productNorm = normalise(product.name);
    const productTokens = productNorm.split(/\s+/).filter((t) => t.length >= 4);
    // Typo tolerance: customers misspell ("mago icrecram"). The LLM corrects it
    // in its reply (so findProduct matched), but this guard reads the RAW user
    // text — fuzzy-match each product token against the user's words.
    const userTokens = userTextNorm.split(/\s+/).filter((t) => t.length >= 3);
    const fuzzyHit = (ptok: string) =>
      userTokens.some((utok) => {
        const tol = Math.max(1, Math.floor(Math.max(ptok.length, utok.length) / 4));
        return Math.abs(ptok.length - utok.length) <= tol && levenshtein(utok, ptok) <= tol;
      });
    const userMentions =
      userTextNorm.includes(productNorm) ||
      productTokens.some((tok) => userTextNorm.includes(tok) || fuzzyHit(tok));
    const prevBotNorm = options.previousBotReply ? normalise(options.previousBotReply) : '';
    const botOfferedIt =
      !!prevBotNorm &&
      (prevBotNorm.includes(productNorm) || productTokens.some((t) => prevBotNorm.includes(t)));
    const userAffirmed =
      /\b(yes|yeah|yep|yup|sure|ok|okay|add (?:it|that|those|them|this)|go ahead|please|why not|definitely|of course|sounds good)\b/.test(
        userTextNorm,
      ) || /نعم|ايوه|أيوه|اوكي|اوك|أوكي|تمام|اضف|أضف|ضيف|ماشي|اكيد|أكيد/.test(userTextNorm);
    return userMentions || (botOfferedIt && userAffirmed);
  };

  const record = (product: CatalogProduct, qty: number): void => {
    const prev = bySku.get(product.sku);
    if (!prev || qty > prev.quantity) {
      bySku.set(product.sku, {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity: qty,
        unitPriceMinor: product.priceMinor ?? 0,
      });
    }
  };

  // Pass 1: per-line verb-anchored "added N× X" / "أضفت X" patterns.
  for (const re of ADD_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(reply)) !== null) {
      // Quantity is optional on the verb-anchored patterns — a bare
      // "Added Waffle" / "أضفت Waffle" means qty 1.
      const qtyRaw = match[1];
      const qty = qtyRaw ? Math.max(1, Math.min(999, Number(qtyRaw))) : 1;
      if (!Number.isFinite(qty)) continue;
      const product = findProduct(match[2] ?? '', catalog);
      if (product && accept(product)) record(product, qty);
    }
  }

  // Pass 2: list-confirmation format. The bot often confirms a multi-item add
  // (or shows an order summary) as a header + bullet list:
  //   "تم إضافة الطلب:\n- High Protein Beef Fajita Shaker، 890000 LBP\n- Lebanese Burger…"
  // The verb patterns above miss these (bullets don't start with added/أضفت),
  // so the draft cart stayed empty and checkout fell back to the unreliable
  // [CART:] marker. Gated on a confirmation header so a plain MENU listing is
  // never parsed as adds.
  //
  // NOTE: pass 2 does NOT apply the user-mention guard (Guard 2). The
  // confirmation header IS the evidence that the bot is restating what it
  // added — and customers routinely order with synonyms / brands / another
  // language ("3elbet batat" for Imported Fries, "pepsi" for Soft Drink). Re-
  // requiring the raw user text to mention each catalog name silently dropped
  // those items, capturing a 1-item order instead of 3. We keep only Guard 3
  // (never treat a payment-word product as an add).
  if (CART_CONFIRM_HEADER_RE.test(reply)) {
    for (const rawLine of reply.split(/\n/)) {
      const mBullet = /^\s*(?:[-•*·–]|\d+[.)])\s+(.+)$/.exec(rawLine);
      if (!mBullet) continue;
      let frag = mBullet[1]!.trim();
      let qty = 1;
      const mQty = /^(\d{1,3})\s*[x×]\s+(.+)$/i.exec(frag);
      if (mQty) {
        qty = Math.max(1, Math.min(999, Number(mQty[1])));
        frag = mQty[2]!.trim();
      }
      const product = findProduct(frag, catalog);
      if (product && !isProductNameAlsoPayment(product.name)) record(product, qty);
    }
  }

  return Array.from(bySku.values());
}

/**
 * Inject [IMAGE: <sku>] markers into the reply text for each parsed
 * add whose marker isn't already present. The downstream send pipeline
 * resolves these to product images, so the customer always sees a
 * picture even when the LLM forgot the marker. Placed at the end of
 * the reply on their own line; the existing marker stripper handles
 * removal from the visible body.
 */
export function augmentReplyWithImageMarkers(reply: string, items: ParsedAdd[]): string {
  if (items.length === 0) return reply;
  const lower = reply.toLowerCase();
  const missing: string[] = [];
  for (const it of items) {
    const tag = `[image: ${it.sku.toLowerCase()}]`;
    if (!lower.includes(tag)) missing.push(it.sku);
  }
  if (missing.length === 0) return reply;
  const markerLines = missing.map((sku) => `[IMAGE: ${sku}]`).join('\n');
  return `${reply.trimEnd()}\n${markerLines}`;
}
