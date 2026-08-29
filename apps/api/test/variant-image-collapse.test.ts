import { describe, expect, it } from 'vitest';

import { collapseVariantSiblings } from '../src/lib/variant-image-collapse.js';

const p = (sku: string, name: string) => ({ sku, name });

describe('collapseVariantSiblings', () => {
  it('collapses dash-suffixed size variants to the first one', () => {
    const items = [
      p('MENU-285', 'عصير فراولة - بيبي'),
      p('MENU-288', 'عصير فراولة - كبير'),
      p('MENU-287', 'عصير فراولة - الوسط'),
      p('MENU-286', 'عصير فراولة - صغير'),
      p('MENU-289', 'عصير فراولة - 1 ليتر'),
    ];
    expect(collapseVariantSiblings(items)).toEqual([p('MENU-285', 'عصير فراولة - بيبي')]);
  });

  it('collapses parenthesised count variants', () => {
    const items = [
      p('MENU-74', 'شوكليت فراوله بيبي (2 حبه)'),
      p('MENU-69', 'شوكليت فراوله بيبي (6 حبات)'),
      p('MENU-70', 'شوكليت فراوله بيبي (10 حبه)'),
    ];
    expect(collapseVariantSiblings(items)).toEqual([p('MENU-74', 'شوكليت فراوله بيبي (2 حبه)')]);
  });

  it('keeps distinct products even when they carry a size suffix', () => {
    const items = [
      p('A1', 'عصير فراولة - صغير'),
      p('B1', 'عصير برتقال - صغير'),
      p('C1', 'وافل لوتس'),
    ];
    expect(collapseVariantSiblings(items)).toEqual(items);
  });

  it('leaves a lone dash-named product untouched', () => {
    const items = [p('A1', 'شي ثاني - صغير'), p('B1', 'قشطوطة - مكسرات')];
    expect(collapseVariantSiblings(items)).toEqual(items);
  });

  it('does not treat hyphenated words as variant suffixes', () => {
    const items = [p('A1', 'Coca-Cola'), p('B1', 'Coca-Cola Zero')];
    expect(collapseVariantSiblings(items)).toEqual(items);
  });

  it('mixed list: collapses only the sibling group', () => {
    const items = [
      p('MENU-285', 'عصير فراولة - بيبي'),
      p('MENU-288', 'عصير فراولة - كبير'),
      p('X1', 'وافل لوتس'),
    ];
    expect(collapseVariantSiblings(items)).toEqual([
      p('MENU-285', 'عصير فراولة - بيبي'),
      p('X1', 'وافل لوتس'),
    ]);
  });
});
