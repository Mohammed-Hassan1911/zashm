import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch, getColorTextStyle } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

// Every name wears its own fabric colour, but the painted treatment is
// identical for all of them: one rim, one glow, one halo, one stroke.
const samples = ['Black', 'White', 'Navy', 'Yellow', 'Gold', '#123abc', 'unlisted color'];
const treatments = samples.map((c) => getColorTextStyle(c));
for (const [i, style] of treatments.entries()) {
  assert.equal(style.color, getColorSwatch(samples[i]));
  assert.equal(style['--color-stroke'], '0.5px');
  assert.equal(style['--color-rim'], 'rgba(255, 255, 255, 0.95)');
  assert.equal(style['--color-glow'], 'rgba(255, 255, 255, 0.65)');
  assert.equal(style['--color-halo'], 'rgba(255, 255, 255, 0.3)');
  assert.equal(style['--color-glow-size'], '16px');
}
// Nothing is singled out: strip the colour and every treatment is the same.
const lighting = ({ color, ...rest }) => rest;
for (const style of treatments) assert.deepEqual(lighting(style), lighting(treatments[0]));
assert.deepEqual(getColorTextStyle('White', '#ffffff'), getColorTextStyle('White'));
// The bead and the label carry the exact same fabric colour.
assert.equal(getColorSwatch('Black'), '#111111');
assert.equal(getColorTextStyle('Burgundy').color, '#800020');

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
assert.match(css, /\.product-color-option \{[\s\S]*?gap: 11px;/);
assert.match(css, /\.product-color-option \{ min-height: 48px; padding: 0 14px 0 8px; gap: 9px; \}/);
assert.match(css, /\.product-color-name \{\s*font-size: 15px;/);
assert.match(css, /\.product-color-name \{ font-size: 14px; \}/);
assert.match(css, /\.product-color-name,\s*\n\.product-meta-value \{[\s\S]*?font-family: var\(--font-display\);/);
assert.match(css, /\.product-color-name,\s*\n\.product-meta-value \{[\s\S]*?font-weight: 700;/);
assert.match(css, /-webkit-text-stroke: var\(--color-stroke, 0px\) var\(--color-rim, transparent\);/);
assert.match(css, /text-shadow:[\s\S]*?0 0 var\(--color-glow-size, 6px\) var\(--color-glow, transparent\),/);
// The richer lighting is part of the contract: three ink layers, a specular
// bead, and a gold ring on the selected swatch.
assert.match(css, /text-shadow:[\s\S]*?0 1px 1px rgba\(0, 0, 0, 0\.72\)/);
assert.match(css, /text-shadow:[\s\S]*?0 0 4px rgba\(255, 255, 255, 0\.4\)/);
assert.match(css, /text-shadow:[\s\S]*?0 0 30px var\(--color-halo, transparent\)/);
assert.match(css, /\.product-color-swatch::after \{[\s\S]*?radial-gradient\(circle at 32% 24%/);
assert.match(css, /\.product-color-option\[data-selected='true'\] \.product-color-swatch \{/);
assert.match(css, /0 0 0 4px rgba\(201, 168, 76, 0\.6\)/);
// Sold-out labels stay readable; the fade lives on the bead instead.
assert.match(css, /\.product-color-option\[data-oos='true'\] \{ opacity: 0\.85; \}/);
assert.match(css, /\.product-color-option\[data-oos='true'\] \.product-color-swatch \{ opacity: 0\.5; \}/);

console.log('product-colors: 90 passed, 0 failed');
