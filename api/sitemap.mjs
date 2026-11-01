import { canonicalUrl, productRoutePath } from '../src/lib/product-url.mjs';

const PAGE_SIZE = 1000;
const DEFAULT_SITE_ORIGIN = 'https://za-shm.vercel.app';
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

function getOrigins() {
  const supabaseUrl = env('SUPABASE_URL', 'VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL');
  const anonKey = env('SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) throw new Error('Public Supabase configuration is missing');

  const parsedSupabaseUrl = new URL(supabaseUrl);
  if (parsedSupabaseUrl.protocol !== 'https:' &&
      !(parsedSupabaseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedSupabaseUrl.hostname))) {
    throw new Error('Public Supabase URL must use HTTPS');
  }

  const siteUrl = new URL(env('PUBLIC_BASE_URL') || DEFAULT_SITE_ORIGIN);
  if (siteUrl.protocol !== 'https:' &&
      !(siteUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(siteUrl.hostname))) {
    throw new Error('Public site URL must use HTTPS');
  }

  return {
    supabaseOrigin: parsedSupabaseUrl.origin,
    anonKey,
    siteOrigin: siteUrl.origin,
  };
}

async function fetchPublicProducts({ supabaseOrigin, anonKey }) {
  const products = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL('/rest/v1/products_public', supabaseOrigin);
    url.searchParams.set('select', 'id,stock,variantStock');
    url.searchParams.set('order', 'id.asc');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          Range: `${offset}-${offset + PAGE_SIZE - 1}`,
          'Range-Unit': 'items',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`products_public returned HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('products_public returned an invalid response');
    products.push(...rows);
    if (rows.length < PAGE_SIZE) return products;
  }
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
    return Object.values(variantStock).some((quantity) => Number.isFinite(Number(quantity)) && Number(quantity) > 0);
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

export function buildSitemapXml(products, siteOrigin) {
  const urls = new Map();
  for (const item of STATIC_URLS) {
    const loc = canonicalUrl(item.path, siteOrigin);
    if (loc) urls.set(loc, item);
  }

  for (const product of Array.isArray(products) ? products : []) {
    if (!isAvailable(product) || product.id == null || String(product.id).trim() === '') continue;
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
  let sourceAvailable = true;
  try {
    const config = getOrigins();
    siteOrigin = config.siteOrigin;
    products = await fetchPublicProducts(config);
  } catch (error) {
    sourceAvailable = false;
    console.error('Could not generate product URLs for sitemap:', error?.message || 'Unknown error');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    sourceAvailable
      ? 'public, s-maxage=3600, stale-while-revalidate=86400'
      : 'public, s-maxage=300, stale-while-revalidate=3600'
  );
  res.end(buildSitemapXml(products, siteOrigin));
}
