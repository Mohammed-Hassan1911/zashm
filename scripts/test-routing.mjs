/**
 * Routing middleware — real 404 for unknown product URLs.
 *
 *   node scripts/test-routing.mjs
 *
 * Covers:
 *   - crawler detection and product-id parsing (pure helpers)
 *   - `checkProductExists` contract: true / false / null (fail open)
 *   - the 404 response reuses public/404.html and is noindex
 *   - middleware.ts wiring + vercel.json / vite dev-port configuration
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireHelper = createRequire(import.meta.url);
const {
  buildNotFoundResponse,
  checkProductExists,
  isCrawler,
  isProductId,
  productIdFromPath,
} = requireHelper('../src/lib/product-exists.cjs');

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const ENV = {
  REACT_APP_SUPABASE_URL: 'https://proj.supabase.co',
  REACT_APP_SUPABASE_ANON_KEY: 'anon-key',
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

// ─── [1] crawler detection ───────────────────────────────────────────────────
console.log('\n[1] crawler detection');
{
  ok(isCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot is detected');
  ok(isCrawler('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), 'Bingbot is detected');
  ok(isCrawler('Google-InspectionTool/1.0'), 'Search Console inspection is detected');
  ok(isCrawler('facebookexternalhit/1.1'), 'link-preview crawlers are detected');
  ok(!isCrawler('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'), 'a normal browser is not treated as a crawler');
  ok(!isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1'), 'mobile Safari is not treated as a crawler');
  ok(!isCrawler(undefined) && !isCrawler(''), 'a missing user agent fails safe');
}

// ─── [2] product id parsing ──────────────────────────────────────────────────
console.log('\n[2] product id parsing');
{
  eq(productIdFromPath('/product/1793586156664926'), '1793586156664926', 'a numeric product id is extracted');
  eq(productIdFromPath('/product/1793586156664926/'), '1793586156664926', 'a trailing slash is tolerated');
  eq(productIdFromPath('/product/%31%32%33'), '123', 'percent-encoded ids are decoded');
  eq(productIdFromPath('/product'), null, 'the bare /product route is not a detail page');
  eq(productIdFromPath('/product/a/b'), null, 'extra path segments are not a detail page');
  eq(productIdFromPath('/shop'), null, 'other routes are ignored');
  eq(productIdFromPath(undefined), null, 'a missing pathname is ignored');

  ok(isProductId('1') && isProductId('1793586156664926'), 'positive bigint ids are accepted');
  ok(!isProductId('0'), 'zero is not a product id');
  ok(!isProductId('0123'), 'leading zeros are rejected');
  ok(!isProductId('abc') && !isProductId('1.5') && !isProductId('-1'), 'non-numeric ids are rejected');
  ok(!isProductId('1'.repeat(20)), 'ids longer than bigint are rejected');
}

// ─── [3] product existence lookup ────────────────────────────────────────────
console.log('\n[3] products_public lookup');
{
  const missingIdFetch = fakeFetch(() => { throw new Error('should not fetch'); });
  eq(await checkProductExists('not-a-number', { env: ENV, fetchImpl: missingIdFetch }), false,
    'a malformed id is missing without touching the database');
  eq(missingIdFetch.calls.length, 0, 'no request is made for a malformed id');

  const noEnvFetch = fakeFetch(() => { throw new Error('should not fetch'); });
  eq(await checkProductExists('123', { env: {}, fetchImpl: noEnvFetch }), null,
    'missing Supabase configuration fails open');
  eq(noEnvFetch.calls.length, 0, 'no request is made without configuration');

  const foundFetch = fakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => [{ id: 123 }],
  }));
  eq(await checkProductExists('123', { env: ENV, fetchImpl: foundFetch }), true, 'an existing product returns true');
  eq(foundFetch.calls.length, 1, 'exactly one lookup is made');
  const call = foundFetch.calls[0];
  ok(call.url.startsWith('https://proj.supabase.co/rest/v1/products_public?'), 'the public view is queried');
  ok(/select=id/.test(call.url), 'only the id column is selected');
  ok(/id=eq\.123/.test(call.url), 'the id filter uses the documented eq operator');
  ok(/limit=1/.test(call.url), 'the query is limited to one row');
  eq(call.init.headers.apikey, 'anon-key', 'the anon apikey header is sent');
  eq(call.init.headers.Authorization, 'Bearer anon-key', 'the anon bearer token is sent');
  ok(call.init.signal instanceof AbortSignal, 'the lookup has an abort signal');

  const emptyFetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => [] }));
  eq(await checkProductExists('123', { env: ENV, fetchImpl: emptyFetch }), false, 'an empty result returns false');

  const errorFetch = fakeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  eq(await checkProductExists('123', { env: ENV, fetchImpl: errorFetch }), null, 'a database error fails open');

  const throwFetch = fakeFetch(() => { throw new Error('network down'); });
  eq(await checkProductExists('123', { env: ENV, fetchImpl: throwFetch }), null, 'a network failure fails open');

  const invalidFetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ error: 'x' }) }));
  eq(await checkProductExists('123', { env: ENV, fetchImpl: invalidFetch }), null, 'an invalid payload fails open');

  eq(await checkProductExists('123', { env: { ...ENV, SUPABASE_URL: 'not a url' }, fetchImpl: missingIdFetch }), null,
    'an unparseable Supabase URL fails open');
  ok(/AbortSignal\.timeout\(8000\)/.test(read('src/lib/product-exists.cjs')),
    'the lookup timeout leaves headroom for slow Supabase round trips');
}

// ─── [4] the 404 response ────────────────────────────────────────────────────
console.log('\n[4] 404 response');
{
  const request = new Request('https://za-shm.vercel.app/product/999999999', { headers: { 'user-agent': 'Googlebot' } });
  const pageFetch = fakeFetch(() => ({ ok: true, text: async () => '<html>shipped 404</html>' }));
  const response = await buildNotFoundResponse(request, { fetchImpl: pageFetch });
  eq(response.status, 404, 'the response status is 404');
  eq(await response.text(), '<html>shipped 404</html>', 'the shipped 404.html body is reused');
  eq(response.headers.get('content-type'), 'text/html; charset=utf-8', 'the response is HTML');
  ok((response.headers.get('x-robots-tag') || '').includes('noindex'), 'the response is noindex');
  eq(String(pageFetch.calls[0].url), 'https://za-shm.vercel.app/404.html', 'the static 404 page is fetched from the same origin');

  const failingFetch = fakeFetch(() => { throw new Error('offline'); });
  const fallback = await buildNotFoundResponse(request, { fetchImpl: failingFetch });
  eq(fallback.status, 404, 'the fallback also answers 404');
  const fallbackBody = await fallback.text();
  ok(/الصفحة غير موجودة/.test(fallbackBody) && /ZASHM/.test(fallbackBody), 'the fallback is a minimal bilingual page');
}

// ─── [5] wiring ──────────────────────────────────────────────────────────────
console.log('\n[5] middleware wiring and dev server');
{
  const middleware = read('middleware.ts');
  ok(/export const config = \{\s*matcher: \['\/product\/:path\*'\],[\s\S]*?runtime: 'nodejs',\s*\};/.test(middleware),
    'the middleware only runs on product detail paths (Node.js runtime)');
  ok(/from '\.\/src\/lib\/product-exists\.cjs'/.test(middleware), 'the middleware reuses the tested helpers');
  ok(middleware.indexOf('isCrawler(') < middleware.indexOf('checkProductExists('),
    'crawlers are detected before any database request');
  ok(/if \(exists === false\) return buildNotFoundResponse\(request\);/.test(middleware),
    'only a confirmed missing product becomes a 404');
  ok(/headers: \{ 'x-middleware-next': '1' \}/.test(middleware),
    'passthrough returns the documented continuation header');
  ok(/if \(id === null\) return continueRequest\(\);/.test(middleware),
    'non-detail product paths continue the chain');
  ok(/if \(!isCrawler\([\s\S]*?\) return continueRequest\(\);/.test(middleware),
    'non-crawler requests continue the chain');
  ok(!/^\s*return;\s*$/m.test(middleware),
    'the middleware never returns undefined (that drops the response body)');

  const pkg = JSON.parse(read('package.json'));
  ok(!pkg.dependencies?.['@vercel/functions'],
    'no extra runtime dependency is added for one helper');
  ok(!/vercel dev/.test(pkg.scripts.dev || ''), 'npm run dev no longer calls vercel dev (recursion guard)');
  ok(!/vercel dev/.test(pkg.scripts.start || ''), 'npm start no longer calls vercel dev');
  eq(pkg.scripts.start, 'vite', 'npm start runs the Vite dev server');
  eq(pkg.scripts.dev, 'vite', 'npm run dev runs the Vite dev server');

  const viteConfig = read('vite.config.js');
  ok(/port: Number\(process\.env\.PORT\) \|\| 3000/.test(viteConfig),
    'the dev server reads the port assigned by vercel dev');
  ok(/strictPort: true/.test(viteConfig), 'the dev server refuses to silently change ports');

  const vercel = JSON.parse(read('vercel.json'));
  eq(vercel.devCommand, 'npm run start', 'vercel dev runs the Vite dev command');
  eq(vercel.framework, null, 'the framework preset stays overridden for the real 404 route');
  ok(!vercel.proxy, 'the matcher lives in middleware.ts only (proxy.matcher would conflict)');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
