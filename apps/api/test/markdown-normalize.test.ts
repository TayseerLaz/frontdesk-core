import { describe, expect, it } from 'vitest';

import { normalizeMarkdownForChannel } from '../src/lib/markdown-normalize.js';

const wa = (s: string) => normalizeMarkdownForChannel(s, 'whatsapp');
const pl = (s: string) => normalizeMarkdownForChannel(s, 'plain');

describe('normalizeMarkdownForChannel', () => {
  it('converts **bold** to a single asterisk on WhatsApp', () => {
    expect(wa('**وقت الحلو:**')).toBe('*وقت الحلو:*');
    expect(wa('__really__ good')).toBe('*really* good');
  });

  it('strips all emphasis on plain (Messenger/IG/voice)', () => {
    expect(pl('**وقت الحلو:**')).toBe('وقت الحلو:');
    expect(pl('price is *0.150 KWD*')).toBe('price is 0.150 KWD');
  });

  it('maps ATX headings per channel', () => {
    expect(wa('## Menu')).toBe('*Menu*');
    expect(pl('## Menu')).toBe('Menu');
  });

  it('collapses bold-italic', () => {
    expect(wa('***super***')).toBe('*super*');
  });

  it('preserves WhatsApp single-asterisk bold and dash bullets', () => {
    expect(wa('price is *0.150 KWD*')).toBe('price is *0.150 KWD*');
    expect(wa('**بوكسات:**\n- بوكس - 0.195 KWD')).toBe('*بوكسات:*\n- بوكس - 0.195 KWD');
  });

  it('never eats line-start "* item" bullets', () => {
    expect(wa('* one\n* two')).toBe('* one\n* two');
    expect(pl('* one\n* two')).toBe('* one\n* two');
  });

  it('removes orphaned ** left by a truncated reply', () => {
    expect(wa('orphan **بوكسات')).toBe('orphan بوكسات');
  });

  it('leaves single underscores (URLs) and plain text alone', () => {
    expect(wa('utm_source=ig&utm_medium=social')).toBe('utm_source=ig&utm_medium=social');
    expect(wa('no markdown here 😊')).toBe('no markdown here 😊');
  });
});
