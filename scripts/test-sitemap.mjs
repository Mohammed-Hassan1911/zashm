/**
 * Dynamic public product sitemap regression tests.
 *
 *   node scripts/test-sitemap.mjs
 */
import { readFileSync } from 'node:fs';
import sitemapHandler, { buildSitemapXml } from '../api/sitemap.mjs';
import { canonicalUrl, productRoutePath } from '../src/lib/product-url.mjs';

const root = new URL('..', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const origin = 'https://za-shm.vercel.app';

console.log('\n[1] active and available product selection');
{
  const xml = buildSitemapXml([
    { id: 42, stock: 3 },
    { id: '42', stock: 4 },
    { id: 43, active: false, stock: 2 },
    { id: 44, stock: 0 },
    { id: 45, stock: 0, variantStock: { 'M-black': 2 } },
    { id: 46, stock: 5, variantStock: { 'M-black': 0 } },
    { id: 47, stock: 2, deleted: true },
    { id: 48, stock: 2, private: true },
    { id: 49, stock: null, variantStock: null },
    { id: 50, stock: '2' },
    { id: 51, stock: 2, variantStock: [] },
    { id: 52, stock: null, variantStock: {} },
  ], origin);
  eq((xml.match(/<loc>/g) || []).length, 6, 'includes static routes and four unique available products');
  ok(xml.includes(`${origin}/product/42`), 'includes the active in-stock product');
  ok(xml.includes(`${origin}/product/45`), 'uses variant stock to recognize an available product');
  ok(xml.includes(`${origin}/product/50`) && xml.includes(`${origin}/product/51`),
    'accepts numeric stock strings and falls back when variant stock is absent or malformed');
  ok(!xml.includes('/product/43') && !xml.includes('/product/44') &&
     !xml.includes('/product/46') && !xml.includes('/product/47') &&
     !xml.includes('/product/48') && !xml.includes('/product/49') &&
     !xml.includes('/product/52'),
  'excludes inactive, sold-out, deleted, private, null-stock, and zero-variant products');
}

console.log('\n[2] empty results and canonical routing');
{
  const emptyXml = buildSitemapXml([], origin);
  ok(emptyXml.includes(`<loc>${origin}/</loc>`) && emptyXml.includes(`<loc>${origin}/shop</loc>`),
    'empty product results preserve the home and shop URLs');
  eq((emptyXml.match(/<loc>/g) || []).length, 2, 'empty results contain no product URLs');

  const product = { id: 'sku & 1' };
  const path = productRoutePath(product);
  eq(path, '/product/sku%20%26%201', 'product path matches the existing router utility');
  const routes = read('src/lib/routes.js');
  ok(/import \{ productRoutePath \} from '\.\/product-url\.mjs'/.test(routes) &&
     /return productRoutePath\(selectedProduct\)/.test(routes),
  'existing pageUrl routing delegates to the shared product path utility');
  eq(canonicalUrl(path, origin), `${origin}/product/sku%20%26%201`,
    'canonical URL uses the site origin and encoded route');
  const xml = buildSitemapXml([{ ...product, stock: 1 }], origin);
  ok(xml.includes(`<loc>${origin}/product/sku%20%26%201</loc>`),
    'sitemap emits the canonical encoded product URL');

  const config = JSON.parse(read('vercel.json'));
  ok(config.rewrites.some((rewrite) =>
    rewrite.source === '/sitemap.xml' && rewrite.destination === '/api/sitemap'),
  'public sitemap path rewrites to the dynamic endpoint');
}

console.log('\n[3] public data source and pagination');
{
  const oldEnv = {};
  const envNames = [
    'SUPABASE_URL', 'VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL',
    'SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY',
    'PUBLIC_BASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  ];
  for (const name of envNames) oldEnv[name] = process.env[name];
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-test-key';
  process.env.PUBLIC_BASE_URL = `${origin}/`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'must-not-be-used';

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const start = Number(String(options.headers.Range).split('-')[0]);
    const rows = start === 0
      ? Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, stock: 1 }))
      : [{ id: 1001, stock: 1 }];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  try {
    await sitemapHandler({ method: 'GET' }, response);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }

  eq(requests.length, 2, 'fetches all pages of public product rows');
  ok(requests.every(({ url }) => url.includes('/rest/v1/products_public?') &&
     url.includes('select=id%2Cstock%2CvariantStock') && !url.includes('/products?')),
  'queries only the sanitized products_public view and required public fields');
  eq(requests[0].options.headers.apikey, 'public-anon-test-key', 'uses the public anon key');
  eq(requests[0].options.headers.Authorization, 'Bearer public-anon-test-key',
    'never uses the configured service-role key');
  ok(requests[1].options.headers.Range.startsWith('1000-'), 'requests the next page without skipping products');
  ok(response.body.includes(`${origin}/product/1001`), 'sitemap includes products from later pages');
  eq(response.headers['Content-Type'], 'application/xml; charset=utf-8', 'returns XML content type');
}

