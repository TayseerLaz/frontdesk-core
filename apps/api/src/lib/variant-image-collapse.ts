// Variant-sibling image collapse.
//
// Many tenants model each size/count of an item as its OWN catalog row
// ("عصير فراولة - بيبي", "عصير فراولة - صغير", … / "شوكليت فراوله (2 حبه)",
// "(6 حبات)", …). When a reply lists the sizes, the LLM dutifully emits one
// [IMAGE:] marker per row and the customer receives several visually
// identical photos back-to-back. Collapse sibling variants down to ONE
// representative (the first mentioned) per base name before sending.
//
// "Base name" = the product name with a trailing size/count qualifier
// stripped:
//   - a trailing parenthesised qualifier: "شوكليت فراوله (6 حبات)" → "شوكليت فراوله"
//   - a final " - X" segment:             "عصير فراولة - بيبي"      → "عصير فراولة"
// Only groups with ≥2 members collapse, so a lone product that happens to
// contain " - " or "(...)" in its name still sends its image.

export function baseName(name: string): string {
  let n = name.trim();
  n = n.replace(/\s*\([^()]*\)\s*$/u, '').trim();
  // Strip one trailing dash-separated segment. Requires spaces around the
  // dash so hyphenated words/SKUs ("Coca-Cola") are untouched.
  n = n.replace(/\s+[-–—]\s+[^-–—]{1,40}$/u, '').trim();
  return n.toLowerCase().replace(/\s+/g, ' ');
}

export function collapseVariantSiblings<T extends { name: string }>(items: T[]): T[] {
  if (items.length < 2) return items;
  const groupSizes = new Map<string, number>();
  for (const it of items) {
    const b = baseName(it.name);
    if (b.length >= 3) groupSizes.set(b, (groupSizes.get(b) ?? 0) + 1);
  }
  const sent = new Set<string>();
  return items.filter((it) => {
    const b = baseName(it.name);
    // Not part of a sibling group — keep as-is.
    if (b.length < 3 || (groupSizes.get(b) ?? 0) < 2) return true;
    if (sent.has(b)) return false;
    sent.add(b);
    return true;
  });
}
