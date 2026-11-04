// Single source of truth for sale-price display rules (mirrored server-side in
// api/orders.js and api/_lib.js):
//   - salePrice 0 / null / invalid / >= price  → no discount, show price
//   - 0 < salePrice < price                    → show salePrice with price struck through

export function regularPrice(product) {
  const price = Number(product?.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

export function salePriceOf(product) {
  const price = regularPrice(product);
  const sale = Number(product?.salePrice);
  return Number.isFinite(sale) && sale > 0 && sale < price ? sale : null;
}

export function effectivePrice(product) {
  return salePriceOf(product) ?? regularPrice(product);
}

export function discountPercent(product) {
  const price = regularPrice(product);
  const sale = salePriceOf(product);
  if (!price || sale === null) return null;
  const pct = Math.round((1 - sale / price) * 100);
  return pct > 0 ? pct : null;
}

function variantStockMap(product) {
  const pv = product?.variantStock;
  return pv && typeof pv === 'object' && !Array.isArray(pv) ? pv : null;
}

// Compare option labels the same way the admin form/API do: trim, collapse
// runs of whitespace and ignore case. The ORIGINAL spelling of the first
// occurrence is preserved so variantStock keys keep matching; only repeats are
// dropped. Duplicate entries must never inflate a stock total.
function normalizeOptionKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function uniqueDeclaredOptions(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const unique = [];
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = normalizeOptionKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

// Stock that can actually be sold = sum of the declared size × colour keys
// only. Orphans are excluded and duplicate declared options are counted once.
export function declaredVariantStockTotal(variantStock, sizes, colors) {
  const pv = variantStock && typeof variantStock === 'object' && !Array.isArray(variantStock)
    ? variantStock
    : {};
  const uniqueSizes = uniqueDeclaredOptions(sizes);
  const uniqueColors = uniqueDeclaredOptions(colors);
  if (uniqueSizes.length === 0 || uniqueColors.length === 0) return 0;
  let total = 0;
  for (const size of uniqueSizes) {
    for (const color of uniqueColors) {
      const qty = Number(pv[`${size}-${color}`]);
      if (Number.isFinite(qty) && qty > 0) total += qty;
    }
  }
  return total;
}

export function hasVariantStock(product) {
  const pv = variantStockMap(product);
  return !!(pv && Object.keys(pv).length > 0);
}

export function declaredOptions(product) {
  return {
    sizes: Array.isArray(product?.sizes) ? product.sizes : [],
    colors: Array.isArray(product?.colors) ? product.colors : [],
  };
}

// The sellable-variant rule (owner decision 2026-11-04), mirrored server-side in
// api/orders.js and supabase/atomic_place_order.sql:
//   - no variantStock and no declared options → plain stock product
//   - variantStock with no declared sizes or colors, OR declared sizes/colors
//     with no variantStock → the variant configuration is broken and nothing in
//     the product is sellable: there is nothing to match a line against.
//   - otherwise → size AND colour must both still be declared
// A leftover variantStock key (e.g. of a removed colour) is therefore not
// permission to sell: the key and its quantity are kept untouched and only the
// admin who declares it again can sell it (owner decision 2ج).
export function hasInvalidVariantConfig(product) {
  const { sizes, colors } = declaredOptions(product);
  if (hasVariantStock(product)) return sizes.length === 0 || colors.length === 0;
  return sizes.length > 0 || colors.length > 0;
}

export function isSellableVariant(product, size, color) {
  if (hasInvalidVariantConfig(product)) return false;
  if (!hasVariantStock(product)) return true;
  const { sizes, colors } = declaredOptions(product);
  return sizes.includes(size) && colors.includes(color);
}

// Quantity a shopper may actually order for one variation: the declared variant
// pool, or the global counter for products without variants. Never negative.
export function sellableStockFor(product, size, color) {
  if (!isSellableVariant(product, size, color)) return 0;
  if (hasVariantStock(product)) {
    const qty = Number(variantStockMap(product)[`${size}-${color}`]);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
  }
  const stock = Number(product?.stock);
  return Number.isFinite(stock) && stock > 0 ? stock : 0;
}

// Availability from variantStock may only come from keys that match the
// declared sizes × colors. Orphaned keys (e.g. a removed color) never make a
// product look in stock, and a broken variant configuration has nothing sellable
// at all — the same answer the server gives.
export function availableStock(product) {
  if (hasInvalidVariantConfig(product)) return 0;
  const pv = variantStockMap(product);
  if (!pv || Object.keys(pv).length === 0) {
    return Math.max(0, Number(product?.stock) || 0);
  }
  const sizes = uniqueDeclaredOptions(product?.sizes);
  const colors = uniqueDeclaredOptions(product?.colors);
  let total = 0;
  for (const size of sizes) {
    for (const color of colors) {
      const qty = Number(pv[`${size}-${color}`]);
      if (Number.isFinite(qty) && qty > 0) total += qty;
    }
  }
  return total;
}

// Keys present in variantStock that do not match any declared size × color.
// Reported for admin conflict warnings; never auto-deleted.
export function orphanedVariantStock(product) {
  const pv = variantStockMap(product);
  if (!pv) return [];
  const sizes = uniqueDeclaredOptions(product?.sizes);
  const colors = uniqueDeclaredOptions(product?.colors);
  const declared = new Set();
  for (const size of sizes) {
    for (const color of colors) declared.add(`${size}-${color}`);
  }
  return Object.keys(pv)
    .filter((key) => !declared.has(key))
    .map((key) => ({ key, qty: Number(pv[key]) || 0 }));
}
