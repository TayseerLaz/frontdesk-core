// "Sync contacts with phone" — pure-logic gate.
//
// These cover the two parsers that stand between an untrusted phone export and the
// contacts table. Both fail in ways that are invisible at review time and expensive
// later: a phone normaliser that mangles local numbers produces a table full of
// well-formed entries that match no real person, and a vCard reader that mishandles
// quoted-printable corrupts the NAME OF EVERY ARABIC CONTACT in an Android export
// while looking perfectly healthy on the ASCII test fixture.
//
// No DB, no network — this belongs in the HARD CI gate.
import { describe, expect, it } from 'vitest';

import { buildPhoneSyncUrl, normalizeEntries } from '../src/lib/contact-sync-normalize.js';
import { foldDigits, normalizePhone } from '../src/lib/phone-normalize.js';
import { parseVCard } from '../src/lib/vcard.js';

const LB = { defaultDialCode: '961' };

/** vCard's line terminator, CRLF per RFC 6350. */
const BREAK = String.fromCharCode(13, 10);

describe('normalizePhone', () => {
  it('drops the national trunk prefix when going international', () => {
    // 03 123 456 is dialled locally as 03…, internationally as +961 3…
    expect(normalizePhone('03 123 456', LB)).toBe('+9613123456');
    expect(normalizePhone('01-234-567', LB)).toBe('+9611234567');
    expect(normalizePhone('(03) 123.456', LB)).toBe('+9613123456');
  });

  it('accepts numbers that are already international', () => {
    expect(normalizePhone('+961 70 123 456', LB)).toBe('+96170123456');
    expect(normalizePhone('0096170123456', LB)).toBe('+96170123456');
    expect(normalizePhone('96170123456', LB)).toBe('+96170123456');
  });

  it('prefixes a bare subscriber number', () => {
    expect(normalizePhone('70123456', LB)).toBe('+96170123456');
  });

  it('folds Arabic-Indic and Eastern Arabic digits', () => {
    expect(foldDigits('٠١٢abc٣')).toBe('012abc3');
    expect(normalizePhone('٠٣١٢٣٤٥٦', LB)).toBe('+9613123456');
    expect(normalizePhone('۰۳۱۲۳۴۵۶', LB)).toBe('+9613123456');
  });

  it('survives the directional marks iOS puts around numbers in RTL locales', () => {
    expect(normalizePhone('‏+961 3 123 456‎', LB)).toBe('+9613123456');
  });

  it('refuses what is not a dialable number', () => {
    expect(normalizePhone('CALL-ME-NOW', LB)).toBeNull();
    expect(normalizePhone('03123456 x22', LB)).toBeNull(); // extension
    expect(normalizePhone('*555#', LB)).toBeNull(); // USSD
    expect(normalizePhone('1234', LB)).toBeNull(); // short code
    expect(normalizePhone('00000000', LB)).toBeNull(); // placeholder junk
    expect(normalizePhone('', LB)).toBeNull();
    expect(normalizePhone('+9611234567890123456', LB)).toBeNull(); // > E.164 max
  });

  it('skips local-format numbers rather than guessing when no dial code is set', () => {
    expect(normalizePhone('03 123 456', {})).toBeNull();
    // …but an already-international number still works without one.
    expect(normalizePhone('+96170123456', {})).toBe('+96170123456');
  });

  it('is not Lebanon-specific', () => {
    expect(normalizePhone('050 123 4567', { defaultDialCode: '971' })).toBe('+971501234567');
    expect(normalizePhone('+1 (415) 555-0123', { defaultDialCode: '1' })).toBe('+14155550123');
  });
});

