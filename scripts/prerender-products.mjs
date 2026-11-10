#!/usr/bin/env node
// ─── ZASHM product-page prerender ────────────────────────────────────────────
// Writes one static HTML shell per live product to
// `build/product/<id>/index.html`, so `/product/<id>` is answered by a file that
// already carries the right <head> and preloads the LCP image — before any
// JavaScript runs.
//
//   node scripts/prerender-products.mjs            # after `vite build`
//   node scripts/prerender-products.mjs --dry-run  # report only, no writes
//
// Why a directory index and not `cleanUrls`: Vercel serves
// `product/<id>/index.html` at `/product/<id>` with the default configuration,
// so `vercel.json` routing does not change at all. If the platform ever prefers
// the `/product/:path*` rewrite over the filesystem, the request simply falls
// back to the normal SPA shell — the same page the storefront serves today.
//
// The page is NOT server-rendered: it is the built `index.html` with product
// metadata, Product JSON-LD and an image preload injected. React still mounts
// into the untouched `<div id="root">`, so there is no hydration step and no way
// for this file to disagree with the client render.
//
// Data comes from the public `products_public` view with the anon key — the same
// read the storefront already performs. Nothing secret is read, written, or
// embedded. Any failure (missing env, network, bad payload, missing build) is a
// no-op: the deploy keeps the working SPA shell. `scripts/resilience-exclude.json`
// is deliberately NOT applied — it only keeps products out of the offline backup,
// while a live product still deserves real metadata.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { availableStock, effectivePrice } from '../src/lib/pricing.js';
import { productRoutePath } from '../src/lib/product-url.mjs';

const require = createRequire(import.meta.url);
const { isProductId } = require('../src/lib/product-exists.cjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = resolve(ROOT, 'build');
const TEMPLATE_FILE = resolve(BUILD_DIR, 'index.html');
const DEFAULT_BASE = 'https://za-shm.vercel.app';
const META_DESCRIPTION_MAX = 300;
const FETCH_TIMEOUT_MS = 15000;

const dryRun = process.argv.slice(2).includes('--dry-run');

/** Load .env without overriding variables the caller already exported. */
function loadEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env && env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** The public origin the canonical/OG URLs point at. Never a secret. */
export function baseUrlFromEnv(env = process.env) {
  const raw = firstEnv(env, ['PUBLIC_BASE_URL', 'VITE_SITE_URL', 'SITE_URL']) || DEFAULT_BASE;
  return raw.replace(/\/+$/, '') || DEFAULT_BASE;
}

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Absolute http(s) URL, or '' when the value cannot be one (data:, blob:, …). */
export function absoluteImageUrl(value, baseUrl = DEFAULT_BASE) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, `${baseUrl.replace(/\/+$/, '')}/`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function productImages(product, baseUrl) {
  let list = product && product.images;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  const urls = (Array.isArray(list) ? list : [])
    .map((src) => absoluteImageUrl(src, baseUrl))
    .filter(Boolean);
  if (urls.length === 0) {
    const single = absoluteImageUrl(product && product.image, baseUrl);
    if (single) urls.push(single);
  }
  return urls;
}

function metaDescription(product, name, category) {
  const text = String((product && product.description) || '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = `${name} — ${category || 'Luxury fashion'} at ZASHM.`;
  const source = text || fallback;
  return source.length > META_DESCRIPTION_MAX
    ? `${source.slice(0, META_DESCRIPTION_MAX - 1).trimEnd()}…`
    : source;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace a `<meta attr="key" content="…">` value, if the tag exists. */
function setMeta(html, attr, key, value) {
  const pattern = new RegExp(`<meta\\s+${attr}="${escapeRegExp(key)}"\\s+content="[^"]*"\\s*/?>`);
  return html.replace(pattern, () => `<meta ${attr}="${key}" content="${escapeHtml(value)}"/>`);
}

/**
 * Inject product metadata into the built SPA shell.
 *
 * Returns `null` for anything that must not get a page: a missing/inactive
 * product or an id that is not a plain numeric product id (path safety).
 */
export function renderProductHtml(template, product, { baseUrl = DEFAULT_BASE } = {}) {
  if (typeof template !== 'string' || !template.includes('<div id="root"></div>')) return null;
  if (!product || product.active === false) return null;
  if (!isProductId(String(product.id))) return null;

  const id = String(product.id);
  const name = String(product.name || '').trim() || `Product ${id}`;
  const category = String(product.category || '').trim();
  const description = metaDescription(product, name, category);
  const title = `${name} — ZASHM`;
  const url = new URL(productRoutePath(product), `${baseUrl.replace(/\/+$/, '')}/`).href;
  const images = productImages(product, baseUrl);
  const image = images[0] || '';

  let html = template;

  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  html = setMeta(html, 'name', 'description', description);
  html = html.replace(
    /<link rel="canonical" href="[^"]*"\s*\/?>/,
    () => `<link rel="canonical" href="${escapeHtml(url)}"/>`,
  );
  html = setMeta(html, 'property', 'og:title', title);
  html = setMeta(html, 'property', 'og:description', description);
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'property', 'og:image:alt', name);
  html = setMeta(html, 'name', 'twitter:title', title);
  html = setMeta(html, 'name', 'twitter:description', description);
  html = setMeta(html, 'name', 'twitter:image:alt', name);
  if (image) {
    html = setMeta(html, 'property', 'og:image', image);
    html = setMeta(html, 'name', 'twitter:image', image);
    // The default 1200×630 dimensions belong to the site card, not the product.
    html = html.replace(
      /<meta\s+property="og:image:(?:width|height)"\s+content="[^"]*"\s*\/?>\s*/g,
      '',
    );
  }

  // Discover the LCP image as early as possible. `fetchpriority="high"` matches
  // the attribute React sets on the same element after mount. It goes directly
  // after the charset declaration so the encoding still wins the first bytes.
  if (image) {
    const preload = `<link rel="preload" as="image" href="${escapeHtml(image)}" fetchpriority="high"/>`;
    html = html.includes('<meta charset="utf-8"/>')
      ? html.replace('<meta charset="utf-8"/>', () => `<meta charset="utf-8"/>\n  ${preload}`)
      : html.replace(/<head>/i, () => `<head>\n  ${preload}`);
  }

  const price = effectivePrice(product);
  const inStock = availableStock(product) > 0;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    description: String(product.description || '').trim() || undefined,
    image: images.length ? images : undefined,
    sku: product.sku || undefined,
    category: category || undefined,
    brand: { '@type': 'Brand', name: 'ZASHM' },
    offers: {
      '@type': 'Offer',
      price: Number.isFinite(price) ? price : 0,
      priceCurrency: 'EGP',
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url,
    },
  };
  // `</script>` inside a JSON string would close the tag early: escape `<`.
  const jsonText = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
  html = html.replace(
    /<\/head>/i,
    () => `  <script type="application/ld+json" id="zashm-product-jsonld">${jsonText}</script>\n</head>`,
  );

  // The storefront is client-rendered; without JavaScript this is the whole
  // page, so it must still say what the product is and how to keep browsing.
  const priceLine = Number.isFinite(price) && price > 0
    ? `<p style="margin:0 0 6px;color:#c9a84c;font-size:20px">EGP ${escapeHtml(price.toLocaleString('en-US'))}${inStock ? '' : ' — Sold out'}</p>`
    : '';
  const noscript = [
    '<noscript>',
    '<div style="max-width:640px;margin:96px auto;padding:0 20px;text-align:center;color:#f5f0e8;font-family:Georgia,serif">',
    `<h1 style="font-size:28px;font-weight:400;margin:0 0 12px">${escapeHtml(name)}</h1>`,
    `<p style="margin:0 0 12px;color:#c9c4b8;font-size:14px;line-height:1.7">${escapeHtml(description)}</p>`,
    priceLine,
    '<p style="margin:18px 0 0"><a href="/shop" style="color:#c9a84c">Browse the collection</a></p>',
    '</div>',
    '</noscript>',
  ].join('');
  html = html.replace(
    '<div id="root"></div>',
    () => `<div id="root"></div>\n  ${noscript}`,
  );

  return html;
}

