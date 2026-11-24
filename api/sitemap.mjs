import { canonicalUrl, productRoutePath } from '../src/lib/product-url.mjs';

const PAGE_SIZE = 1000;
const DEFAULT_SITE_ORIGIN = 'https://za-shm.vercel.app';
const PRERENDER_MANIFEST_PATH = '/prerendered-products.json';
const MANIFEST_TIMEOUT_MS = 5000;
const STATIC_URLS = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/shop', changefreq: 'daily', priority: '0.9' },
];

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function httpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function approvedSiteOrigins() {
  const origins = new Set([DEFAULT_SITE_ORIGIN]);
  // Prefer a dedicated sitemap allow-list so a future CORS-only origin cannot
  // silently become canonical. ALLOWED_ORIGINS remains the fallback for the
  // current Vercel/Worker configuration.
  const source = env('SITEMAP_ALLOWED_ORIGINS') || env('ALLOWED_ORIGINS');
  for (const value of source.split(',')) {
    const origin = httpsOrigin(value);
    if (origin) origins.add(origin);
  }
  return origins;
}

function getOrigins() {
  const supabaseUrl = env('SUPABASE_URL', 'VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL');
  const anonKey = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) throw new Error('Public Supabase configuration is missing');

  const parsedSupabaseUrl = new URL(supabaseUrl);
  if (parsedSupabaseUrl.protocol !== 'https:' &&
      !(parsedSupabaseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedSupabaseUrl.hostname))) {
    throw new Error('Public Supabase URL must use HTTPS');
  }

  const configuredSiteUrl = env('PUBLIC_BASE_URL');
  let siteOrigin = DEFAULT_SITE_ORIGIN;
  if (configuredSiteUrl) {
    const origin = httpsOrigin(configuredSiteUrl);
    if (!origin || !approvedSiteOrigins().has(origin)) {
      throw new Error('PUBLIC_BASE_URL must match an approved site origin');
    }
    siteOrigin = origin;
  }

  return {
    supabaseOrigin: parsedSupabaseUrl.origin,
    anonKey,
    siteOrigin,
  };
}

async function fetchPublicProducts({ supabaseOrigin, anonKey }) {
  const products = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL('/rest/v1/products_public', supabaseOrigin);
    // sizes/colors are required, not optional: isAvailable() computes the
    // declared size × colour pool for a variant product, so a row fetched
    // without them looks sold out and every product silently disappears from
    // the sitemap. Both columns are part of the public view's allow-list.
    url.searchParams.set('select', 'id,stock,variantStock,sizes,colors');
    url.searchParams.set('order', 'id.asc');

    const signal = AbortSignal.timeout(8000);
    const response = await fetch(url, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          'Range-Unit': 'items',
        },
        signal,
      });

    if (!response.ok) throw new Error(`products_public returned HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('products_public returned an invalid response');
    products.push(...rows);
    if (rows.length < PAGE_SIZE) return products;
  }
}

/**
 * Product shells are written at build time. Only advertise ids that received
 * one, otherwise a product created after the last deploy would enter the
 * sitemap while its URL still served the generic home metadata.
 */
async function fetchPrerenderedIds(siteOrigin) {
  const url = new URL(PRERENDER_MANIFEST_PATH, siteOrigin);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`prerender manifest returned HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.ids)) {
    throw new Error('prerender manifest is missing its id list');
  }
  return new Set(manifest.ids.map((id) => String(id).trim()).filter(Boolean));
}

function isAvailable(product) {
  if (!product || product.active === false || product.deleted === true || product.private === true) return false;

  const variantStock = product.variantStock &&
    typeof product.variantStock === 'object' &&
    !Array.isArray(product.variantStock)
    ? product.variantStock
    : null;
  const hasVariants = variantStock && Object.keys(variantStock).length > 0;
  if (hasVariants) {
    // Mirror src/lib/pricing.js availableStock(): only keys matching the
    // declared sizes × colors count. Orphaned keys (removed colors/sizes)
    // must never make a product look available.
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const colors = Array.isArray(product.colors) ? product.colors : [];
    for (const size of sizes) {
      for (const color of colors) {
        const qty = Number(variantStock[`${size}-${color}`]);
        if (Number.isFinite(qty) && qty > 0) return true;
      }
    }
    return false;
  }
  return Number.isFinite(Number(product.stock)) && Number(product.stock) > 0;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSitemapXml(products, siteOrigin, prerenderedIds = null) {
  const urls = new Map();
  for (const item of STATIC_URLS) {
    const loc = canonicalUrl(item.path, siteOrigin);
    if (loc) urls.set(loc, item);
  }

  for (const product of Array.isArray(products) ? products : []) {
    if (!isAvailable(product) || product.id == null || String(product.id).trim() === '') continue;
    if (prerenderedIds && !prerenderedIds.has(String(product.id).trim())) continue;
    const loc = canonicalUrl(productRoutePath(product), siteOrigin);
    if (loc && !urls.has(loc)) urls.set(loc, { path: 'product', changefreq: 'weekly', priority: '0.7' });
  }

  const entries = Array.from(urls, ([loc, metadata]) =>
    `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <changefreq>${metadata.changefreq}</changefreq>\n    <priority>${metadata.priority}</priority>\n  </url>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

export default async function sitemapHandler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method not allowed');
    return;
  }

  let siteOrigin = DEFAULT_SITE_ORIGIN;
  let products = [];
  let prerenderedIds = null;
  let sourceAvailable = true;
  try {
    const config = getOrigins();
    siteOrigin = config.siteOrigin;
    if (req && Object.prototype.hasOwnProperty.call(req, 'prerenderedIds')) {
      // A platform adapter can supply the manifest from local assets. An
      // unreadable manifest is an explicit empty set: fail closed without a
      // self-fetch to the Worker's public URL.
      const supplied = req.prerenderedIds;
      prerenderedIds = supplied instanceof Set
        ? supplied
        : new Set(
            (Array.isArray(supplied) ? supplied : [])
              .map((id) => String(id).trim())
              .filter(Boolean)
          );
    } else {
      // Fail closed on the manifest: if we cannot prove a product has a static
      // shell, omit product URLs instead of pointing crawlers at home metadata.
      prerenderedIds = await fetchPrerenderedIds(siteOrigin);
    }
    products = await fetchPublicProducts(config);
  } catch (error) {
    sourceAvailable = false;
    console.error('Could not generate product URLs for sitemap:', error?.message || 'Unknown error');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  const cacheControl = sourceAvailable
    ? 'public, s-maxage=3600, stale-while-revalidate=86400'
    : 'public, s-maxage=300, stale-while-revalidate=3600';
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Vercel-CDN-Cache-Control', cacheControl);
  res.end(buildSitemapXml(products, siteOrigin, prerenderedIds));
}
