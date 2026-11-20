import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch, getColorTextStyle } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

// Every name keeps its true colour and the same style. Only inks that would
// disappear into the canvas get a heavier rim and a wider glow; a light canvas
// flips the rim to black.
const black = getColorTextStyle('Black');
assert.equal(black.color, '#111111');
assert.equal(black['--color-stroke'], '0.5px');
assert.equal(black['--color-rim'], 'rgba(255, 255, 255, 0.92)');
assert.equal(black['--color-glow-size'], '12px');
const white = getColorTextStyle('White');
assert.equal(white.color, '#ffffff');
assert.equal(white['--color-stroke'], '0px');
assert.equal(white['--color-rim'], 'rgba(255, 255, 255, 0.55)');
assert.equal(white['--color-glow-size'], '8px');
assert.equal(getColorTextStyle('Navy')['--color-stroke'], '0.5px');
assert.equal(getColorTextStyle('Black', '#ffffff')['--color-stroke'], '0px');
const onLight = getColorTextStyle('White', '#ffffff');
assert.equal(onLight['--color-stroke'], '0.5px');
assert.equal(onLight['--color-rim'], 'rgba(0, 0, 0, 0.92)');
assert.equal(getColorTextStyle('#123abc').color, '#123abc');

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

console.log('product-colors: 32 passed, 0 failed');
