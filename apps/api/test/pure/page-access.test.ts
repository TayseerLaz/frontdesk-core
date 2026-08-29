// F1 — per-member page access: pure decision logic (roadmap 2026-08-26).
// Runs in the pure HARD gate — no env, no db.
import { describe, expect, it } from 'vitest';

import {
  apiPathPageKey,
  isHrefBlockedByPageAccess,
  pageAccessOptions,
  parsePageAccess,
} from '@platform/shared';

describe('parsePageAccess', () => {
  it('null/undefined mean full access; arrays are filtered to strings', () => {
    expect(parsePageAccess(null)).toBeNull();
    expect(parsePageAccess(undefined)).toBeNull();
    expect(parsePageAccess(['products', 42, null, 'inbox'])).toEqual(['products', 'inbox']);
    expect(parsePageAccess([])).toEqual([]);
  });
  it('a corrupt shape fails toward the role check (null), never toward lockout', () => {
    expect(parsePageAccess('products')).toBeNull();
    expect(parsePageAccess({ products: true })).toBeNull();
  });
});

describe('isHrefBlockedByPageAccess', () => {
  it('null whitelist blocks nothing', () => {
    expect(isHrefBlockedByPageAccess('/products', null)).toBe(false);
  });
  it('whitelist blocks unlisted registered pages, allows listed ones (incl. subpaths)', () => {
    expect(isHrefBlockedByPageAccess('/products', ['inbox'])).toBe(true);
    expect(isHrefBlockedByPageAccess('/products/123', ['inbox'])).toBe(true);
    expect(isHrefBlockedByPageAccess('/inbox', ['inbox'])).toBe(false);
    expect(isHrefBlockedByPageAccess('/inbox-full', ['inbox'])).toBe(false);
  });
  it('unregistered pages (dashboard, profile) are never blocked', () => {
    expect(isHrefBlockedByPageAccess('/dashboard', [])).toBe(false);
    expect(isHrefBlockedByPageAccess('/settings/profile', [])).toBe(false); // settings key covers it…
  });
  it('an empty whitelist blocks every registered page', () => {
    expect(isHrefBlockedByPageAccess('/broadcasts', [])).toBe(true);
    expect(isHrefBlockedByPageAccess('/contacts', [])).toBe(true);
  });
  it('core pages beyond feature keys are restrictable too', () => {
    expect(isHrefBlockedByPageAccess('/members', [])).toBe(true);
    expect(isHrefBlockedByPageAccess('/api-keys', ['api_tools'])).toBe(false);
    expect(isHrefBlockedByPageAccess('/webhooks', ['api_tools'])).toBe(false);
  });
});

describe('apiPathPageKey', () => {
  it('maps page-backing API prefixes to their page key', () => {
    expect(apiPathPageKey('/api/v1/products')).toBe('products');
    expect(apiPathPageKey('/api/v1/products/abc-123')).toBe('products');
    expect(apiPathPageKey('/api/v1/categories')).toBe('products');
    expect(apiPathPageKey('/api/v1/broadcasts?page=2')).toBe('broadcasts');
    expect(apiPathPageKey('/api/v1/inbox/threads')).toBe('inbox');
    expect(apiPathPageKey('/api/v1/stock-watches')).toBe('contacts');
    expect(apiPathPageKey('/api/v1/whatsapp/numbers')).toBe('whatsapp_settings');
  });
  it('deliberately does NOT map the send path or unknown prefixes', () => {
    // The inbox reply flow sends through /whatsapp/send — mapping the whole
    // /whatsapp prefix would break replying for inbox-only members.
    expect(apiPathPageKey('/api/v1/whatsapp/send')).toBeNull();
    expect(apiPathPageKey('/api/v1/auth/session')).toBeNull();
    expect(apiPathPageKey('/api/v1/notifications')).toBeNull();
    expect(apiPathPageKey('/api/v1/dashboard')).toBeNull();
  });
  it('prefix matching never bleeds across segment boundaries', () => {
    expect(apiPathPageKey('/api/v1/productsX')).toBeNull();
  });
});

describe('pageAccessOptions registry', () => {
  it('every option has a key, label and at least one href; keys are unique', () => {
    const opts = pageAccessOptions();
    expect(opts.length).toBeGreaterThan(10);
    const keys = new Set<string>();
    for (const o of opts) {
      expect(o.key.length).toBeGreaterThan(0);
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.hrefs.length).toBeGreaterThan(0);
      expect(keys.has(o.key)).toBe(false);
      keys.add(o.key);
    }
  });
});
