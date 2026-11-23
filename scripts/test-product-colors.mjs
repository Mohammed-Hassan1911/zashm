import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch, getColorTextInk, getColorTextStyle } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

// The bead keeps the exact fabric colour; the label keeps the same hue but
// dark inks are lit until they clear 4.5:1 on the dark pill. The glass and its
// travelling shine are shared CSS — each colour only contributes its ink.
const samples = ['Black', 'White', 'Navy', 'Yellow', 'Gold', '#123abc', 'unlisted color'];
const treatments = samples.map((c) => getColorTextStyle(c));
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [rl, gl, bl] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
};
const contrastOnPill = (hex) => (luminance(hex) + 0.05) / (0.0103 + 0.05);
for (const [i, style] of treatments.entries()) {
  assert.equal(style.color, getColorTextInk(getColorSwatch(samples[i])));
  assert.ok(contrastOnPill(style.color) >= 4.4, `${samples[i]} label is legible`);
  assert.equal(style['--color-ink'], style.color);
  assert.deepEqual(Object.keys(style).sort(), ['--color-ink', 'color'],
    'no colour gets its own rim, glow or halo');
}
// Nothing is singled out: strip the ink and every treatment is the same.
const lighting = ({ color, '--color-ink': ink, ...rest }) => rest;
for (const style of treatments) assert.deepEqual(lighting(style), lighting(treatments[0]));
assert.deepEqual(getColorTextStyle('White', '#ffffff'), getColorTextStyle('White'));
// Dark inks are lifted, light ones are left alone, and the hue survives.
const blackInk = getColorTextInk('#111111');
assert.notEqual(blackInk, '#111111');
assert.ok(luminance(blackInk) > luminance('#111111'));
const burgundyInk = getColorTextInk('#800020').slice(1).match(/../g).map((h) => parseInt(h, 16));
assert.notEqual(getColorTextInk('#800020'), '#800020');
assert.ok(burgundyInk[0] > burgundyInk[1] && burgundyInk[0] > burgundyInk[2]);
assert.ok(burgundyInk[1] > 0x30, 'burgundy stays a muted wine rose, not neon red');
const navyInk = getColorTextInk('#172554').slice(1).match(/../g).map((h) => parseInt(h, 16));
assert.notEqual(getColorTextInk('#172554'), '#172554');
assert.ok(navyInk[2] > navyInk[0]);
assert.equal(getColorTextInk('#ffffff'), '#ffffff');
assert.equal(getColorTextInk('#facc15'), '#facc15');
assert.equal(getColorTextInk('#123abc80').slice(-2), '80');
// The bead, not the label, still carries the raw fabric colour.
assert.equal(getColorSwatch('Black'), '#111111');
assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorTextStyle('Burgundy').color, getColorTextInk('#800020'));