describe('parseVCard', () => {
  it('reads a typical iOS 3.0 card, including the item1. group prefix', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Khoury;Rami;;;',
      'FN:Rami Khoury',
      'item1.TEL;type=CELL;type=VOICE;type=pref:+961 3 123 456',
      'EMAIL;type=INTERNET:rami@example.com',
      'ORG:Khoury Trading;Sales',
      'END:VCARD',
    ].join('\r\n');

    const [c] = parseVCard(vcf);
    expect(c!.displayName).toBe('Rami Khoury');
    expect(c!.phones).toEqual(['+961 3 123 456']);
    expect(c!.email).toBe('rami@example.com');
    expect(c!.organization).toBe('Khoury Trading');
  });

  it('decodes quoted-printable Arabic ACROSS a soft line break', () => {
    // This is the case that silently corrupts every Arabic contact: Android's native
    // exporter emits QP for non-ASCII and breaks long values with a trailing '=' on an
    // UNINDENTED continuation line, which looks exactly like a new property.
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D9=85=D8=AD=D9=85=',
      '=D8=AF;;;;',
      'TEL;CELL:03 123 456',
      'END:VCARD',
    ].join('\r\n');

    const [c] = parseVCard(vcf);
    expect(c!.displayName).toBe('محمد');
  });

  it('unfolds RFC-folded lines and never retains photo blobs', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:A Very Long Contact Name That Got',
      '  Folded Across Lines',
      'TEL:+96170000001',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD',
      'END:VCARD',
    ].join('\r\n');

    const [c] = parseVCard(vcf);
    expect(c!.displayName).toBe('A Very Long Contact Name That Got Folded Across Lines');
    expect(JSON.stringify(c)).not.toContain('9j/4AAQ');
  });

  it('splits multiple numbers on one TEL and falls back to N when FN is absent', () => {
    const multi = 'BEGIN:VCARD\r\nFN:Two Numbers\r\nTEL:+96170000002,+96170000003\r\nEND:VCARD';
    expect(parseVCard(multi)[0]!.phones).toEqual(['+96170000002', '+96170000003']);

    const nOnly = 'BEGIN:VCARD\nVERSION:2.1\nN:Haddad;Sara;;Dr.;\nTEL:70123456\nEND:VCARD';
    expect(parseVCard(nOnly)[0]!.displayName).toBe('Dr. Sara Haddad');
  });

  it('does not throw on malformed input and keeps the good cards', () => {
    const messy = [
      'garbage line with no colon',
      'BEGIN:VCARD',
      'FN:Good One',
      'TEL:+96170000004',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Truncated card with no END',
    ].join('\n');

    const out = parseVCard(messy);
    expect(out).toHaveLength(1);
    expect(out[0]!.displayName).toBe('Good One');
    expect(parseVCard('')).toHaveLength(0);
  });
});

describe('normalizeEntries', () => {
  it('collapses duplicate numbers and keeps the richer entry', () => {
    const out = normalizeEntries(
      [
        { name: null, phones: ['03 123 456'], email: 'a@example.com' },
        { name: 'Rami', phones: ['+961 3 123 456'], email: null },
      ],
      '961',
    );
    expect(out.contacts).toHaveLength(1);
    expect(out.contacts[0]!.phoneE164).toBe('+9613123456');
    expect(out.contacts[0]!.displayName).toBe('Rami');
    expect(out.contacts[0]!.email).toBe('a@example.com');
  });

  it('counts entries with no usable number as skipped rather than dropping them silently', () => {
    const out = normalizeEntries(
      [
        { name: 'Voicemail', phones: ['*86'] },
        { name: 'No Number', phones: [] },
        { name: 'Real', phones: ['70123456'] },
      ],
      '961',
    );
    expect(out.received).toBe(3);
    expect(out.skipped).toBe(2);
    expect(out.contacts).toHaveLength(1);
  });
});

describe('buildPhoneSyncUrl', () => {
  // Regression: the first deploy minted `${WEB_PUBLIC_URL}/sync/<token>` assuming the
  // env var carried Next's '/app' basePath. In production it is the bare origin, so the
  // QR resolved to the marketing site — which answered 200 with its own Login button.
  // Nothing errored; the scan just asked the tenant to sign in.
  it('always lands on the /app basePath, whichever way WEB_PUBLIC_URL is set', () => {
    expect(buildPhoneSyncUrl('https://example.com', 'TOK')).toBe('https://example.com/app/sync/TOK');
    expect(buildPhoneSyncUrl('https://example.com/', 'TOK')).toBe('https://example.com/app/sync/TOK');
    // Already carries the basePath — must not double it into /app/app.
    expect(buildPhoneSyncUrl('https://example.com/app', 'TOK')).toBe('https://example.com/app/sync/TOK');
    expect(buildPhoneSyncUrl('https://example.com/app/', 'TOK')).toBe('https://example.com/app/sync/TOK');
    expect(buildPhoneSyncUrl('http://localhost:3000', 'TOK')).toBe(
      'http://localhost:3000/app/sync/TOK',
    );
  });

  it('never points at a bare /sync path, which the marketing site would swallow', () => {
    for (const base of ['https://example.com', 'https://example.com/', 'https://example.com/app']) {
      expect(buildPhoneSyncUrl(base, 'TOK')).toContain('/app/sync/');
      expect(buildPhoneSyncUrl(base, 'TOK')).not.toContain('/app/app/');
    }
  });
});

