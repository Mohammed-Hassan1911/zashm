/**
 * Unified sale-price + variant-availability regression tests.
 *
 *   node scripts/test-pricing.mjs
 *
 * Rule under test (owner-approved):
 *   - salePrice 0 / null / invalid / >= price → no discount, show price
 *   - 0 < salePrice < price                   → show salePrice (price struck)
 *   - variantStock availability counts ONLY keys matching declared sizes × colors.
 */
import { readFileSync } from 'node:fs';
import {
  regularPrice,
  salePriceOf,
  effectivePrice,
  discountPercent,
  availableStock,
  orphanedVariantStock,
  uniqueDeclaredOptions,
  declaredVariantStockTotal,
} from '../src/lib/pricing.js';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

console.log('\n[1] effectivePrice: sale-price display rule');
{
  eq(effectivePrice({ price: 2500, salePrice: 2000 }), 2000, 'valid sale price wins');
  eq(effectivePrice({ price: 2500, salePrice: 0 }), 2500, 'salePrice 0 → regular price');
  eq(effectivePrice({ price: 2500, salePrice: null }), 2500, 'salePrice null → regular price');
  eq(effectivePrice({ price: 2500, salePrice: undefined }), 2500, 'missing salePrice → regular price');
  eq(effectivePrice({ price: 2500, salePrice: '' }), 2500, 'empty-string salePrice → regular price');
  eq(effectivePrice({ price: 2500, salePrice: 2500 }), 2500, 'salePrice equal to price → regular price');
  eq(effectivePrice({ price: 2500, salePrice: 3000 }), 2500, 'salePrice above price → regular price (never misleading)');
  eq(effectivePrice({ price: 2500, salePrice: -100 }), 2500, 'negative salePrice → regular price');
  eq(effectivePrice({ price: 2500, salePrice: 'abc' }), 2500, 'non-numeric salePrice → regular price');
  eq(effectivePrice({ price: 2500, salePrice: '2000' }), 2000, 'numeric-string salePrice honored');
  eq(effectivePrice({ price: null, salePrice: null }), 0, 'null price → 0 (never crashes toLocaleString)');
  eq(effectivePrice(undefined), 0, 'missing product → 0');
  eq(effectivePrice({ price: '2500', salePrice: 0 }), 2500, 'numeric-string price with salePrice 0 → price');
}

console.log('\n[2] discountPercent');
{
  eq(discountPercent({ price: 2500, salePrice: 2000 }), 20, '20% off');
  eq(discountPercent({ price: 2500, salePrice: 0 }), null, 'salePrice 0 → no badge');
  eq(discountPercent({ price: 2500, salePrice: null }), null, 'null sale → no badge');
  eq(discountPercent({ price: 2500, salePrice: 3000 }), null, 'sale above price → no badge (never "--13%")');
  eq(discountPercent({ price: 2500, salePrice: 2500 }), null, 'equal prices → no badge');
  eq(discountPercent({ price: 0, salePrice: 500 }), null, 'zero price → no badge');
}

console.log('\n[3] salePriceOf + regularPrice');
{
  eq(salePriceOf({ price: 2500, salePrice: 2000 }), 2000, 'valid sale returned');
  eq(salePriceOf({ price: 2500, salePrice: 0 }), null, '0 is not a sale');
  eq(regularPrice({ price: null }), 0, 'null price → 0');
  eq(regularPrice({ price: -50 }), 0, 'negative price → 0 (never shown as negative)');
}

console.log('\n[4] availableStock: orphaned variant keys never surface');
{
  const declared = {
    price: 1, stock: 18,
    sizes: ['S', 'M'], colors: ['Black', 'Burgundy'],
    variantStock: { 'S-Black': 7, 'M-Burgundy': 1, 'M-White': 4, 'L-White': 99 },
  };
  eq(availableStock(declared), 8, 'only declared size × color keys count');
  eq(availableStock({ stock: 5 }), 5, 'no variantStock → stock column');
  eq(availableStock({ stock: 5, variantStock: {} }), 5, 'empty variantStock → stock column');
  eq(availableStock({ stock: 5, variantStock: { 'M-White': 3 } }), 0, 'variant keys with no declared sizes/colors → nothing sellable');
  eq(availableStock({ stock: -4 }), 0, 'negative stock clamps to 0');
  eq(availableStock({ sizes: ['M'], colors: ['Off-White'], variantStock: { 'M-Off-White': 6 } }), 6, 'hyphenated color names match exactly');
  eq(availableStock({ sizes: ['M'], colors: ['Black'], variantStock: { 'M-Black': 'x' } }), 0, 'garbage qty → 0');
}

console.log('\n[4b] duplicated declared options count once');
{
  eq(uniqueDeclaredOptions(['S', ' s ', 'M', 'M']), ['S', 'M'],
    'trim + case-insensitive duplicates collapse to the first spelling');
  eq(uniqueDeclaredOptions([' X ', '', '   ', 'X']), ['X'],
    'blank option labels are dropped');
  eq(uniqueDeclaredOptions('S'), [], 'non-array input yields no options');

  const legacy = {
    price: 1, stock: 24,
    sizes: ['S', 'S', 'M', 'M'], colors: ['Black', 'Black'],
    variantStock: { 'S-Black': 7, 'M-Black': 5, 'S-White': 4 },
  };
  eq(declaredVariantStockTotal(legacy.variantStock, legacy.sizes, legacy.colors), 12,
    'shared helper sums each declared combination once (7 + 5, not 24)');
  eq(availableStock(legacy), 12, 'storefront availability is not inflated by duplicate lines');
  eq(orphanedVariantStock(legacy), [{ key: 'S-White', qty: 4 }],
    'the orphan key is still only reported, never counted');

  const caseVariant = {
    price: 1, stock: 99,
    sizes: ['s', 'S'], colors: ['Black'],
    variantStock: { 's-Black': 7, 'S-Black': 5 },
  };
  eq(availableStock(caseVariant), 7,
    'case-only duplicates collapse to the first spelling without renaming the stored key');
  eq(orphanedVariantStock(caseVariant), [{ key: 'S-Black', qty: 5 }],
    'the other spelling is reported as an orphan instead of being silently summed');
}

console.log('\n[5] orphanedVariantStock: report only, never mutate');
{
  const product = {
    sizes: ['M'], colors: ['Black'],
    variantStock: { 'M-Black': 2, 'M-White': 4, 'L-White': 9 },
  };
  eq(orphanedVariantStock(product), [
    { key: 'M-White', qty: 4 },
    { key: 'L-White', qty: 9 },
  ], 'lists stale keys with quantities');
  eq(orphanedVariantStock({ sizes: ['M'], colors: ['Black'], variantStock: { 'M-Black': 1 } }), [], 'clean product has no conflicts');
  eq(orphanedVariantStock({}), [], 'no variantStock → empty');
  eq(product.variantStock['M-White'], 4, 'reporting does not delete existing stock');
}

console.log('\n[6] server-side parity (api/orders.js + api/_lib.js)');
{
  const orders = readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
  ok(/saleNum > 0/.test(orders) && /saleNum < priceNum/.test(orders),
    'orders.js applies the 0 < sale < price rule');
  const lib = readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8');
  ok(/else if \(!\(salePrice > 0\)\) salePrice = null;/.test(lib),
    'validateProductPayload normalizes salePrice 0 → null');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
