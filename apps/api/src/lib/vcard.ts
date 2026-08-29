// A vCard reader aimed at what phones actually export, not at the spec's happy path.
//
// The three things that break naive parsers on real address-book exports, all of which
// this handles:
//
//  1. RFC 6350 line folding — a line beginning with SPACE or TAB continues the previous
//     one. Split on newlines without unfolding and long entries silently truncate.
//  2. vCard 2.1 QUOTED-PRINTABLE with soft line breaks — a value line ending in '=' is
//     continued on the NEXT line, which is *not* indented, so it looks exactly like a
//     new property. Android's native exporter emits this for every non-ASCII name, i.e.
//     for every Arabic contact. Getting this wrong doesn't drop a field, it corrupts the
//     name of every contact in the file.
//  3. PHOTO/LOGO base64 blobs, which are megabytes and must never be accumulated.
//
// Pure so it is unit-testable without a DB. It imports only the equally-pure phone
// normaliser, which it needs to tell a multi-number TEL from a DTMF dial pause.
import { normalizePhone } from './phone-normalize.js';

/**
 * Used ONLY to answer "is this fragment a phone number at all?" when deciding whether a
 * comma in a TEL separates two numbers or introduces a dial pause. Deliberately has no
 * dial code: a bare local fragment must NOT look valid here, or every pause suffix would
 * be promoted to a contact.
 */
const LENIENT = {} as const;

export interface VCardEntry {
  displayName: string | null;
  phones: string[];
  email: string | null;
  organization: string | null;
}

/** Properties whose values are binary blobs — parsed for structure, never retained. */
const SKIPPED_PROPS = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY']);

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (ch === '=' && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    // Any other character is literal; push its UTF-8 bytes.
    for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Undo vCard 3.0/4.0 value escaping: \n \, \; \\ */
function unescapeValue(input: string): string {
  return input.replace(/\\([nN,;\\])/g, (_m, c: string) =>
    c === 'n' || c === 'N' ? '\n' : c,
  );
}

interface RawLine {
  name: string;
  params: string[];
  value: string;
}

/**
 * Collapse the physical lines of a vCard into logical property lines, honouring BOTH
 * continuation mechanisms. Order matters: QP soft breaks must be joined while we still
 * know the property was QP-encoded, which is why this cannot be a simple pre-pass.
 */
function unfold(text: string): string[] {
  const physical = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const logical: string[] = [];

  for (let i = 0; i < physical.length; i += 1) {
    let line = physical[i] ?? '';

    // RFC folding: subsequent lines starting with whitespace belong to this one.
    while (i + 1 < physical.length && /^[ \t]/.test(physical[i + 1] ?? '')) {
      line += (physical[i + 1] ?? '').slice(1);
      i += 1;
    }

    // vCard 2.1 quoted-printable soft break: a trailing '=' on a QP property means the
    // value continues on the next (unindented) line.
    //
    // Collected into an array and joined ONCE. The obvious form —
    // `line = line.slice(0, -1) + next` in the loop — is quadratic: V8 flattens the rope
    // on every iteration, so cost grows with the square of the continuation count. Not a
    // micro-optimisation: this parser runs on an UNAUTHENTICATED route, before the token
    // is resolved, in a single-threaded process. Measured on the old form, one crafted
    // 2.5 MB body (well under both the 6M-char cap and the 8 MB bodyLimit) pinned the
    // event loop for ~14.5s — every tenant's webhooks and bot replies stall behind it.
    if (/ENCODING=QUOTED-PRINTABLE/i.test(line) && line.endsWith('=')) {
      const parts = [line.slice(0, -1)];
      while (i + 1 < physical.length) {
        const next = physical[i + 1] ?? '';
        i += 1;
        if (next.endsWith('=')) {
          parts.push(next.slice(0, -1));
        } else {
          parts.push(next);
          break;
        }
      }
      line = parts.join('');
    }

    logical.push(line);
  }

  return logical;
}

function parseLine(line: string): RawLine | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Strip an optional "group." prefix (e.g. "item1.TEL"), which iOS uses heavily.
  const segments = head.split(';');
  let name = segments[0] ?? '';
  const dot = name.indexOf('.');
  if (dot !== -1) name = name.slice(dot + 1);

  return { name: name.trim().toUpperCase(), params: segments.slice(1), value };
}