// ---------------------------------------------------------------------------
// Regressions from the 2026-08-03 adversarial audit. Each of these shipped to
// production and none of them threw — they returned wrong answers quietly.
// ---------------------------------------------------------------------------

describe('audit regressions', () => {
  it('unfolds quoted-printable in linear time (unauthenticated DoS)', () => {
    // The original `line = line.slice(0,-1) + next` re-flattened the string every
    // iteration. Measured on the old code: a 2.5MB body pinned the single-threaded API
    // for ~14.5s, before the token was ever resolved.
    const build = (n: number) => {
      const lines = ['BEGIN:VCARD', 'VERSION:2.1', 'N;ENCODING=QUOTED-PRINTABLE:=D9=85='];
      for (let i = 0; i < n; i += 1) lines.push('=D9=85=');
      lines.push('=D8=AF;;;;', 'TEL:+96170000001', 'END:VCARD');
      return lines.join(BREAK);
    };
    const t0 = Date.now();
    parseVCard(build(40_000));
    // Quadratic took seconds at this size; linear is milliseconds. Generous bound so the
    // test measures the algorithm, not the CI runner's mood.
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('never invents a number from a foreign contact saved without a plus', () => {
    const LB = { defaultDialCode: '961' };
    // These are already-international numbers stored the way people actually store them.
    // Prefixing a dial code produces a valid-looking number belonging to nobody.
    expect(normalizePhone('966501234567', LB)).toBeNull(); // KSA
    expect(normalizePhone('12125551234', LB)).toBeNull(); // US
    expect(normalizePhone('442071234567', LB)).toBeNull(); // UK
    // …while genuine national numbers still complete, including 11-digit Chinese mobiles.
    expect(normalizePhone('13800138000', { defaultDialCode: '86' })).toBe('+8613800138000');
    expect(normalizePhone('70123456', LB)).toBe('+96170123456');
  });

  it('reads vCard 4.0 tel: URIs instead of dropping every number', () => {
    // RFC 6350 makes uri the DEFAULT TEL value type, so desktop/CardDAV exports use it.
    // Keeping the scheme made the letter guard reject every phone in the file, while each
    // card still parsed — so the "no contacts found" guard never fired and the tenant was
    // told their numbers were unusable.
    const v4 = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Uri Person',
      'TEL;VALUE=uri;TYPE="voice,cell":tel:+96170123456',
      'END:VCARD',
    ].join(BREAK);
    expect(parseVCard(v4)[0]!.phones).toEqual(['+96170123456']);

    const withExt = ['BEGIN:VCARD', 'FN:E', 'TEL;VALUE=uri:tel:+96170123456;ext=22', 'END:VCARD'].join(
      BREAK,
    );
    expect(parseVCard(withExt)[0]!.phones).toEqual(['+96170123456']);
  });

  it('drops FAX and PAGER numbers instead of making one person several contacts', () => {
    const apple = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Biz Person',
      'item1.TEL;type=IPHONE;type=CELL:+961 3 111111',
      'item2.TEL;type=WORK:+961 1 222222',
      'item3.TEL;type=WORK;type=FAX:+961 1 333333',
      'item4.TEL;type=PAGER:+961 1 444444',
      'END:VCARD',
    ].join(BREAK);
    expect(parseVCard(apple)[0]!.phones).toEqual(['+961 3 111111', '+961 1 222222']);
  });

  it('treats a DTMF pause as a pause, not as a second person', () => {
    // On an iPhone a comma in a TEL is a 2-second dial pause. Splitting blindly created a
    // contact from the extension digits — a real, unrelated Lebanese mobile.
    const dtmf = ['BEGIN:VCARD', 'FN:Switchboard', 'TEL:+961 1 999 888,,,70123456', 'END:VCARD'].join(BREAK);
    expect(parseVCard(dtmf)[0]!.phones).toEqual(['+961 1 999 888']);

    // …but a genuine multi-number TEL still splits, because every part stands alone.
    const multi = ['BEGIN:VCARD', 'FN:Two', 'TEL:+96170000002,+96170000003', 'END:VCARD'].join(BREAK);
    expect(parseVCard(multi)[0]!.phones).toEqual(['+96170000002', '+96170000003']);
  });
});
