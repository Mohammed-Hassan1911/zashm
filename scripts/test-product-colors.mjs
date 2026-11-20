import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch, getColorTextStyle } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

// Every name wears the exact same painted shape as Black; only the true fabric
// colour changes. A light canvas flips the rim to black for readability.
const samples = ['Black', 'White', 'Navy', 'Yellow', 'Gold', '#123abc', 'unlisted color'];
const treatments = samples.map((c) => getColorTextStyle(c));
for (const style of treatments) {
  assert.equal(style['--color-stroke'], '0.5px');
  assert.equal(style['--color-rim'], 'rgba(255, 255, 255, 0.92)');
  assert.equal(style['--color-glow'], 'rgba(255, 255, 255, 0.42)');
  assert.equal(style['--color-glow-size'], '12px');
}
assert.equal(treatments[0].color, '#111111');
assert.equal(treatments[1].color, '#ffffff');
assert.equal(treatments[5].color, '#123abc');
assert.equal(treatments[6].color, '#8a8a8a');
const onLight = getColorTextStyle('White', '#ffffff');
assert.equal(onLight['--color-stroke'], '0.5px');
assert.equal(onLight['--color-rim'], 'rgba(0, 0, 0, 0.92)');
assert.equal(onLight['--color-glow'], 'rgba(0, 0, 0, 0.42)');

const adminApp = await readFile(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
const productPage = await readFile(new URL('../src/pages/ProductPage.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');
assert.match(adminApp, /aria-label="Color previews"/);
assert.match(adminApp, /background:getColorSwatch\(color\)/);
assert.match(productPage, /aria-pressed=\{isSelected\}/);
assert.match(productPage, /background:getColorSwatch\(c\)/);
assert.match(productPage, /style=\{getColorTextStyle\(selColor\)\}/);
assert.match(productPage, /style=\{getColorTextStyle\(c\)\}/);
assert.match(css, /\.product-color-name \{/);
assert.match(css, /\.product-color-option \{[\s\S]*?gap: 10px;/);
assert.match(css, /\.product-color-option \{ min-height: 44px; padding: 0 12px 0 6px; gap: 8px; \}/);
assert.match(css, /\.product-color-name \{ font-size: 12px; \}/);
assert.match(css, /\.product-color-name,\s*\n\.product-meta-value \{[\s\S]*?font-weight: 700;/);
assert.match(css, /-webkit-text-stroke: var\(--color-stroke, 0px\) var\(--color-rim, transparent\);/);
assert.match(css, /text-shadow:[\s\S]*?0 0 var\(--color-glow-size, 6px\) var\(--color-glow, transparent\);/);

console.log('product-colors: 54 passed, 0 failed');
