/**
 * Sellable-variant contract — direct-to-API, storefront rule, SQL, migrations.
 *
 * The owner-approved rules this file locks in (2026-11-04):
 *   1أ products.stock is recomputed from the declared combinations only.
 *   2ج an orphaned variantStock key keeps its quantity, is never sold and never
 *      counted, and shows as an explicit Admin warning.
 *   3ب variantStock without declared sizes/colors is an invalid configuration —
 *      the product is not sellable (the Production inventory found no such row).
 *   4  one sellable-variant rule in the bag, the product page and the server; an
 *      unavailable line is marked with a Remove button and never deleted silently.
 *
 * Nothing here touches Production: api/orders.js runs against an in-memory fake
 * Supabase, and the SQL checks are file-content checks only.
 *
 * Run: node scripts/test-undefined-variant.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  availableStock,
  hasInvalidVariantConfig,
  hasVariantStock,
  isSellableVariant,
  orphanedVariantStock,
  sellableStockFor,
} from '../src/lib/pricing.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// Remove every function definition so a migration can be audited for the SQL it
// runs itself (grants, checks, probes) as opposed to the code it installs.
function stripFunctionBodies(src) {
  let out = src;
  for (;;) {
    const start = out.indexOf('CREATE OR REPLACE FUNCTION public.');
    if (start === -1) break;
    const end = out.indexOf('\n$$;', start);
    if (end === -1) break;
    out = out.slice(0, start) + out.slice(end + 4);
  }
  return out;
}

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Harness: run the real api/orders.js against a fake service-role client ───

const realLib = require('../api/_lib.js');
const libPath = require.resolve('../api/_lib.js');

let response = null;
let rpcCalls = [];
let telegramSends = 0;
let productRows = [];

const fakeSb = {
  from(table) {
    if (table === 'products') {
      return {
        select: () => ({
          in: async (_col, ids) => ({
            data: productRows.filter((p) => ids.includes(Number(p.id))),
            error: null,
          }),
        }),
      };
    }
    if (table === 'coupons') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    }
    if (table === 'orders') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    }
    throw new Error(`unexpected table in test harness: ${table}`);
  },
  rpc: async (name, args) => {
    rpcCalls.push({ name, args });
    return { data: [{ ok: true, orderId: args.p_order.id }], error: null };
  },
};

Object.assign(require.cache[libPath], {
  id: libPath,
  filename: libPath,
  loaded: true,
  exports: {
    ...realLib,
    json: (_res, status, body) => { response = { status, body }; },
    applyCors: () => {},
    handleOptions: () => {},
    readBody: async () => currentBody,
    clientIp: () => '203.0.113.9',
    rateLimitShared: async () => ({ allowed: true }),
    tooMany: () => { response = { status: 429, body: {} }; },
    supabaseAdmin: () => fakeSb,
    generateOrderId: () => 'ZSH-TESTPROBE000001-0001',
    parseOrderRow: (row) => ({ ...row }),
    sendTelegramNotification: async () => { telegramSends += 1; },
    buildOrderTelegramMessage: () => 'test message',
    trackingUrlFor: () => 'https://test.invalid/track',
    verifyTrackToken: () => true,
    cairoDateString: () => '2026-11-04',
  },
});

const handler = require('../api/orders.js');
let currentBody = null;

async function place(items, rows, extra = {}) {
  response = null;
  rpcCalls = [];
  telegramSends = 0;
  productRows = rows;
  currentBody = {
    items,
    customer: {
      name: 'Guard Probe', phone: '01012345678', email: '',
      address: '12 Probe Street', city: 'Cairo', notes: '',
    },
    idempotencyKey: 'probe-key-000001',
    ...extra,
  };
  const res = {
    status() { return this; }, json() { return this; },
    setHeader() { return this; }, end() { return this; },
  };
  await handler({ method: 'POST', headers: {}, query: {} }, res);
  return response;
}

// Mirrors production row 1793739505270547 (Jacket Boxy): colours are
// Black/Burgundy, yet variantStock still carries M-White and L-White.
const JACKET = () => ({
  id: 20, name: 'Jacket Boxy', category: 'Jackets', price: 2500, salePrice: 2000,
  stock: 18, active: true, sizes: ['S', 'M', 'L', 'XL'], colors: ['Black', 'Burgundy'],
  variantStock: { 'S-Black': 7, 'M-Black': 5, 'L-Black': 5, 'M-Burgundy': 1, 'M-White': 4, 'L-White': 4 },
  images: [], image: '',
});
// Legacy shape: variantStock exists but no sizes/colors were ever declared.
// Owner decision 3ب makes this an invalid configuration, not a sellable product.
const LEGACY = () => ({
  id: 21, name: 'Legacy Tee', category: 'Tees', price: 100, salePrice: null,
  stock: 5, active: true, variantStock: { 'M-Black': 5 }, images: [], image: '',
});
// A pool that declares sizes but forgot its colours (and the mirror case).
const HALF_CONFIG = (over = {}) => ({
  id: 22, name: 'Half Config', category: 'Tees', price: 100, salePrice: null,
  stock: 4, active: true, sizes: ['M'], colors: [],
  variantStock: { 'M-Black': 4 }, images: [], image: '', ...over,
});
// The mirror of LEGACY: option lists declared but the variant matrix was never
// filled — there is nothing to match a cart line against.
const POOLLESS = () => ({
  id: 23, name: 'Empty Matrix', category: 'Tees', price: 100, salePrice: null,
  stock: 5, active: true, sizes: ['M'], colors: ['Black'],
  variantStock: {}, images: [], image: '',
});
// No variants at all — used to isolate the pricing rule.
const PLAIN = (over = {}) => ({
  id: 30, name: 'Scarf', category: 'Accessories', price: 2500, salePrice: null,
  stock: 5, active: true, sizes: [], colors: [], variantStock: {}, images: [], image: '',
  ...over,
});
const line = (productId, size, color, qty = 1) => ({ productId, size, color, qty });

console.log('\n[1] direct POST to /api/orders with an undeclared variation');
{
  const r = await place([line(20, 'M', 'White')], [JACKET()]);
  eq(r.status, 422, 'a colour removed from the product is rejected even when its stock key exists');
  eq(rpcCalls.length, 0, 'the rejection happens before any database write');
  ok((r.body.errors || []).some((e) => /size or color/i.test(e)), 'the message names size or colour');
  const issue = (r.body.stockIssues || [])[0] || {};
  eq(issue.available, 0, 'the issue reports zero availability');
  eq(issue.missing, false, 'missing:false so only that one line is marked, not the whole product');
  eq(issue.color, 'White', 'the issue names the offending colour');
}
{
  const r = await place([line(20, 'XXL', 'Black')], [JACKET()]);
  eq(r.status, 422, 'an undeclared SIZE is rejected too');
  eq(rpcCalls.length, 0, 'no database call for an undeclared size');
}
{
  const r = await place([line(20, 'XL', 'Black')], [JACKET()]);
  eq(r.status, 422, 'a declared size with no stock key is still rejected');
  ok(!/invalid_product_config/i.test(JSON.stringify(r.body)), 'rejection is expressed as a bag-level error');
}
{
  const r = await place([line(20, 'm', 'white')], [JACKET()]);
  eq(r.status, 422, 'the check is exact-match, so lower-case variants cannot slip through');
}
{
  const r = await place([line(20, '', '')], [JACKET()]);
  eq(r.status, 422, 'an empty size/colour pair is rejected when options are declared');
}
{
  const r = await place([line(20, 'M', 'White'), line(20, 'S', 'Black')], [JACKET()]);
  eq(r.status, 422, 'a mixed cart (valid line + orphan line) is refused as a whole');
  eq(rpcCalls.length, 0, 'a partially invalid cart never reaches the database');
}
{
  // Owner decision 3ب (approved 2026-11-04, after the Production inventory
  // returned ZERO products in this shape — see migration check 0c).
  const r = await place([line(21, 'M', 'Black')], [LEGACY()]);
  eq(r.status, 422, 'a variant pool with no declared sizes/colors is refused, not sold by raw key');
  eq(rpcCalls.length, 0, 'the invalid configuration is caught before any database write');
  const issue = (r.body.stockIssues || [])[0] || {};
  eq(issue.productWide, true, 'the refusal is product-wide: no variation of it can be ordered');
  eq(issue.missing, false, 'the product is still on the catalogue, so it is not marked missing');
  ok((r.body.errors || []).some((e) => /options are not set up/i.test(e)),
    'the customer message blames the configuration, not the size or colour');
}
{
  // The mirror shape: colours declared, sizes forgotten.
  const r = await place([line(22, 'M', 'Black')], [HALF_CONFIG()]);
  eq(r.status, 422, 'a variant pool with sizes but no colors is refused too');
  eq(rpcCalls.length, 0, 'no database write for a half-declared product');
}
{
  // A product that declares options but has no variant pool is the mirror shape:
  // the server must not fall back to a global counter it cannot match.
  const r = await place([line(23, 'M', 'Black')], [POOLLESS()]);
  eq(r.status, 422, 'declared options with no variantStock stay unsellable');
  eq(rpcCalls.length, 0, 'and the refusal happens before any database write');
  const issue = (r.body.stockIssues || [])[0] || {};
  eq(issue.productWide, true, 'and the refusal marks the whole product');
  ok((r.body.errors || []).some((e) => /options are not set up/i.test(e)),
    'both broken-option shapes share one customer sentence');
}
{
  // The other legacy shape stays fully working: no variantStock at all, so the
  // global counter is the availability source (unchanged behaviour).
  const r = await place([line(30, '', '')], [PLAIN()]);
  eq(r.status, 200, 'a product without variants still purchases from its global stock');
  eq(rpcCalls.length, 1, 'the config guard does not touch plain products');
}
{
  const r = await place([line(20, 'S', 'Black', 2), line(20, 'M', 'Burgundy')], [JACKET()]);
  eq(r.status, 200, 'declared variations purchase normally');
  const items = rpcCalls[0].args.p_order.items;
  eq(items.length, 2, 'both declared lines are ordered');
  eq(items[0].unitPrice, 2000, 'server prices a declared variation from the DB sale price');
  eq(rpcCalls[0].args.p_order.subtotal, 6000, 'server-authoritative subtotal');
  eq(telegramSends, 1, 'a successful order notifies Telegram');
  eq(realLib.sendBarkNotification, undefined, 'Bark is not part of the notification path');
}

console.log('\n[1b] cart behaviour when an orphan line sits next to a valid line');
{
  const r = await place([line(20, 'S', 'Black', 2), line(20, 'M', 'White')], [JACKET()]);
  eq(r.status, 422, 'the whole order is refused (no partial charge, no partial stock move)');
  eq(rpcCalls.length, 0, 'nothing reaches the database while the bag holds an unsellable line');
  eq((r.body.stockIssues || []).length, 1, 'exactly one issue is reported — only the orphan line');
  const issue = (r.body.stockIssues || [])[0];
  eq(issue.color, 'White', 'the issue identifies the removed colour');
  eq(issue.requested, 1, 'the issue carries the quantity the customer asked for');
  ok(!JSON.stringify(r.body.stockIssues).includes('"S-Black"'),
    'the valid line is not flagged, so its quantity stays as the customer set it');
  eq((r.body.errors || []).length, 1, 'one customer-facing message, not one per line');
}
{
  const r = await place([line(20, 'M', 'White'), line(20, 'L', 'White')], [JACKET()]);
  const issues = r.body.stockIssues || [];
  eq(issues.length, 2, 'two orphan lines produce two issues');
  ok(issues.every((i) => i.available === 0 && i.missing === false),
    'every orphan issue is available:0 / missing:false');
}
{
  // An orphan line and a genuinely oversold line are reported together.
  const r = await place([line(20, 'S', 'Black', 9), line(20, 'M', 'White')], [JACKET()]);
  const errors = r.body.errors || [];
  eq(errors.length, 2, 'both problems are reported in one response');
  ok(errors.some((e) => /Only 7 piece/.test(e)), 'the oversold line still gets its exact remaining count');
  ok(errors.some((e) => /size or color/i.test(e)), 'the orphan line gets the discontinued-variation wording');
}
{
  // The customer recovery path: dropping the orphan line makes the SAME bag work.
  const rows = [JACKET()];
  const bad = await place([line(20, 'S', 'Black', 2), line(20, 'M', 'White')], rows);
  eq(bad.status, 422, 'first attempt is refused');
  const good = await place([line(20, 'S', 'Black', 2)], rows);
  eq(good.status, 200, 'after the orphan line is removed the order places normally');
  eq(good.body.success, true, 'the retry is a real success, not a silent fallback');
  eq(rpcCalls.length, 1, 'the refused attempt made no RPC call, the retry made exactly one');
}
{
  // Contrast: a deactivated product is a product-level problem (missing:true),
  // which marks every line of that product — the orphan case must stay
  // line-level so the other variations survive.
  const rows = [{ ...JACKET(), active: false }];
  const r = await place([line(20, 'S', 'Black'), line(20, 'M', 'Burgundy')], rows);
  eq(r.status, 422, 'an inactive product is refused');
  const issues = r.body.stockIssues || [];
  ok(issues.every((i) => i.missing === true), 'inactive products are flagged missing:true');
}
{
  // A legacy saved cart can also carry a size that was never declared.
  const r = await place([line(20, 'XXL', 'Black'), line(20, 'S', 'Black')], [JACKET()]);
  eq(r.status, 422, 'an undeclared size alongside a valid line is refused too');
  eq((r.body.stockIssues || []).length, 1, 'only the undeclared-size line is reported');
}

console.log('\n[1c] one rule, measured on the shared storefront helper');
{
  // src/lib/pricing.js is the only implementation the storefront reads; these are
  // the same numbers api/orders.js and atomic_place_order() enforce.
  eq(availableStock(JACKET()), 18, 'sellable total counts the declared combinations only (the orphans hold 8 unsellable units)');
  eq(orphanedVariantStock(JACKET()).length, 2, 'the two leftover White keys are reported');
  eq(orphanedVariantStock(JACKET()).reduce((s, o) => s + o.qty, 0), 8, 'report-only: their quantities stay intact');
  eq(hasVariantStock(JACKET()), true, 'Jacket Boxy is a variant product');
  eq(hasInvalidVariantConfig(JACKET()), false, 'a fully declared product has no configuration problem');
  eq(isSellableVariant(JACKET(), 'M', 'White'), false, 'a removed colour is not sellable');
  eq(sellableStockFor(JACKET(), 'M', 'White'), 0, 'an orphan key holds no sellable quantity');
  eq(isSellableVariant(JACKET(), 'XXL', 'Black'), false, 'an undeclared size is not sellable');
  eq(sellableStockFor(JACKET(), 'XL', 'Black'), 0, 'a declared combination with no stock key is zero');
  eq(sellableStockFor(JACKET(), 'S', 'Black'), 7, 'a declared combination sells its own quantity');
  eq(sellableStockFor(JACKET(), 's', 'black'), 0, 'the check is exact-match, like the server');
  eq(hasInvalidVariantConfig(LEGACY()), true, 'a variant pool with no declared options is an invalid configuration');
  eq(isSellableVariant(LEGACY(), 'M', 'Black'), false, 'nothing in an invalid configuration is sellable');
  eq(availableStock(LEGACY()), 0, 'and its orphan pool does not make it look in stock');
  eq(hasInvalidVariantConfig(HALF_CONFIG()), true, 'sizes without colours is the same failure');
  eq(hasInvalidVariantConfig(POOLLESS()), true, 'declared options with an empty matrix is the mirror failure');
  eq(isSellableVariant(POOLLESS(), 'M', 'Black'), false, 'and nothing in it is sellable either');
  eq(availableStock(POOLLESS()), 0, 'so it never looks in stock to the storefront');
  eq(sellableStockFor(POOLLESS(), 'M', 'Black'), 0, 'and its global counter cannot be ordered');
  eq(hasInvalidVariantConfig(PLAIN()), false, 'a product without variants is not a configuration problem');
  eq(sellableStockFor(PLAIN(), '', ''), 5, 'a product without variants keeps the global counter');
  eq(sellableStockFor({ ...PLAIN(), stock: -3 }, '', ''), 0, 'availability is never negative');
  eq(sellableStockFor({ ...JACKET(), variantStock: { 'S-Black': '7' } }, 'S', 'Black'), 7, 'a numeric string quantity still counts');
  eq(sellableStockFor({ ...JACKET(), variantStock: { 'S-Black': -3 } }, 'S', 'Black'), 0, 'a negative quantity counts as zero');
  eq(sellableStockFor({ ...JACKET(), sizes: null, colors: null }, 'S', 'Black'), 0, 'null option lists are an invalid configuration too');
}

console.log('\n[1d] the bag and the product page read that same helper');
{
  const storeSrc = read('src/store.js');
  ok(/import \{[^}]*isSellableVariant[^}]*\} from '.\/lib\/pricing'/.test(storeSrc),
    'store.js imports the shared sellable-variant rule');
  ok(/import \{[^}]*sellableStockFor[^}]*\} from '.\/lib\/pricing'/.test(storeSrc),
    'store.js imports the shared per-variant quantity');
  ok(/import \{[^}]*hasInvalidVariantConfig[^}]*\} from '.\/lib\/pricing'/.test(storeSrc),
    'store.js imports the invalid-configuration check');
  // addToCart, updateCartQty and the proactive check all refuse an undeclared
  // variation instead of trusting a raw variantStock key (the old GAP A).
  eq(storeSrc.split('if (!isSellableVariant(').length - 1, 3,
    'addToCart, updateCartQty and cartLineIssues all gate on isSellableVariant');
  ok(!/Number\(pv\[variantKey\]\) \|\| 0/.test(storeSrc),
    'no raw variantStock key lookup survives in the bag');
  eq(storeSrc.split('const available = sellableStockFor(').length - 1, 3,
    'all three read availability through sellableStockFor');

  // Proactive check: reads the live catalogue, marks lines, never mutates the cart.
  ok(/cartLineIssues: \(\) => \{/.test(storeSrc), 'store.js exposes cartLineIssues()');
  const checkRegion = storeSrc.slice(storeSrc.indexOf('cartLineIssues: () => {'), storeSrc.indexOf('reduceCartForStockIssues'));
  ok(!checkRegion.includes('_saveCart(') && !checkRegion.includes('set({'),
    'cartLineIssues() is read-only — checking the bag cannot edit it');
  ok(/reason: 'invalid_config'/.test(storeSrc) && /reason: 'undefined_variant'/.test(storeSrc)
    && /reason: 'out_of_stock'/.test(storeSrc) && /reason: 'oversold'/.test(storeSrc),
    'every line problem has its own reason for the UI');

  // Reconciliation: quantities drop when the server says so, unsellable lines are
  // returned for the shopper to remove (owner decision 4: no silent removal).
  ok(/unavailable\.push\(entry\);\s*\n\s*kept\.push\(item\);/.test(storeSrc),
    'an unsellable line stays in the bag and is returned as unavailable');
  ok(/return \{ reduced, unavailable \};/.test(storeSrc), 'the reconciler reports both outcomes');
  ok(/if \(si\.missing \|\| si\.productWide\) return true;/.test(storeSrc),
    'a product-wide refusal marks every line of that product');
  ok(!/automatically removed from your bag/.test(storeSrc), 'nothing claims a silent removal any more');

  // The submit gate: a bag the live catalogue already rejects never hits the API.
  ok(/const blockingIssues = get\(\)\.cartLineIssues\(\)\.filter\(i => i\.blocking\);/.test(storeSrc),
    'placeOrder() checks the live catalogue before calling the server');
  ok(/blockedLocally: true/.test(storeSrc), 'the local refusal is distinguishable from a server 422');
  ok(/stockIssues: blockingIssues\.map/.test(storeSrc),
    'the local refusal returns the same issue shape, so the UI has one rendering path');

  // One sentence per problem, worded identically on both sides of the wire — the
  // checkout can then drop a message the storefront already shows.
  const serverSrc = read('api/orders.js');
  for (const sentence of [
    'Sorry, this piece is out of stock',
    'remaining in stock',
    'This piece is no longer available in the selected size or color',
    'This product is not available to order right now — its size and color options are not set up.',
  ]) {
    ok(storeSrc.includes(sentence) && serverSrc.includes(sentence),
      `the "${sentence.slice(0, 42)}…" sentence is shared, not rephrased per layer`);
  }
}
{
  const productSrc = read('src/pages/ProductPage.js');
  ok(/const currentVariantStock = sellableStockFor\(p, selSize, selColor\)/.test(productSrc),
    'the product page measures the selected variation with the shared rule');
  ok(/const variantConfigInvalid = hasInvalidVariantConfig\(p\)/.test(productSrc)
    && /const isOutOfStock = variantConfigInvalid \|\| currentVariantStock <= 0/.test(productSrc),
    'an invalid configuration cannot be added to the bag from the product page');
  ok(/sellableStockFor\(p, s, selColor\) <= 0/.test(productSrc),
    'a size with nothing sellable in the chosen colour is shown as out of stock');
}

console.log('\n[1e] the checkout shows each marked line and offers Remove');
{
  const cartSrc = read('src/pages/CartPage.js');
  ok(/function LiveStockBanner\(\{ issues, detailed = true \}\)/.test(cartSrc),
    'one banner component serves the bag and the checkout form');
  ok(/function LineStockIssue\(\{ issue, onRemove \}\)/.test(cartSrc), 'each marked line carries its own issue strip');
  ok(/<LineStockIssue issue=\{issueByKey\.get\(item\?\.key\)\} onRemove=\{\(\) => removeFromCart\(item\?\.key\)\}/.test(cartSrc),
    'Remove is the shopper\'s action, wired to removeFromCart for that one line');
  ok(/nothing was taken out of your bag automatically/.test(cartSrc),
    'the banner states plainly that nothing was deleted');
  ok(/reduceCartForStockIssues\(result\.stockIssues\)/.test(cartSrc),
    'checkout applies the reconciliation as soon as the API refuses the order');
  ok(/const outcome = reduceCartForStockIssues\(result\.stockIssues\)/.test(cartSrc)
    && /reduced = outcome\.reduced;/.test(cartSrc) && /unavailable = outcome\.unavailable;/.test(cartSrc),
    'checkout reads both the lowered quantities and the unsellable lines');
  ok(/const lineIssues = cartLineIssues\(\)/.test(cartSrc) && /const liveIssues = cartLineIssues\(\)/.test(cartSrc),
    'both the bag and the checkout form check the live products before submitting');
  ok(cartSrc.includes('was lowered from'), 'a lowered quantity is announced with its old and new values');
  ok(cartSrc.includes('It stays in your bag until you remove it'), 'an unsellable line says it stays in the bag');

  // Message de-duplication: the banner and the per-line strip already name a
  // blocked line, so the server list is only repeated when the catalogue could not
  // show it (products not loaded, or a line only the server can see).
  ok(/const shownIssues = cartLineIssues\(\);/.test(cartSrc)
    && /const shownMessages = new Set\(shownIssues\.map\(i => i\.message\)\)/.test(cartSrc),
    'the refusal re-reads the live check before deciding what still needs saying');
  ok(/\.filter\(e => !shownMessages\.has\(e\)\)/.test(cartSrc),
    'a message the banner already shows is not repeated in the error list');
  ok(/unavailable\.filter\(r => !blockingKeys\.has\(r\.key\)\)/.test(cartSrc),
    'a line whose own strip marks it does not get a second notice');
  ok(/result\?\.blockedLocally/.test(cartSrc),
    'a locally blocked submission still gives feedback without a server round-trip');
  ok(/<LiveStockBanner issues=\{lineIssues\} detailed=\{false\} \/>/.test(cartSrc),
    'on the bag page the banner counts the pieces instead of echoing each line');
  ok(/<LiveStockBanner issues=\{liveIssues\} \/>/.test(cartSrc),
    'on the checkout form, where the lines are not listed, the banner keeps the full messages');
}

console.log('\n[2] the server refuses through one path and maps every RPC reason');
{
  const ordersSrc = read('api/orders.js');
  ok(ordersSrc.includes("reason === 'undefined_variant'"), 'api/orders.js handles undefined_variant');
  ok(/const sizeNotDeclared = !declaredSizes\.includes\(item\.size\);/.test(ordersSrc),
    'api/orders.js validates the size against the declared list (no "list empty ⇒ skip" escape hatch)');
  ok(/const colorNotDeclared = !declaredColors\.includes\(item\.color\);/.test(ordersSrc),
    'api/orders.js validates the colour against the declared list');
  ok(/if \(hasVariantStock && \(declaredSizes\.length === 0 \|\| declaredColors\.length === 0\)\)/.test(ordersSrc),
    'api/orders.js refuses a variant pool with no declared options (owner decision 3ب)');
  ok(ordersSrc.includes("reason === 'invalid_product_config'"), 'api/orders.js handles invalid_product_config');

  // One refusal helper, so a message cannot be worded three different ways.
  eq(ordersSrc.split('const rejectLine = ').length - 1, 1, 'there is exactly one way to refuse a line');
  ok(/if \(!stockErrors\.includes\(message\)\) stockErrors\.push\(message\);/.test(ordersSrc),
    'identical messages are deduplicated in the customer-facing list');
  ok(/existing\.requested = Math\.max\(existing\.requested, qty\);\s*\n\s*existing\.available = Math\.min\(existing\.available, available\);/.test(ordersSrc),
    'two lines of the same variation merge into one issue instead of duplicating');

  const undefinedMapping = ordersSrc.slice(ordersSrc.indexOf("reason === 'undefined_variant'"));
  ok(/available: 0/.test(undefinedMapping.slice(0, 1200)) && /productWide: false/.test(undefinedMapping.slice(0, 1200)),
    'undefined_variant marks one line only, so the other variations survive');
  const configMapping = ordersSrc.slice(ordersSrc.indexOf("reason === 'invalid_product_config'"));
  ok(/productWide: true/.test(configMapping.slice(0, 1400)),
    'invalid_product_config marks the whole product, because nothing in it can be sold');
}

console.log('\n[3] the guards live in atomic_place_order.sql (REVISION 10)');
{
  const sql = read('supabase/atomic_place_order.sql');
  ok(/REVISION 10/.test(sql), 'the canonical file documents the approved revision');
  ok(/'undefined_variant'/.test(sql), 'the RPC returns a specific reason for an undeclared variation');
  ok(/'invalid_product_config'/.test(sql), 'and a specific reason for an invalid configuration');
  ok(/v_size_list text\[\];/.test(sql) && /v_color_list text\[\];/.test(sql), 'option lists are declared as text arrays');
  ok(/SELECT array_agg\(opt\) INTO v_size_list/.test(sql), 'sizes are aggregated in a separate statement');
  ok(/NOT \(v_line\.size = ANY \(v_size_list\)\)/.test(sql), 'the guard tests the declared size list');
  ok(/NOT \(v_line\.color = ANY \(v_color_list\)\)/.test(sql), 'the guard tests the declared colour list');
  ok(!/jsonb_\w*del|variantStock"?\s*-\s*'/i.test(sql), 'the guard never removes a variantStock key');
  ok(!/DELETE FROM public\.products/.test(sql), 'no product rows are deleted by the RPC');

  // Owner decision 1أ: one shared rule for the stock rewrite, used by BOTH writers.
  ok(/CREATE OR REPLACE FUNCTION public\.zshm_sellable_stock\(\s*p_variant_stock jsonb,/.test(sql),
    'the declared-only total is one immutable SQL function');
  ok(/SET search_path = public, pg_temp/.test(sql), 'the helper pins its search_path');
  ok(/IMMUTABLE/.test(sql), 'the helper is IMMUTABLE so the recompute is deterministic');
  eq(sql.split('public.zshm_sellable_stock(v_var, v_prod.sizes, v_prod.colors)').length - 1, 2,
    'atomic_place_order AND atomic_adjust_stock both use the same recompute');
  ok(/~ '\^\-\?\[0-9\]\+\$'/.test(sql), 'stock values are parsed defensively, never cast blindly');
  ok(/AS kv\(key, value\)/.test(sql),
    'the legacy fallback names both jsonb_each_text columns (renaming one silently swaps key for value)');
  ok(/GREATEST\(/.test(sql), 'the recomputed stock can never go negative');
  ok(/REVOKE ALL ON FUNCTION public\.zshm_sellable_stock/.test(sql)
    && /GRANT EXECUTE ON FUNCTION public\.zshm_sellable_stock/.test(sql),
    'the helper is service-role only, like the RPCs that call it');
}

console.log('\n[4] the deployable change is two separate staged migrations');
{
  const mig = read('supabase/reject_undefined_variants.sql');
  const mig2 = read('supabase/declared_only_stock_recompute.sql');
  for (const [name, src] of [['reject_undefined_variants', mig], ['declared_only_stock_recompute', mig2]]) {
    ok(src.includes('NOT APPLIED'), `${name}.sql states it has not been applied`);
    ok(!/\bDROP\s+(TABLE|FUNCTION|COLUMN)\b/i.test(src), `${name}.sql contains no DROP`);
    ok(!/\bDELETE\s+FROM\b/i.test(src), `${name}.sql deletes no rows`);
    ok(!/\bTRUNCATE\b/i.test(src), `${name}.sql truncates nothing`);
    // Outside the RPC bodies the migration is definition-only: it moves no real
    // stock, which is what owner decision 2ج ("لا تحذف ولا تصفّر") requires.
    const bare = stripFunctionBodies(src);
    ok(!/\bUPDATE\s+public\.products\b/i.test(bare), `${name}.sql rewrites no product row directly`);
    ok(!/\bINSERT\s+INTO\b/i.test(bare), `${name}.sql inserts no row directly`);
    ok(!/\bDELETE\s+FROM\b/i.test(bare), `${name}.sql deletes no row directly`);
    ok(/SET search_path = public, pg_temp/.test(src), `${name}.sql pins its search_path`);
  }
  ok(/'undefined_variant'/.test(mig), 'migration 1 carries the variation guard');
  ok(/'invalid_product_config'/.test(mig), 'migration 1 carries the configuration guard');
  ok(mig.includes('ROLLBACK;'), 'migration 1 probes behaviour inside a rolled-back transaction');
  ok(/atomic_adjust_stock\(\) is NOT changed here/.test(mig), 'migration 1 keeps the cancel/restore lifecycle out of scope');
  ok(/0c\./.test(mig) && /inventory/i.test(mig), 'migration 1 keeps the 3ب legacy-config pre-flight inventory');
  ok(/0d\./.test(mig) && /REWRITTEN/i.test(mig), 'migration 1 previews the stock the recompute will write');

  // Migration 2 must refuse to run before migration 1 installed the helper.
  ok(/to_regprocedure\('public\.zshm_sellable_stock\(jsonb, jsonb, jsonb\)'\) IS NULL/.test(mig2),
    'migration 2 checks the helper dependency before replacing anything');
  ok(/apply supabase\/reject_undefined_variants\.sql first/.test(mig2),
    'and names the file to apply first');
  ok(/pg_get_functiondef/.test(mig2), 'migration 2 backs up the current function definition');

  // The copies must stay byte-identical or re-applying the canonical file could
  // silently drop a guard.
  const extract = (src, name) => {
    const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start === -1) return null;
    const end = src.indexOf('\n$$;', start);
    return end === -1 ? null : src.slice(start, end + 4);
  };
  const canon = read('supabase/atomic_place_order.sql');
  const pairs = [
    ['zshm_order_signature', canon, mig],
    ['zshm_sellable_stock', canon, mig],
    ['atomic_place_order', canon, mig],
    ['atomic_adjust_stock', canon, mig2],
  ];
  for (const [fn, from, to] of pairs) {
    const a = extract(from, fn);
    const b = extract(to, fn);
    ok(a !== null && b !== null, `${fn} found in both files`);
    // Compared with ok(), not eq(), so a mismatch cannot dump a 400-line body.
    ok(a === b, `${fn} is byte-identical between the migration and the canonical file`);
  }
  // Each function is defined exactly once per file — a stale second copy would
  // win at apply time and undo the guard.
  const occurrences = (text, fn) => text.split(`CREATE OR REPLACE FUNCTION public.${fn}(`).length - 1;
  eq(occurrences(canon, 'atomic_place_order'), 1, 'the canonical file defines atomic_place_order once');
  eq(occurrences(mig, 'atomic_place_order'), 1, 'migration 1 defines atomic_place_order once');
  eq(occurrences(mig, 'zshm_sellable_stock'), 1, 'migration 1 defines zshm_sellable_stock once');
  eq(occurrences(mig2, 'atomic_adjust_stock'), 1, 'migration 2 defines atomic_adjust_stock once');
  ok(!/CREATE OR REPLACE FUNCTION public\.atomic_adjust_stock\(/.test(mig),
    'migration 1 does not touch atomic_adjust_stock');
}

console.log('\n[4b] Admin shows the orphaned stock it refuses to sell');
{
  const adminSrc = read('src/pages/AdminApp.js');
  ok(/import \{[^}]*orphanedVariantStock[^}]*\} from '\.\.\/lib\/pricing'/.test(adminSrc),
    'the product editor imports the orphan report');
  ok(/import \{[^}]*hasInvalidVariantConfig[^}]*\} from '\.\.\/lib\/pricing'/.test(adminSrc),
    'and the invalid-configuration check');
  ok(/orphaned stock entr/.test(adminSrc) && /that cannot be sold/.test(adminSrc),
    'the warning counts the entries and the units that cannot be sold');
  ok(/cannot be sold[\s\S]{0,700}nothing[\s\S]{0,60}?deleted|Stock total shown here and saved on the product = declared combinations only/.test(adminSrc),
    'the warning explains that the count is declared-only and nothing is deleted');
  eq(adminSrc.split('key="__orphaned__"').length - 1, 1, 'the orphan panel renders once');
  ok(/role="alert"/.test(adminSrc), 'the panel is announced to screen readers');
  ok(!/update\('variantStock',\s*\{\}/.test(adminSrc), 'the panel offers no bulk-clear action');
}


console.log('\n[5] salePrice = 0 handling across server and storefront');
{
  const ordersSrc = read('api/orders.js');
  ok(/saleNum > 0/.test(ordersSrc) && /saleNum < priceNum/.test(ordersSrc),
    'server applies the sale price only when 0 < sale < price');
  ok(/unitPrice <= 0/.test(ordersSrc), 'server rejects zero and negative unit prices');

  const libSrc = read('api/_lib.js');
  ok(/else if \(!\(salePrice > 0\)\) salePrice = null;/.test(libSrc),
    'validateProductPayload turns a 0 sale price into null on every write path');
  const productsSrc = read('api/admin/products.js');
  ok(/validateProductPayload\(input/.test(productsSrc) && /validateProductPayload\(merged/.test(productsSrc),
    'both admin create and PATCH run through that normalisation');

  for (const [file, symbol] of [
    ['src/pages/ShopPage.js', 'effectivePrice'],
    ['src/components/shop/ProductCard.js', 'effectivePrice'],
    ['src/pages/ProductPage.js', 'effectivePrice'],
    ['src/pages/CartPage.js', 'effectivePrice'],
    ['src/components/shop/CartDrawer.js', 'effectivePrice'],
    ['src/store.js', 'effectivePrice'],
    ['src/lib/seo.js', 'effectivePrice'],
  ]) {
    ok(read(file).includes(symbol), `${file} renders/derives prices through ${symbol}`);
  }

  // No customer-facing file may re-implement the rule ad hoc.
  const strays = ['src/pages/ShopPage.js', 'src/pages/ProductPage.js', 'src/pages/CartPage.js',
    'src/components/shop/ProductCard.js', 'src/components/shop/CartDrawer.js', 'src/store.js',
    'src/lib/seo.js', 'src/pages/HomePage.js']
    .filter((f) => /\.salePrice\s*(\|\||\?|>=?\s)/.test(read(f)));
  eq(strays.join(','), '', 'no storefront file compares salePrice directly any more');

  const adminSrc = read('src/pages/AdminApp.js');
  ok(/must be lower than the original price/.test(adminSrc), 'Admin blocks a sale price at or above the price');
  ok(/rawSalePrice > 0 \? rawSalePrice : null/.test(adminSrc), 'Admin stores 0/empty as null, not as 0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