async function fetchProducts({ env = process.env, fetchImpl = fetch } = {}) {
  const supabaseUrl = firstEnv(env, ['VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL', 'SUPABASE_URL']);
  const anonKey = firstEnv(env, ['VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']);
  if (!supabaseUrl || !anonKey) return { skipped: 'Supabase URL/anon key not configured' };

  let endpoint;
  try {
    endpoint = new URL('/rest/v1/products_public', supabaseUrl);
  } catch {
    return { skipped: 'invalid Supabase URL' };
  }
  endpoint.searchParams.set('select', '*');
  endpoint.searchParams.set('order', 'id.asc');

  const response = await fetchImpl(endpoint, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`products_public HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('products_public returned a non-array payload');
  return { products: rows };
}

/** Write one page per product. Returns what was written and what was skipped. */
export function writeProductPages(products, template, {
  buildDir = BUILD_DIR,
  baseUrl = DEFAULT_BASE,
  dryRun: planOnly = false,
} = {}) {
  const productRoot = resolve(buildDir, 'product');
  let written = 0;
  const skipped = [];

  for (const product of Array.isArray(products) ? products : []) {
    const html = renderProductHtml(template, product, { baseUrl });
    if (!html) {
      skipped.push(product && product.id != null ? String(product.id) : '(unknown)');
      continue;
    }
    const id = String(product.id);
    const target = resolve(productRoot, id, 'index.html');
    if (!target.startsWith(`${productRoot}${sep}`)) {
      skipped.push(id);
      continue;
    }
    if (!planOnly) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, html, 'utf8');
    }
    written += 1;
  }

  return { written, skipped };
}

async function main() {
  loadEnv();

  if (!existsSync(TEMPLATE_FILE)) {
    console.log(`prerender skipped: ${TEMPLATE_FILE} not found (run "npm run build" first)`);
    return;
  }
  const template = readFileSync(TEMPLATE_FILE, 'utf8');
  const baseUrl = baseUrlFromEnv();

  let result;
  try {
    result = await fetchProducts();
  } catch (err) {
    console.log(`prerender skipped: ${(err && err.message) || err}`);
    return;
  }
  if (result.skipped) {
    console.log(`prerender skipped: ${result.skipped}`);
    return;
  }

  const { written, skipped } = writeProductPages(result.products, template, { baseUrl, dryRun });
  const suffix = skipped.length ? `, skipped ${skipped.length} (${skipped.join(', ')})` : '';
  console.log(`prerender: ${dryRun ? 'would write' : 'wrote'} ${written} product page(s)${suffix}`);
}

const isDirectRun = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    // Build-safe on purpose: a prerender problem must never block a release.
    console.log(`prerender skipped: ${(err && err.message) || err}`);
  });
}
