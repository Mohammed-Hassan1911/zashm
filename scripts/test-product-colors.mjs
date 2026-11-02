import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getColorSwatch } from '../src/lib/productColors.mjs';

assert.equal(getColorSwatch('Burgundy'), '#800020');
assert.equal(getColorSwatch('برجاندي'), '#800020');
assert.equal(getColorSwatch('Yellow'), '#facc15');
assert.equal(getColorSwatch('أصفر'), '#facc15');
assert.equal(getColorSwatch('#123abc'), '#123abc');
assert.equal(getColorSwatch('unlisted color'), '#8a8a8a');

const adminApp = await readFile(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
const productPage = await readFile(new URL('../src/pages/ProductPage.js', import.meta.url), 'utf8');
assert.match(adminApp, /aria-label="Color previews"/);
assert.match(adminApp, /background:getColorSwatch\(color\)/);
assert.match(productPage, /aria-pressed=\{isSelected\}/);
assert.match(productPage, /background:getColorSwatch\(c\)/);

console.log('product-colors: 10 passed, 0 failed');
