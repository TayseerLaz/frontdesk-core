// Regression tests for the stateful-cart parser (apps/api/src/lib/cart-parser.ts).
//
// These lock in the 2026-06-10 fix: the bot confirms single-item adds
// WITHOUT a quantity ("أضفت Waffle بـ 0.300 KWD" / "Added Mango Ice Cream"),
// and an earlier version of the regexes REQUIRED a digit. That made the
// parser match nothing, the draft cart stayed empty, and checkout silently
// fell back to the unreliable [CART:] marker (which drops items). The live
// failure: a 2-item / 0.400 KWD order was captured as 1 item / 0.300 KWD.
import { describe, expect, it } from 'vitest';

import { parseAddedItems, type CatalogProduct } from '../src/lib/cart-parser.js';

const CATALOG: CatalogProduct[] = [
  { id: 'p1', sku: 'ATK-MANGO-ICE-CREAM', name: 'Mango Ice Cream', priceMinor: 100 },
  { id: 'p2', sku: 'ATK-WAFFLE', name: 'Waffle', priceMinor: 300 },
];

describe('parseAddedItems — quantity-less confirmations (regression)', () => {
  it('parses an Arabic "أضفت <product> بـ <price>" add with no quantity (qty defaults to 1)', () => {
    const out = parseAddedItems(
      'تمام، أضفت Mango Ice Cream بـ 0.100 KWD 🥭',
      CATALOG,
      {
        userMessage: 'Yes, what else goes with it?',
        previousBotReply: 'بدك أضيف Mango Ice Cream على طلبك؟',
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: 'ATK-MANGO-ICE-CREAM', quantity: 1, unitPriceMinor: 100 });
  });

  it('parses a quantity-less English "Added <product>" add (qty defaults to 1)', () => {
    const out = parseAddedItems('Added Waffle to your order.', CATALOG, {
      userMessage: 'add the waffle please',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: 'ATK-WAFFLE', quantity: 1 });
  });

  it('still honours an explicit quantity when present', () => {
    const out = parseAddedItems("I've added 3× Waffle", CATALOG, {
      userMessage: '3 waffles',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sku: 'ATK-WAFFLE', quantity: 3 });
  });

  it('captures BOTH items across the two turns of the failing transcript', () => {
    const mango = parseAddedItems('تمام، أضفت Mango Ice Cream بـ 0.100 KWD 🥭', CATALOG, {
      userMessage: 'Yes, what else goes with it?',
      previousBotReply: 'بدك أضيف Mango Ice Cream على طلبك؟',
    });
    const waffle = parseAddedItems('أضفت Waffle بـ 0.300 KWD 👍\n\nالمجموع الآن: 0.400 KWD', CATALOG, {
      userMessage: 'Ok add it thanks',
      previousBotReply: 'يجي معاه Waffle كتير حلو، بـ 0.300 KWD، بدك تضيفه؟',
    });
    expect(mango.map((i) => i.sku)).toEqual(['ATK-MANGO-ICE-CREAM']);
    expect(waffle.map((i) => i.sku)).toEqual(['ATK-WAFFLE']);
  });
});

describe('parseAddedItems — guards still hold after making quantity optional', () => {
  it('does NOT add a non-catalog "added <thing>" line (e.g. a delivery address)', () => {
    const out = parseAddedItems("Got it — I've added your delivery address.", CATALOG, {
      userMessage: 'Beirut, hazmieh',
    });
    expect(out).toEqual([]);
  });

  it('does NOT add an item the customer never mentioned (no upsell offer either)', () => {
    const out = parseAddedItems('Added Mango Ice Cream', CATALOG, {
      userMessage: 'Done, send it',
      previousBotReply: 'What is your delivery address?',
    });
    expect(out).toEqual([]);
  });

  it('refuses to parse adds on a payment-method turn', () => {
    const out = parseAddedItems('Added Waffle', CATALOG, {
      userMessage: 'knet',
    });
    expect(out).toEqual([]);
  });
});

describe('parseAddedItems — list-confirmation format (regression)', () => {
  const SHOP = [
    { id: 'f', sku: 'ATK-FAJITA', name: 'High Protein Beef Fajita Shaker', priceMinor: 89000000 },
    { id: 'b', sku: 'ATK-BURGER', name: 'Lebanese Burger', priceMinor: 53000000 },
    { id: 'd', sku: 'ATK-SOFT', name: 'Soft Drink', priceMinor: 12000000 },
    { id: 't', sku: 'ATK-TAOUK', name: 'Light Taouk Wrap', priceMinor: 48000000 },
    { id: 'fr', sku: 'ATK-FRIES', name: 'Imported Fries', priceMinor: 30000000 },
  ];

  it('captures every item from an Arabic "تم إضافة الطلب:" bullet list', () => {
    const reply =
      'تم إضافة الطلب:\n\n- High Protein Beef Fajita Shaker، 890000.00 LBP.\n- Lebanese Burger، 530000.00 LBP.\n- Soft Drink، 120000.00 LBP.\n\nالمجموع الحالي: 1540000.00 LBP.';
    const out = parseAddedItems(reply, SHOP, {
      userMessage: 'Add one soft drink, a fajita shaker w a burger please',
    });
    expect(out.map((i) => i.sku).sort()).toEqual(['ATK-BURGER', 'ATK-FAJITA', 'ATK-SOFT']);
    expect(out.every((i) => i.quantity === 1)).toBe(true);
  });

  it('honours a leading quantity on a bullet ("2× ...")', () => {
    const out = parseAddedItems('Added to your order:\n- 2x Lebanese Burger\n- Soft Drink', SHOP, {
      userMessage: 'two burgers and a soft drink',
    });
    const burger = out.find((i) => i.sku === 'ATK-BURGER');
    expect(burger?.quantity).toBe(2);
    expect(out.find((i) => i.sku === 'ATK-SOFT')?.quantity).toBe(1);
  });

  it('captures list items the customer named with synonyms/brands/another language', () => {
    // Customer: "fajita w 3elbet batat w pepsi" — "batat" ≠ "Imported Fries",
    // "pepsi" ≠ "Soft Drink". The confirmation header means the bot already
    // agreed to add them, so all three must land (this was the 1-item bug).
    const reply =
      'تم إضافة الطلب:\n- High Protein Beef Fajita Shaker، 890000.00 ل.ل\n- Imported Fries، 300000.00 ل.ل\n- Soft Drink، 120000.00 ل.ل';
    const out = parseAddedItems(reply, SHOP, {
      userMessage: 'bade wehde fahita shaker maa 3elbet batat w wehde pepsi',
    });
    expect(out.map((i) => i.sku).sort()).toEqual(['ATK-FAJITA', 'ATK-FRIES', 'ATK-SOFT']);
  });

  it('does NOT treat a MENU listing as cart adds (no confirmation header)', () => {
    const menu =
      'عنا خيارات صحية رائعة! فيك تجرب:\n\n- High Protein Beef Fajita Shaker، 890000.00 LBP\n- Light Taouk Wrap، 480000.00 LBP';
    const out = parseAddedItems(menu, SHOP, { userMessage: 'shu fe shi healthy' });
    expect(out).toEqual([]);
  });
});
