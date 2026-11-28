// Regenerate the route-specific CSS split from the frozen pre-split source.
// The manifest records checksums so the test helper fails loudly on drift.
// Generated sheets are intentionally normalized: comments attached to a moved
// rule travel with it, while unrelated blank lines are not preserved byte-for-byte.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarations, importantDeclarations, ruleHeads, sameMultiset } from './lib/css-audit.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL = resolve(REPO, 'scripts/lib/css-original.css');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const src = readFileSync(ORIGINAL, 'utf8');
const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

const ADMIN = /\.admin-|\.zshm-date|\.zshm-admin|adminlogin|admincontainer|admin-product|admin-date/;
const SHOP = /\.shop-page|\.shop-hero|\.shop-toolbar|\.shop-chip|\.shop-sort|\.shop-filter|\.shop-label-chip|\.shop-chip-row/;
const PRODUCT = /\.product-page|\.product-breadcrumb|\.product-gallery|\.product-grid|\.product-title|\.product-eyebrow|\.product-details|\.product-detail-block|\.product-tab|\.product-meta|\.product-color-name|\.product-price|\.product-options|\.product-description|\.product-info|\.product-action|\.product-buy|\.product-qty|\.product-shipping|\.product-guarantee|\.product-finder|\.size-guide|\.size-selector|\.size-pill|\.swatch|\.colour-swatch|\.color-swatch|\.buy-row|\.review-|\.find-my-size|\.pdp-/;
// These selectors are deliberately shared by more than one route (or by a
// route and a skeleton component), so they must stay in the base cascade.
const PINNED = /\.product-card(?:[^-]|$)|^\.review-photo-thumb(?:\s|,|:|\{|\[|$)/;

const nodes = [];
const skipWs = (i, end) => { while (i < end && /\s/.test(clean[i])) i += 1; return i; };
const readUntil = (i, end, chars) => { const s = i; while (i < end && !chars.includes(clean[i])) i += 1; return { head: clean.slice(s, i), end: i }; };
const readBlock = (i, end) => { let depth = 0; const s = i; while (i < end) { const c = clean[i]; if (c === '{') depth += 1; else if (c === '}') { depth -= 1; if (!depth) return { body: clean.slice(s + 1, i), end: i + 1 }; } i += 1; } throw new Error('unclosed block'); };

let atCounter = 0;
function parseSegment(start, end, context) {
  let i = start;
  while (true) {
    i = skipWs(i, end);
    if (i >= end) return;
    const ruleStart = i;
    const h = readUntil(i, end, '{;');
    const head = h.head.trim();
    i = h.end;
    if (i >= end) return;
    if (clean[i] === ';') {
      nodes.push({ head, body: '', text: src.slice(ruleStart, i + 1), context, start: ruleStart, end: i + 1, kind: 'statement' });
      i += 1;
      continue;
    }
    if (clean[i] !== '{') { i += 1; continue; }
    const b = readBlock(i, end);
    const wholeText = src.slice(ruleStart, b.end);
    if (/^@(media|supports|container|layer|scope)\b/.test(head)) {
      parseSegment(i + 1, b.end - 1, [...context, { head, id: ++atCounter }]);
      i = b.end;
      continue;
    }
    nodes.push({ head, body: b.body, text: wholeText, context, start: ruleStart, end: b.end, kind: head.startsWith('@') ? 'at' : 'rule' });
    i = b.end;
  }
}
parseSegment(0, clean.length, []);

function tokensOf(head) {
  const out = new Set();
  for (const m of head.matchAll(/\.([A-Za-z_][\w-]*)|#([A-Za-z_][\w-]*)|\[([^\]=~|^$]+)|(^|[\s>+~,(])([a-zA-Z][\w-]*)/g)) {
    if (m[1]) out.add('.' + m[1]);
    else if (m[2]) out.add('#' + m[2]);
    else if (m[3]) out.add('[' + m[3].trim());
    else if (m[5]) out.add(m[5]);
  }
  return out;
}
for (const n of nodes) {
  n.tokens = tokensOf(n.head);
  const all = (n.head + ' ' + n.body + ' ' + n.context.map((c) => c.head).join(' ')).toLowerCase();
  n.pinned = PINNED.test(n.head) || (/\.review-photo-thumb/.test(n.head) && !/\.review-form|\.review-card|\.review-grid/.test(n.head));
  n.category = n.pinned ? 'base' : ADMIN.test(all) ? 'admin' : SHOP.test(all) ? 'shop' : PRODUCT.test(all) ? 'product' : 'base';
}

// Union rules that share an exact selector token. This keeps a selector's
// base declaration and every breakpoint/media override in the same file, in
// the same relative order they had in the original stylesheet.
const parent = nodes.map((_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[y] = x; };
const byToken = new Map();
nodes.forEach((n, i) => { for (const t of n.tokens) { if (!byToken.has(t)) byToken.set(t, []); byToken.get(t).push(i); } });
for (const list of byToken.values()) for (let k = 1; k < list.length; k += 1) union(list[0], list[k]);

const components = new Map();
nodes.forEach((n, i) => { const r = find(i); if (!components.has(r)) components.set(r, []); components.get(r).push(i); });
for (const [root, idxs] of components) {
  const cats = new Set(idxs.map((i) => nodes[i].category).filter((c) => c !== 'base'));
  const pinned = idxs.some((i) => nodes[i].pinned);
  // A token union that contains any base rule must stay in base. Otherwise a
  // single shared token would pull a storefront-wide rule into a route chunk.
  const hasBase = idxs.some((i) => nodes[i].category === 'base');
  const category = pinned || hasBase || cats.size !== 1 ? 'base' : [...cats][0];
  for (const i of idxs) nodes[i].out = category;
}

function leaders(start) {
  const out = [];
  let p = start - 1;
  while (p >= 0 && /\s/.test(src[p])) p -= 1;
  while (p >= 0 && src.startsWith('*/', p - 1)) {
    const q = src.lastIndexOf('/*', p - 2);
    if (q < 0) break;
    out.unshift(src.slice(q, p + 1));
    p = q - 1;
    while (p >= 0 && /\s/.test(src[p])) p -= 1;
  }
  return out;
}
const headers = {
  base: '/* ZASHM base styles: shell, fonts, shared storefront components. */\n',
  admin: '/* ZASHM admin styles: loaded only with the admin route chunk. */\n',
  shop: '/* ZASHM shop styles: loaded only with the shop route chunk. */\n',
  product: '/* ZASHM product-page styles: loaded only with the product route chunk. */\n',
};
// Rebuild an at-rule as one block containing all of its assigned children,
// placed where that block first appeared. The regression suite asserts on
// whole @media blocks, and splitting them into one wrapper per child would
// change the source shape without changing the cascade.
const grouped = { base: new Map(), admin: new Map(), shop: new Map(), product: new Map() };
nodes.forEach((n, i) => {
  const key = n.context.map((c) => c.id).join('|');
  if (!key) { grouped[n.out].set(`rule:${i}`, { key: i, context: [], children: [n] }); return; }
  if (!grouped[n.out].has(key)) grouped[n.out].set(key, { key: i, context: n.context, children: [] });
  grouped[n.out].get(key).children.push(n);
});
const out = { base: [], admin: [], shop: [], product: [] };
for (const category of Object.keys(out)) {
  const items = [];
  for (const g of grouped[category].values()) {
    const first = g.children[0];
    const body = g.context.length
      ? g.context.map((c) => c.head + ' {\n').join('') + g.children.map((c) => c.text).join('\n') + '\n' + g.context.map(() => '}').join('\n')
      : first.text;
    const lead = leaders(first.start);
    items.push({ key: g.key, text: ((lead.length ? lead.join('\n') + '\n' : '') + body).replace(/[ \t]+$/gm, '') });
  }
  items.sort((a, b) => a.key - b.key);
  out[category] = items;
}
const files = {
  base: 'src/index.css',
  admin: 'src/styles/admin.css',
  shop: 'src/styles/shop.css',
  product: 'src/styles/product.css',
};
const spans = [];
for (const k of Object.keys(out)) {
  const header = headers[k];
  const parts = [];
  let cursor = header.length;
  for (let i = 0; i < out[k].length; i += 1) {
    if (i) { parts.push('\n'); cursor += 1; }
    const start = cursor;
    parts.push(out[k][i].text);
    cursor += out[k][i].text.length;
    spans.push({ file: k === 'base' ? 'src/index.css' : `src/styles/${k}.css`, key: out[k][i].key, start, end: cursor });
  }
  const text = header + parts.join('') + '\n';
  const target = `${REPO}/${k === 'base' ? 'src/index.css' : `src/styles/${k}.css`}`;
  writeFileSync(target, text, 'utf8');
  console.log(k.padEnd(7), String(out[k].length).padStart(4), 'rules', (text.length / 1024).toFixed(1) + ' KB');
}
spans.sort((a, b) => a.key - b.key);
const generatedText = Object.values(files)
  .map((file) => readFileSync(resolve(REPO, file), 'utf8')).join('\n');
if (!sameMultiset(ruleHeads(src), ruleHeads(generatedText))) {
  throw new Error('CSS split changed the set of rule selectors');
}
if (!sameMultiset(declarations(src), declarations(generatedText))) {
  throw new Error('CSS split changed the set of declarations');
}
if (!sameMultiset(importantDeclarations(src), importantDeclarations(generatedText))) {
  throw new Error('CSS split changed the set of !important declarations');
}
writeFileSync(`${REPO}/scripts/lib/css-order.json`, JSON.stringify({
  version: 1,
  source: 'scripts/lib/css-original.css',
  sourceSha256: sha(src),
  files,
  fileSha256: Object.fromEntries(Object.values(files).map((file) => [file, sha(readFileSync(resolve(REPO, file), 'utf8'))])),
  spans: spans.map((span) => ({
    ...span,
    sha256: sha(readFileSync(resolve(REPO, span.file), 'utf8').slice(span.start, span.end)),
  })),
}));
const counts = {};
for (const n of nodes) counts[n.out] = (counts[n.out] || 0) + 1;
console.log('original atomic rules', nodes.length, 'output rules', Object.values(counts).reduce((a, b) => a + b, 0), JSON.stringify(counts));
console.log('declarations original/output', (clean.match(/[^{}]*:[^{}]*;/g) || []).length,
  Object.values(out).flatMap((items) => items.map((i) => i.text)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]*:[^{}]*;/g)?.length || 0);