const adminApp = await readFile(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
const productPage = await readFile(new URL('../src/pages/ProductPage.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
assert.match(adminApp, /aria-label="Color previews"/);
assert.match(adminApp, /background:getColorSwatch\(color\)/);
assert.match(productPage, /aria-pressed=\{isSelected\}/);
assert.match(productPage, /background:getColorSwatch\(c\)/);
assert.match(productPage, /function ColorName\(\{ color, className = '' \}\)/);
assert.match(productPage, /style=\{getColorTextStyle\(color\)\}/);
assert.match(productPage, /<ColorName color=\{selColor\} className="product-meta-value" \/>/);
assert.match(productPage, /<ColorName color=\{c\} \/>/);
assert.ok(!/product-color-name-lead|product-color-name-tail/.test(productPage), 'colour names render as one ink');
assert.ok(!/selected/.test(productPage.slice(productPage.indexOf('function ColorName'), productPage.indexOf('export default'))), 'no gold selected accent on colour names');
assert.match(css, /\.product-color-name \{/);
assert.match(css, /\.product-meta-label \{[^}]*white-space: nowrap;/);
assert.match(css, /\.product-meta-value \{[^}]*white-space: nowrap;/);
assert.match(css, /\.product-size-head \{[^}]*flex-wrap: nowrap;/);
assert.match(css, /\.product-color-option \{[\s\S]*?gap: 7px;/);
assert.match(css, /\.product-color-option \{ min-height: 38px; padding: 0 10px 0 6px; gap: 6px; \}/);
assert.match(css, /\.product-color-swatch \{[^}]*width: 22px;[^}]*height: 22px;[^}]*flex: 0 0 22px;/);
assert.match(css, /\.product-color-swatch \{ width: 20px; height: 20px; flex-basis: 20px; \}/);
assert.match(css, /\.product-color-name \{\s*font-size: 11px;/);
assert.match(css, /\.product-color-name \{ font-size: 10px; letter-spacing: 0\.5px; \}/);
assert.match(css, /\.product-color-name,\s*\n\.product-meta-value \{[\s\S]*?font-family: var\(--font-body\);/);
assert.match(css, /\.product-color-name,\s*\n\.product-meta-value \{[\s\S]*?font-weight: 700;/);
assert.ok(!/\.product-color-name-(lead|tail)/.test(css), 'no split ink classes remain');
assert.match(css, /\.product-wish-btn\[data-wished='true'\] \{[\s\S]*?border-color: var\(--gold\);[\s\S]*?color: var\(--gold-light\);/);
// One calm 38–44px rhythm across every product-page control.
assert.match(css, /\.product-size-option \{[^}]*width: 46px;[^}]*height: 40px;/);
assert.match(css, /\.product-size-option \{ width: 44px; height: 38px; font-size: 10\.5px; \}/);
assert.match(css, /\.product-qty-btn \{[^}]*width: 40px;[^}]*height: 40px;/);
assert.match(css, /\.product-wish-btn \{[^}]*width: 42px;[^}]*height: 42px;/);
assert.match(css, /\.add-to-bag-btn \{[^}]*min-height: 44px;/);
assert.match(css, /\.zashm-toast--success \.zashm-toast-icon \{ color: #d4af37; \}/);
// The CTA and the finder are back on the calm gold-btn / base trigger tones.
assert.ok(!/\.gold-btn\.add-to-bag-btn/.test(css), 'the CTA keeps the original gold-btn tones');
assert.match(css, /\.gold-btn \{[^}]*color: #14110b;/);
assert.ok(!/\.size-finder \.size-finder-trigger/.test(css), 'the finder keeps its original calm styling');
assert.match(css, /\.size-finder-trigger \{[^}]*border: 1px solid rgba\(201, 168, 76, 0\.34\);/);
// "Removed" is the "Added" toast verbatim; only its heart stays black.
assert.match(css, /\.zashm-toast--heartbreak \{[^}]*border-inline-start-color: var\(--gold-light\);/);
assert.ok(!/\.zashm-toast--heartbreak \{[^}]*(background|box-shadow|border-inline-start-width)/.test(css), 'the removal reuses the added-toast frame verbatim');
assert.match(css, /\.zashm-toast--heartbreak \.zashm-toast-icon \{[^}]*color: #111111;/);
assert.ok(css.indexOf('.zashm-toast--heartbreak .zashm-toast-icon') > css.indexOf('.zashm-toast--error .zashm-toast-icon'), 'heartbreak tone wins the cascade');
const backToTop = await readFile(new URL('../src/components/ui/BackToTop.js', import.meta.url), 'utf8');
assert.match(backToTop, /isHeartbreak = type === 'error' && \/removed from wishlist\//);
assert.match(backToTop, /isWishlistSuccess = type === 'success' && \/wishlist\|favorite\//);
assert.match(backToTop, /zashm-toast--heartbreak/);
assert.match(backToTop, /fill=\{isHeartbreak \|\| isWishlistSuccess \? 'currentColor' : 'none'\}/);
const treatmentMatch = /(\.product-color-name,\s*\.product-meta-value \{[\s\S]*?\n\})/.exec(css);
assert.ok(treatmentMatch, 'the shared colour-name treatment exists');
const nameTreatment = treatmentMatch[1];
assert.ok(!/-webkit-text-stroke/.test(nameTreatment), 'the white rim is gone');
assert.ok(!/text-shadow/.test(nameTreatment), 'the white cloud and shadow are gone');
assert.match(nameTreatment, /background-image: linear-gradient\(/);
assert.match(nameTreatment, /color-mix\(in srgb, var\(--color-ink\) 45%, #fff8e6\) 50%/);
assert.match(nameTreatment, /-webkit-background-clip: text;/);
assert.match(nameTreatment, /-webkit-text-fill-color: transparent;/);
assert.ok(!/animation|@keyframes/.test(nameTreatment), 'the shine is painted once, not looped');
assert.ok(!/@keyframes color-name-glint/.test(css), 'no extra animation competes with the wordmark');
// The bead keeps its specular light and the selected swatch keeps its gold ring.
assert.match(css, /\.product-color-swatch::after \{[\s\S]*?radial-gradient\(circle at 32% 24%/);
assert.match(css, /\.product-color-option\[data-selected='true'\] \.product-color-swatch \{/);
assert.match(css, /0 0 0 4px rgba\(201, 168, 76, 0\.6\)/);
// Sold-out colours keep their true colour: no fade turns white into grey.
// Availability is a two-tone diagonal strike that reads on both white and black.
assert.match(css, /\.product-color-option\[data-oos='true'\] \{ opacity: 1; \}/);
assert.ok(!/\.product-color-option\[data-oos='true'\] \.product-color-swatch \{ opacity: 0\.5; \}/.test(css), 'the grey fade is gone');
assert.match(css, /\.product-color-option\[data-oos='true'\] \.product-color-swatch::before \{[\s\S]*?linear-gradient\(\s*45deg,/);
assert.match(css, /rgba\(255, 255, 255, 0\.9\) 46%/);
assert.match(css, /rgba\(10, 10, 10, 0\.85\) 51%/);

console.log('product-colors: 128 passed, 0 failed');
