import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch, getColorTextStyle } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

// The name keeps the fabric's true colour; only inks that would disappear into
// the canvas get a hairline rim, with the rim flipped on a light background.
const black = getColorTextStyle('Black');
assert.equal(black.color, '#111111');
assert.match(black.WebkitTextStroke, /rgba\(255, 255, 255/);
const white = getColorTextStyle('White');
assert.equal(white.color, '#ffffff');
assert.equal(white.WebkitTextStroke, undefined);
assert.match(getColorTextStyle('Navy').WebkitTextStroke, /rgba\(255, 255, 255/);
assert.equal(getColorTextStyle('Black', '#ffffff').WebkitTextStroke, undefined);
assert.match(getColorTextStyle('White', '#ffffff').WebkitTextStroke, /rgba\(0, 0, 0/);
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

console.log('product-colors: 24 passed, 0 failed');
