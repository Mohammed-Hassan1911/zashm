/**
 * Storefront performance regression tests.
 *
 *   node scripts/test-storefront-performance.mjs
 *
 * Dependency-free static assertions for the low-risk desktop/mobile LCP and
 * CLS fixes. They prove that only /shop's responsive first row is prioritised,
 * the shop hero no longer delays its own text paint, a missing product reserves
 * the same viewport as its skeleton, and checkout does not warm the coupon API
 * or fetch the catalogue on its critical path. No network and no credentials.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importantDeclarations, ruleHeads, sameMultiset } from './lib/css-audit.mjs';
import { readCss, readOriginalCss } from './lib/css-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(resolve(root, relative), 'utf8');

let passed = 0;
let failed = 0;

function report(condition, message, detail) {
  if (condition) {
    passed += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${message}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ''}`);
  }
}

function ok(value, message, detail) {
  report(Boolean(value), message, detail ?? `got ${String(value)}`);
}

function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}

section(1, 'only the shop first row is the LCP candidate');
const productCard = read('src/components/shop/ProductCard.js');
ok(/export default function ProductCard\(\{ product, index = 0, priority = false \}\)/.test(productCard),
  'image priority is an explicit caller opt-in');
ok(/const isPriorityImage = Boolean\(priority\);/.test(productCard) &&
   /const skipEntrance = isPriorityImage \|\| index === 0;/.test(productCard),
  'priority images and the fade skip are separate decisions');
ok(/loading=\{isPriorityImage \? 'eager' : 'lazy'\}/.test(productCard) &&
   /fetchpriority=\{isPriorityImage \? 'high' : 'auto'\}/.test(productCard) &&
   !/index < 2/.test(productCard),
  'no hardcoded two-card row; only opted-in images are eager/high');
ok(/initial=\{skipEntrance \? false : \{ opacity: 0 \}\}/.test(productCard) &&
   /duration: 0\.3,[\s\S]*?delay: Math\.min\(Math\.max\(index, 0\), 5\) \* 0\.015/.test(productCard),
  'priority cards and each grid leader skip the entrance fade; later cards keep it');

const shopPage = read('src/pages/ShopPage.js');
ok(/const \[leadRowCount, setLeadRowCount\] = useState/.test(shopPage) &&
   /priority=\{index < leadRowCount\}/.test(shopPage),
  'the shop grid passes a responsive lead-row count to ProductCard');
ok(/matchMedia\('\(max-width: 768px\)'\)\.matches\) return 2;/.test(shopPage) &&
   /matchMedia\('\(max-width: 1100px\)'\)\.matches\) return 3;/.test(shopPage) &&
   /return 4;/.test(shopPage),
  'lead row follows the 2/3/4-column CSS breakpoints');
ok(/addEventListener\('change', sync\)/.test(shopPage) &&
   /removeEventListener\('change', sync\)/.test(shopPage),
  'a resized viewport updates the prioritised row and cleans up its listeners');

const homePage = read('src/pages/HomePage.js');
const productPage = read('src/pages/ProductPage.js');
const cartPage = read('src/pages/CartPage.js');
for (const [name, source] of [['home', homePage], ['product related', productPage], ['wishlist', cartPage]]) {
  ok(!/<ProductCard[\s\S]{0,200}?priority=/.test(source),
    `${name} grids stay lazy instead of eagerly downloading below-fold images`);
}

const heroStart = shopPage.indexOf('<header className="shop-hero">');
const heroEnd = shopPage.indexOf('</header>', heroStart);
const hero = heroStart >= 0 && heroEnd > heroStart ? shopPage.slice(heroStart, heroEnd) : '';
ok(/className="shop-hero-title"/.test(hero), 'the shop hero title is still present');
ok((hero.match(/initial=\{false\}/g) || []).length >= 4,
  'all four hero elements render in their final state without an opacity delay');
ok(!/transition=\{\{[^}]*delay:/.test(hero),
  'no hero transition delays the first text paint');

section(2, 'missing product does not collapse the skeleton');
const css = readCss();
ok(/className="product-not-found-shell"/.test(productPage),
  'the settled not-found view uses the reserved-height shell');
ok(/<h1[\s\S]{0,200}Product not found\./.test(productPage) &&
   /Back to Shop/.test(productPage),
  'the not-found heading and recovery action remain accessible');
ok(/\.product-not-found-shell\s*\{[^}]*min-height:\s*100svh[^}]*\}/.test(css) &&
   /\.page-skeleton\s*\{[^}]*min-height:\s*100svh[^}]*\}/.test(css),
  'skeleton and not-found view reserve the same viewport');
ok(/\.page-skeleton-product-image\s*\{[^}]*max-height:\s*60svh[^}]*\}/.test(css),
  'the tall skeleton image is capped so its computed height stays inside one viewport');
ok(/\.page-skeleton-product\s*\{[^}]*box-sizing:\s*border-box[^}]*height:\s*100svh[^}]*overflow:\s*hidden[^}]*\}/.test(css),
  'the whole product skeleton is clamped to one viewport, including the one-column mobile layout');
ok(!/product\/1\b/.test(productPage) && !/\bid\s*[:=]\s*1\b/.test(read('scripts/test-storefront-performance.mjs')),
  'the fix and its regression test do not depend on a fake Product ID 1');

section(3, 'cart/checkout critical path stays quiet');
const app = read('src/App.js');
ok(/route\.page === 'checkout'[\s\S]{0,300}?requestIdleCallback\(\(\) => \{[\s\S]{0,140}?refreshProducts\(\)\.catch/.test(app) &&
   /await refreshProducts\(\);/.test(app),
  'catalogue fetch is deferred with a rejection handler only on checkout and still runs on shop pages');
ok(/let idleHandle;/.test(app) &&
   /let cancelled = false;/.test(app) &&
   /if \(cancelled\) return;/.test(app) &&
   /cancelIdleCallback\(idleHandle\)/.test(app) &&
   /loadOnlineData\(\)\.catch/.test(app),
  'the idle callback is cancellable and every async path has a rejection handler');
ok(/if \(!cancelled && session\) \{[\s\S]{0,80}?await refreshOrders\(\);/.test(app),
  'authenticated order refresh is unchanged apart from cancellation');
ok(/const productsLoadStatus = useStore\(\(state\) => state\.productsLoadStatus\)/.test(app) &&
   /const productCatalogPending = productsLoadStatus === 'idle' \|\| productsLoadStatus === 'loading';/.test(app) &&
   /ready=\{currentPage !== 'product' \|\| !productCatalogPending\}/.test(app) &&
   /if \(ready\) onReady\(\);/.test(app),
  'the first footer mount on /product waits for the catalogue so a real product cannot grow the page under it');

ok(!/React\.useEffect\(\(\) => \{ warmCouponEndpoint\(\); \}, \[\]\)/.test(cartPage),
  'checkout no longer sends a coupon preflight before first paint');
ok(/onFocus=\{warmCouponEndpoint\}/.test(cartPage) &&
   /method: 'OPTIONS'/.test(cartPage),
  'the coupon endpoint is still warmed when the shopper focuses the field');

section(4, 'route CSS split preserves the original cascade');
const shopCss = read('src/styles/shop.css');
const adminCss = read('src/styles/admin.css');
const productCss = read('src/styles/product.css');
ok(/@media \(max-width: 767px\)[\s\S]*?\.shop-sort \{\s*min-height:\s*32px/.test(shopCss) &&
   /@media \(max-width: 767px\)[\s\S]*?\.shop-chip,[\s\S]*?min-height:\s*32px/.test(read('src/index.css')),
  'shop breakpoint overrides stay with their base selectors in one cascade step');
ok(/@media \(max-width: 480px\)[\s\S]*?\.admin-login-wordmark/.test(adminCss),
  'the admin login breakpoint override lives in the admin sheet');
ok(/\.product-gallery-frames/.test(productCss) && /\.review-form/.test(productCss),
  'product gallery and review styles stay in the product sheet');
ok(!/!important/.test(shopCss), 'the shop split did not need an !important escape hatch');
ok(!/styles\/(admin|shop|product)\.css/.test(read('index.html')),
  'the initial shell only links the base stylesheet');
ok(/import '\.\.\/styles\/admin\.css'/.test(read('src/pages/AdminApp.js')) &&
   !/styles\/admin\.css/.test(read('src/pages/ShopPage.js') + read('src/pages/ProductPage.js')),
  'admin CSS is imported only by the admin route');
ok(/import '\.\.\/styles\/shop\.css'/.test(read('src/pages/ShopPage.js')) &&
   /import '\.\.\/styles\/product\.css'/.test(read('src/pages/ProductPage.js')),
  'shop and product CSS are imported only by their own pages');
ok(readCss().includes('.shop-sort-wrap'),
  'the test helper rebuilds the original cascade from the split inputs');

const baseCss = read('src/index.css');
const originalHeads = ruleHeads(readOriginalCss());
const outputHeads = [baseCss, adminCss, shopCss, productCss].flatMap(ruleHeads);
ok(sameMultiset(outputHeads, originalHeads),
  'every original rule selector remains in exactly one generated sheet',
  `original ${originalHeads.length}, generated ${outputHeads.length}`);

const baseHeads = new Set(ruleHeads(baseCss));
for (const [name, css] of [['admin', adminCss], ['shop', shopCss], ['product', productCss]]) {
  const duplicated = ruleHeads(css).filter((head) => baseHeads.has(head));
  ok(duplicated.length === 0,
    `${name} sheet has no selector duplicated in the base cascade`,
    duplicated.slice(0, 3).join(' | '));
}
const importantBefore = importantDeclarations(readOriginalCss());
const importantAfter = [baseCss, adminCss, shopCss, productCss].flatMap(importantDeclarations);
ok(sameMultiset(importantBefore, importantAfter),
  'the split moved the original !important declarations without changing them',
  `${importantBefore.length} -> ${importantAfter.length}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
