/**
 * Storefront a11y + SEO regressions (static assertions, no dependencies).
 *
 *   node scripts/test-storefront-a11y-seo-fixes.mjs
 *
 * Covers:
 *   - App no longer overwrites the shell/product title with generic META
 *   - non-product routes drop stale Product JSON-LD
 *   - setPageMeta always publishes og:image and twitter:image
 *   - footer wordmark is a keyboard-reachable button with a gold focus ring
 *   - InfoModal and product modals trap focus, restore focus, and lock scroll
 *   - plain-stock products can be added without size/colour selections
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const app = read('src/App.js');
const css = read('src/index.css');
const seo = read('src/lib/seo.js');
const product = read('src/pages/ProductPage.js');
const cart = read('src/pages/CartPage.js');
const drawer = read('src/components/shop/CartDrawer.js');
const variantLabel = read('src/lib/cart-variant.js');

// ─── [1] Metadata ownership ─────────────────────────────────────────────────
console.log('\n[1] Page metadata and product JSON-LD');
{
  const start = app.indexOf('const META = {');
  const end = app.indexOf('};', start);
  const meta = app.slice(start, end);
  ok(start !== -1 && end !== -1, 'App keeps an explicit META map for private routes');
  ok(!/\bhome\s*:\s*\{[^}]*\btitle\s*:/.test(meta), 'no generic Home title overwrites the static shell title');
  ok(!/\bproduct\s*:\s*\{[^}]*\btitle\s*:/.test(meta), 'no generic Product title overwrites the real product title');
  ok(/shop:\s*\{\s*title:\s*'Shop'/.test(meta), 'explicit shop metadata stays in place');
  ok(/import \{[^}]*clearProductJsonLd[^}]*\} from '\.\/lib\/seo'/.test(app), 'App imports the product JSON-LD clear helper');
  ok(/currentPage !== 'product'\)\s*clearProductJsonLd\(\)/.test(app), 'non-product routes clear stale product JSON-LD');
  ok(/meta\.title \? `\$\{meta\.title\} — ZASHM` : document\.title/.test(app), 'GA page views fall back to the live document title');
  ok(/useStore\.getState\(\)\.products\.find\(/.test(app), 'product page views resolve the loaded product title');
  ok(/pageTitle \|\| undefined/.test(app), 'GA never receives an empty page_title');
  ok(/currentPage === 'product' \? \{ \.\.\.meta, preserveTitle: true \} : meta/.test(app),
    'product routes keep the product title until ProductPage owns it');
}

// ─── [2] Social image fallback ──────────────────────────────────────────────
console.log('\n[2] Open Graph / Twitter image tags');
{
  const start = seo.indexOf('export function setPageMeta');
  const end = seo.indexOf('// Inject the site-wide', start);
  const fn = seo.slice(start, end);
  ok(start !== -1 && end !== -1, 'setPageMeta is present in the SEO helper');
  ok(/const socialImage = image \|\| defaultOgImage\(canonical\);/.test(fn), 'image is resolved once with an absolute fallback');
  ok(/setProp\('og:image', socialImage\);/.test(fn), 'og:image is written on every call');
  ok(/setNamed\('twitter:image', socialImage\);/.test(fn), 'twitter:image is written on every call');
  ok(!/if\s*\(\s*image\s*\)/.test(fn), 'no conditional image write remains in setPageMeta');
  ok(/canonical \|\| \(typeof window !== 'undefined' \? window\.location\.origin : ''\)/.test(seo), 'fallback uses canonical, then the live origin');
  ok(/new URL\('\/og-image\.jpg', base\)\.href/.test(seo), 'fallback image is an absolute /og-image.jpg URL');
  ok(/preserveTitle = false/.test(fn), 'setPageMeta can opt out of title replacement');
  ok(/preserveTitle && document\.title[\s\S]{0,120}document\.title/.test(fn), 'preserved title is reused for the document and social tags');
}

// ─── [3] Footer wordmark ────────────────────────────────────────────────────
console.log('\n[3] Footer wordmark keyboard access');
{
  ok(/<button\s+type="button"\s+className="footer-wordmark"\s+aria-label="ZASHM"/.test(app), 'wordmark is a labelled real button');
  ok(!/className="footer-wordmark"[\s\S]{0,120}role="presentation"/.test(app), 'presentation role is gone');
  ok(/newCount === 5/.test(app), 'the five-click admin entry is preserved');

  const baseStart = css.indexOf('.footer-wordmark {');
  const baseEnd = css.indexOf('\n}', baseStart);
  const base = css.slice(baseStart, baseEnd);
  ok(baseStart !== -1 && baseEnd !== -1, 'wordmark has a base CSS rule');
  ok(!/outline:\s*none/.test(base), 'the base rule does not suppress focus');

  const focusStart = css.indexOf('.footer-wordmark:focus-visible {');
  const focusEnd = css.indexOf('\n}', focusStart);
  const focus = css.slice(focusStart, focusEnd);
  ok(focusStart !== -1 && focusEnd !== -1, 'wordmark has a focus-visible rule');
  ok(/outline:\s*2px solid var\(--gold\)/.test(focus), 'focus ring uses the gold brand token');
}

// ─── [4] InfoModal focus and scroll contract ────────────────────────────────
console.log('\n[4] InfoModal focus and scroll contract');
{
  const start = app.indexOf('function InfoModal(');
  const end = app.indexOf('/* ================= FOOTER', start);
  const modal = app.slice(start, end);
  ok(start !== -1 && end !== -1, 'InfoModal is present in App');
  ok(/const opener = document\.activeElement/.test(modal), 'the opener is captured before focus moves');
  ok(/getFocusableElements\(dialog\)/.test(modal), 'focusable children are enumerated');
  ok(/focusFirstElement\(dialog\)/.test(modal), 'focus falls back into the dialog');
  ok(/trapTabKey\(event, dialog\)/.test(modal), 'Tab is trapped inside the dialog');
  ok(/onBlur=\{\(event\) => redirectOutsideFocus\(/.test(modal)
    && /relatedTarget \|\| event\.target/.test(modal), 'outside focus is pulled back inside');
  ok(/document\.body\.style\.overflow = 'hidden'/.test(modal), 'background scroll is locked');
  ok(/document\.body\.style\.overflow = previousOverflow/.test(modal), 'body overflow is restored on close/unmount');
  ok(/opener\.focus\(\)/.test(modal), 'focus is restored to the opener');
  ok(/event\.key === 'Escape'/.test(modal), 'Escape still closes the dialog');
  ok(/role="dialog"/.test(modal) && /aria-modal="true"/.test(modal), 'dialog semantics are preserved');
  ok(/ref=\{dialogRef\}/.test(modal), 'the dialog node is wired to the focus trap');
}

// ─── [5] Plain-stock add to bag ─────────────────────────────────────────────
console.log('\n[5] Plain-stock add-to-bag gating');
{
  ok(/const needsVariant = \(p\.sizes \|\| \[\]\)\.length > 0 \|\| \(p\.colors \|\| \[\]\)\.length > 0 \|\| hasVariantStock\(p\)/.test(product), 'needsVariant comes from declared options or variantStock');
  ok(/if \(needsVariant && !selSize\)/.test(product), 'size is only required for variant products');
  ok(/if \(needsVariant && !selColor\)/.test(product), 'colour is only required for variant products');
  ok(/addToCart\(p, needsVariant \? selSize : '', needsVariant \? selColor : '', qty\)/.test(product), 'plain products add with empty size and colour');
  ok(/Sorry, only \$\{currentVariantStock\} pieces are available\./.test(product), 'plain-stock notice omits size/colour');
  ok(/Size: \$\{selSize\} \/ Color: \$\{selColor\}/.test(product), 'variant notice keeps the selected variation');
  ok(/'This size and colour is sold out\.'\s*:\s*'This product is sold out\.'/.test(product),
    'plain stock gets its own sold-out copy');
  ok(/`Only \$\{currentVariantStock\} left in this size and colour`\s*:\s*`Only \$\{currentVariantStock\} left`/.test(product),
    'plain stock gets its own low-stock copy');

  ok(/export function itemVariationLabel\(item\)/.test(variantLabel), 'one shared variation label helper exists');
  ok(/if \(!size && !color\) return 'Standard'/.test(variantLabel), 'empty variations read as Standard');
  ok(/if \(!color\) return `Size \$\{size\}`/.test(variantLabel), 'one-sided variations keep their size');
  ok(/if \(!size\) return color/.test(variantLabel), 'one-sided variations keep their colour');
  ok(/import \{ itemVariationLabel \} from '\.\.\/lib\/cart-variant'/.test(cart), 'CartPage imports the shared label');
  ok(/import \{ itemVariationLabel \} from '\.\.\/\.\.\/lib\/cart-variant'/.test(drawer), 'CartDrawer imports the shared label');
  ok((cart.match(/itemVariationLabel\(item\)/g) || []).length >= 2,
    'bag and checkout both use the shared label');
  ok(/className="cart-drawer-meta">\{itemVariationLabel\(item\)\}/.test(drawer), 'the drawer no longer prints raw Size/Color');
  ok(!/item\?\.size \?\? 'N\/A'/.test(cart), 'no raw N/A size leaks into the bag');
  ok(!/item\?\.color \?\? 'N\/A'/.test(cart), 'no raw N/A colour leaks into checkout');
}

// ─── [6] Product modal focus contract ───────────────────────────────────────
console.log('\n[6] Product stock and size-guide modal focus');
{
  ok(/getFocusableElements, focusFirstElement, trapTabKey, redirectOutsideFocus/.test(product), 'ProductPage imports the focus helpers');

  const stockStart = product.indexOf('{stockModal.open && (');
  const guideStart = product.indexOf('{sizeGuideOpen && (');
  const zoomStart = product.indexOf('{zoomOpen && (');
  const stockBlock = product.slice(stockStart, guideStart);
  const guideBlock = product.slice(guideStart, zoomStart);
  ok(/ref=\{stockDialogRef\}/.test(stockBlock) && /role="dialog"/.test(stockBlock), 'stock dialog node is wired to the trap');
  ok(/ref=\{sizeGuideDialogRef\}/.test(guideBlock) && /role="dialog"/.test(guideBlock), 'size-guide dialog node is wired to the trap');

  const trapStart = product.indexOf('// كل مودالات الصفحة');
  const trapEnd = product.indexOf('// Lock the page behind modals', trapStart);
  const trap = product.slice(trapStart, trapEnd);
  ok(trapStart !== -1 && trapEnd !== -1, 'shared product-modal focus effect is present');
  ok(/const opener = document\.activeElement/.test(trap), 'product modal opener is captured');
  ok(/getFocusableElements\(dialog\)/.test(trap), 'product modal focusables are enumerated');
  ok(/focusFirstElement\(dialog\)/.test(trap), 'product modal focus falls back inside');
  ok(/trapTabKey\(event, dialog\)/.test(trap), 'product modal Tab is trapped');
  ok(/redirectOutsideFocus\(event, dialog\)/.test(trap), 'product modal outside focus is redirected');
  ok(/opener\.focus\(\)/.test(trap), 'product modal focus is restored');
  ok(/document\.body\.style\.overflow = 'hidden'/.test(product) && /document\.body\.style\.overflow = previousOverflow/.test(product), 'product modal scroll lock and restore are preserved');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
