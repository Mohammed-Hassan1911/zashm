// Plain-stock cart lines carry empty size/colour on purpose. Keep one shared
// label so the drawer, bag and checkout never expose raw " / " separators or
// N/A placeholders for a product that has no variations.
export function itemVariationLabel(item) {
  const size = String(item?.size ?? '').trim();
  const color = String(item?.color ?? '').trim();
  if (!size && !color) return 'Standard';
  if (!color) return `Size ${size}`;
  if (!size) return color;
  return `Size ${size} · ${color}`;
}
