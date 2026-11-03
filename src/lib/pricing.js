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

// Availability from variantStock may only come from keys that match the
// declared sizes × colors. Orphaned keys (e.g. a removed color) never make a
// product look in stock.
export function availableStock(product) {
  const pv = variantStockMap(product);
  if (!pv || Object.keys(pv).length === 0) {
    return Math.max(0, Number(product?.stock) || 0);
  }
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const colors = Array.isArray(product?.colors) ? product.colors : [];
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
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  const colors = Array.isArray(product?.colors) ? product.colors : [];
  const declared = new Set();
  for (const size of sizes) {
    for (const color of colors) declared.add(`${size}-${color}`);
  }
  return Object.keys(pv)
    .filter((key) => !declared.has(key))
    .map((key) => ({ key, qty: Number(pv[key]) || 0 }));
}