function decodeValue(raw: RawLine): string {
  const isQp = raw.params.some((p) => /^ENCODING=(QUOTED-PRINTABLE|QP)$/i.test(p.trim()));
  const decoded = isQp ? decodeQuotedPrintable(raw.value) : unescapeValue(raw.value);
  return decoded.trim();
}

/** Build a display name from a structured N property: Family;Given;Middle;Prefix;Suffix */
function nameFromStructured(value: string): string | null {
  const parts = value.split(';').map((p) => p.trim());
  const [family = '', given = '', middle = '', prefix = ''] = parts;
  const ordered = [prefix, given, middle, family].filter((p) => p.length > 0);
  const joined = ordered.join(' ').trim();
  return joined.length > 0 ? joined : null;
}

export interface ParseVCardOptions {
  /** Refuse to accumulate an unbounded number of cards. */
  maxEntries?: number;
}

/**
 * Parse a .vcf payload into entries. Never throws on malformed input — a phone export
 * is untrusted, frequently truncated, and one bad card must not lose the other 1,200.
 */
export function parseVCard(text: string, opts: ParseVCardOptions = {}): VCardEntry[] {
  const maxEntries = opts.maxEntries ?? 20_000;
  const entries: VCardEntry[] = [];

  let current: VCardEntry | null = null;
  let structuredName: string | null = null;

  for (const line of unfold(text)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const raw = parseLine(trimmed);
    if (!raw) continue;

    if (raw.name === 'BEGIN' && raw.value.trim().toUpperCase() === 'VCARD') {
      current = { displayName: null, phones: [], email: null, organization: null };
      structuredName = null;
      continue;
    }

    if (raw.name === 'END' && raw.value.trim().toUpperCase() === 'VCARD') {
      if (current) {
        // FN wins when present; otherwise fall back to the structured N.
        if (!current.displayName && structuredName) current.displayName = structuredName;
        if (current.phones.length > 0 || current.displayName) entries.push(current);
      }
      current = null;
      structuredName = null;
      if (entries.length >= maxEntries) break;
      continue;
    }

    if (!current) continue;
    if (SKIPPED_PROPS.has(raw.name)) continue;

    switch (raw.name) {
      case 'FN': {
        const v = decodeValue(raw);
        if (v) current.displayName = v;
        break;
      }
      case 'N': {
        structuredName = nameFromStructured(decodeValue(raw));
        break;
      }
      case 'TEL': {
        // Machines, not people. An Apple business card routinely carries WORK;FAX and
        // PAGER entries; importing them makes one contact into three or four rows and
        // then messages a fax line.
        if (raw.params.some((p) => /(^|=)(FAX|PAGER)\b/i.test(p.trim()))) break;

        // RFC 6350 makes `uri` the DEFAULT value type for TEL, so any vCard 4.0 export
        // (desktop, CardDAV) writes `TEL;VALUE=uri:tel:+96170123456`. parseLine splits on
        // the first colon, so the scheme stays on the value and the letter guard in
        // normalizePhone then rejects the whole number — silently dropping EVERY phone in
        // the file while each card still parses, so the "no contacts found" guard never
        // fires and the tenant is told their numbers were unusable.
        const v = decodeValue(raw)
          .replace(/^tel:/i, '')
          .split(';')[0]!
          .trim();
        if (!v) break;

        // A comma in a TEL is ambiguous: vCard allows several numbers, but on an iPhone
        // it is a 2-second DIAL PAUSE. Splitting blindly turns "+9611999888,,,70123456"
        // (a switchboard plus an extension) into a second contact who is a real,
        // unrelated person. Only treat commas as separators when every part stands up as
        // a number on its own; otherwise keep the first and discard the DTMF tail.
        const parts = v
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length > 1 && parts.every((p) => normalizePhone(p, LENIENT) !== null)) {
          current.phones.push(...parts);
        } else if (parts[0]) {
          current.phones.push(parts[0]);
        }
        break;
      }
      case 'EMAIL': {
        const v = decodeValue(raw);
        if (v && !current.email) current.email = v;
        break;
      }
      case 'ORG': {
        // ORG is structured: Company;Department
        const v = decodeValue(raw).split(';')[0]?.trim();
        if (v && !current.organization) current.organization = v;
        break;
      }
      default:
        break;
    }
  }

  return entries;
}
