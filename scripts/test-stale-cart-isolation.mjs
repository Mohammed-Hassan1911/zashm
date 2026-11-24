/**
 * Stale cart isolation — a bag persisted before an environment change must not
 * load an image from a different Supabase project, and a line whose product is
 * no longer in the active catalogue must block checkout instead of being
 * silently ordered. Nothing here touches a live project.
 *
 * Run: node scripts/test-stale-cart-isolation.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'src/store.js'), 'utf8');
const PROD = 'https://ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/old.jpg';
const STAGE = 'https://sfenutmgfawuhmvwkmhv.supabase.co/storage/v1/object/public/products/new.jpg';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ok  ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}`); }
};
const eq = (actual, expected, label) => ok(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// Evaluate the two pure helpers with a controlled SUPABASE_URL. Only the helper
// block is taken from the real file, so the test cannot drift from the code.
function helpersFor(url) {
  const start = src.indexOf('function allowedCartImage');
  const end = src.indexOf('// Safe array reader for persisted state');
  if (start === -1 || end === -1 || end < start) throw new Error('cart image helpers not found');
  const block = src.slice(start, end).replace(/^function allowedCartImage/m, 'function allowedCartImage');
  return new Function('SUPABASE_URL', `${block}\nreturn { allowedCartImage, sanitizeCartImages };`)(url);
}

console.log('\n[1] image origin guard');
{
  const { allowedCartImage } = helpersFor('https://sfenutmgfawuhmvwkmhv.supabase.co');
  eq(allowedCartImage(STAGE, 'https://sfenutmgfawuhmvwkmhv.supabase.co'), STAGE, 'current project storage URL is kept');
  eq(allowedCartImage(PROD, 'https://sfenutmgfawuhmvwkmhv.supabase.co'), '', 'other project storage URL is dropped');
  eq(allowedCartImage('https://evil.example/x.jpg', 'https://sfenutmgfawuhmvwkmhv.supabase.co'), '', 'unrelated absolute URL is dropped');
  eq(allowedCartImage('data:image/svg+xml,%3Csvg/%3E', 'https://sfenutmgfawuhmvwkmhv.supabase.co'), 'data:image/svg+xml,%3Csvg/%3E', 'inline SVG fallback is kept');
  eq(allowedCartImage('/zashm-z-monogram.webp', 'https://sfenutmgfawuhmvwkmhv.supabase.co'), '/zashm-z-monogram.webp', 'same-origin asset is kept');
  eq(allowedCartImage('//ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/old.jpg', 'https://sfenutmgfawuhmvwkmhv.supabase.co'), '', 'protocol-relative foreign URL is dropped');
  eq(allowedCartImage('not a url', 'https://sfenutmgfawuhmvwkmhv.supabase.co'), '', 'malformed URL is dropped');
  eq(allowedCartImage(STAGE, ''), '', 'missing project URL fails closed');
}

console.log('\n[2] persisted cart sanitization');
{
  const { sanitizeCartImages } = helpersFor('https://sfenutmgfawuhmvwkmhv.supabase.co');
  const stale = [{ key: 'old::M::Beige', productId: 1795385879888720, image: PROD,
    product: { id: 1795385879888720, name: 'Old Money Pants', images: [PROD], image: PROD },
    size: 'M', color: 'Beige', qty: 1 }];
  const clean = sanitizeCartImages(stale);
  eq(clean.length, 1, 'the line itself is preserved for explicit removal');
  eq(clean[0].product.name, 'Old Money Pants', 'display name is preserved');
  eq(clean[0].qty, 1, 'quantity is preserved');
  eq(clean[0].product.images.length, 0, 'foreign product image is removed');
  eq(clean[0].product.image, '', 'foreign product.image is removed');
  eq(clean[0].image, '', 'foreign line image is removed');
  eq(JSON.stringify(clean).includes('ptegprcbtfylqhbnbkih'), false, 'no Production ref survives sanitization');
  const mixed = sanitizeCartImages([{ key: 'new', product: { id: 1, images: [PROD, STAGE], image: PROD } }]);
  eq(JSON.stringify(mixed[0].product.images), JSON.stringify([STAGE]), 'only the current project image survives a mixed list');
}

console.log('\n[3] wiring and checkout guard');
{
  ok(/cart:\s*sanitizeCartImages\(safeParseArray\('zashm_cart'/.test(src), 'persisted cart is sanitized on load');
  ok(/const safeCart = sanitizeCartImages\(\(cart \|\| \[\]\)\.filter/.test(src), 'cart is sanitized again on save');
  ok(/if \(!live\) \{[\s\S]*?blocking:\s*true[\s\S]{0,200}reason:\s*'missing_product'/.test(src), 'missing catalog product is a blocking issue');
  ok(/reason: 'missing_product'[\s\S]{0,300}Please remove it from your bag/.test(src), 'shopper is told to remove the stale line');
  ok(!src.includes('ptegprcbtfylqhbnbkih'), 'store source contains no Production ref');
  const cartPage = readFileSync(path.join(ROOT, 'src/pages/CartPage.js'), 'utf8');
  const handleStart = cartPage.indexOf('const handleOrder = async () => {');
  const placeCall = cartPage.indexOf('await placeOrder(', handleStart);
  const blockGuard = cartPage.indexOf('if (blockingNow.length > 0)', handleStart);
  ok(handleStart !== -1 && blockGuard !== -1 && placeCall !== -1 && blockGuard < placeCall,
    'handleOrder checks blocking issues before calling placeOrder');
  ok(/if \(blockingNow\.length > 0\) \{[\s\S]{0,160}return;\s*\}/.test(cartPage),
    'the blocking guard returns before any order request');
}

console.log('\n[4] missing-product block only on a live catalogue');
{
  // Execute the real cartLineIssues body with a stubbed store and harmless
  // pricing helpers, so the catalogue-source gate cannot drift from the test.
  const marker = 'cartLineIssues: () => {';
  const start = src.indexOf(marker);
  const end = src.indexOf('\n  },\n\n  // Reconciliation after the server refused the order.', start);
  if (start === -1 || end === -1) throw new Error('cartLineIssues body not found');
  const body = src.slice(start + marker.length, end);
  const run = new Function('get', 'hasInvalidVariantConfig', 'isSellableVariant', 'sellableStockFor', 'hasVariantStock', body);
  const issuesFor = (state) => run(() => state, () => false, () => true, () => 99, () => false);
  const staleLine = { key: 'stale', product: { id: 1795385879888720, name: 'Old Money Pants' }, qty: 1 };
  const liveLine = { key: 'live', product: { id: 1, name: 'Current Tee' }, qty: 1 };
  const products = [{ id: 1, name: 'Current Tee', stock: 9 }];

  const live = issuesFor({ cart: [staleLine, liveLine], products, productsSource: 'live' });
  eq(live.length, 1, 'a stale line is flagged against a live catalogue');
  eq(live[0].reason, 'missing_product', 'the issue reason is missing_product');
  eq(live[0].blocking, true, 'the stale line blocks checkout');
  eq(live[0].key, 'stale', 'the correct line is flagged');
  for (const source of ['cache', 'snapshot', 'idle', undefined]) {
    const degraded = issuesFor({ cart: [staleLine, liveLine], products, productsSource: source });
    eq(degraded.length, 0, `degraded catalogue '${source}' leaves the server authoritative`);
  }
  const notLoaded = issuesFor({ cart: [staleLine], products: [], productsSource: 'live' });
  eq(notLoaded.length, 0, 'an empty catalogue never blocks every cart line');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