console.log('\n[4] safe handling of source failures');
{
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_ANON_KEY;
  const oldSite = process.env.PUBLIC_BASE_URL;
  const oldFetch = globalThis.fetch;
  const oldConsoleError = console.error;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-test-key';
  process.env.PUBLIC_BASE_URL = origin;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  let errors = 0;
  console.error = () => { errors += 1; };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  try {
    await sitemapHandler({ method: 'GET' }, response);
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldConsoleError;
    for (const [name, value] of [['SUPABASE_URL', oldUrl], ['SUPABASE_ANON_KEY', oldKey], ['PUBLIC_BASE_URL', oldSite]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  eq(response.statusCode, 200, 'source failure still returns a valid fallback sitemap');
  ok(response.body.includes(`<loc>${origin}/</loc>`) && response.body.includes(`<loc>${origin}/shop</loc>`),
    'fallback retains static public routes');
  eq((response.body.match(/<loc>/g) || []).length, 2, 'fallback does not claim unknown product URLs');
  ok(response.headers['Cache-Control'].includes('s-maxage=300'), 'failure fallback uses a short cache duration');
  eq(errors, 1, 'source failure is reported to server logs');
}

console.log('\n[5] canonical origin validation');
{
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_ANON_KEY;
  const oldSite = process.env.PUBLIC_BASE_URL;
  const oldFetch = globalThis.fetch;
  const oldConsoleError = console.error;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-test-key';
  process.env.PUBLIC_BASE_URL = 'https://preview--zashm.vercel.app/';
  globalThis.fetch = async () => { throw new Error('Sitemap must reject an unapproved origin before fetching'); };
  console.error = () => {};
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  try {
    await sitemapHandler({ method: 'GET' }, response);
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldConsoleError;
    for (const [name, value] of [['SUPABASE_URL', oldUrl], ['SUPABASE_ANON_KEY', oldKey], ['PUBLIC_BASE_URL', oldSite]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  ok(response.body.includes(`<loc>${origin}/</loc>`) && response.body.includes(`<loc>${origin}/shop</loc>`),
    'invalid or preview origin falls back to the known production canonical origin');
  ok(!response.body.includes('preview--zashm') && !response.body.includes('/product/'),
    'invalid origin is not emitted and product fetch is skipped');
}

console.log('\n[6] missing canonical origin');
{
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_ANON_KEY;
  const oldSite = process.env.PUBLIC_BASE_URL;
  const oldFetch = globalThis.fetch;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'public-anon-test-key';
  delete process.env.PUBLIC_BASE_URL;
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  try {
    await sitemapHandler({ method: 'GET' }, response);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of [['SUPABASE_URL', oldUrl], ['SUPABASE_ANON_KEY', oldKey], ['PUBLIC_BASE_URL', oldSite]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  ok(response.body.includes(`<loc>${origin}/</loc>`) && response.body.includes(`<loc>${origin}/shop</loc>`),
    'missing PUBLIC_BASE_URL uses the documented production canonical origin');
}

console.log('\n[7] method guard');
{
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  await sitemapHandler({ method: 'POST' }, response);
  eq(response.statusCode, 405, 'rejects non-GET requests');
  eq(response.headers.Allow, 'GET', 'advertises the supported method');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
