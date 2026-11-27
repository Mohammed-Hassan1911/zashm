/**
 * Robots meta policy regressions.
 *
 *   node scripts/test-robots-meta-policy.mjs
 *
 * Proves that a noindex directive baked into the prerendered shell survives
 * every SPA setPageMeta call, including public pages and per-page overrides.
 * Also checks that canonical/og:url/Product JSON-LD/sitemap still agree on the
 * live origin. Uses jsdom, which is already a devDependency.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

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
function heading(n, title) { console.log(`\n[${n}] ${title}`); }

const root = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const seoSource = read('src/lib/seo.js');

// Vite resolves the extensionless ./pricing import; plain Node ESM does not.
// Copy the three small helpers to a temp dir with that one import normalised,
// so the real source is exercised without changing its Vite conventions.
const tmpDir = mkdtempSync(join(tmpdir(), 'zashm-robots-'));
process.on('exit', () => rmSync(tmpDir, { recursive: true, force: true }));
for (const name of ['pricing.js', 'product-url.mjs']) {
  writeFileSync(join(tmpDir, name), read(`src/lib/${name}`));
}
writeFileSync(
  join(tmpDir, 'seo.js'),
  seoSource.replace("from './pricing'", "from './pricing.js'"),
);
const seoModuleUrl = pathToFileURL(join(tmpDir, 'seo.js')).href;

// A query suffix gives each scenario a fresh module instance, so the cached
// shell directive from the previous DOM cannot leak into the next one.
const loadSeo = (scenario) => import(`${seoModuleUrl}?scenario=${scenario}`);

function mount(shellRobots, url = 'https://example.test/product/1') {
  const meta = shellRobots == null
    ? ''
    : `<meta name="robots" content="${shellRobots}"/>`;
  const dom = new JSDOM(
    `<!doctype html><html><head>${meta}</head><body></body></html>`,
    { url },
  );
  global.window = dom.window;
  global.document = dom.window.document;
  return dom;
}

function robotsOf(dom) {
  return dom.window.document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
}

// ─── [1] One shell-aware robots writer ──────────────────────────────────────
heading(1, 'single shell-aware robots writer');
{
  ok(!/setAttribute\('content', 'index, follow'\)/.test(seoSource),
    'setPageMeta never hardcodes an index, follow rewrite');
  ok(/robotsFromShell\(\)/.test(seoSource) && /robotsForPage\(robots\)/.test(seoSource),
    'robots resolution goes through the shell-aware helpers');
  ok(/\bnoindex\b/.test(seoSource), 'the shell noindex directive is explicitly protected');
  const writers = seoSource.match(/setNamed\('robots'/g) || [];
  eq(writers.length, 1, 'the robots meta has exactly one runtime writer');
}

// ─── [2] Noindex shell stays authoritative ──────────────────────────────────
heading(2, 'noindex shell stays authoritative for home, shop and product');
{
  const dom = mount('noindex, nofollow, noarchive');
  const seo = await loadSeo('noindex-shell');
  const expected = 'noindex, nofollow, noarchive';

  seo.setPageMeta({ title: 'Home' });
  eq(robotsOf(dom), expected, 'home without an explicit robots keeps the shell policy');

  seo.setPageMeta({ title: 'Shop' });
  eq(robotsOf(dom), expected, 'shop without an explicit robots keeps the shell policy');

  seo.setPageMeta({ title: 'Product', preserveTitle: true, url: 'https://example.test/product/1' });
  eq(robotsOf(dom), expected, 'product metadata refresh keeps the shell policy');
  eq(dom.window.document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    'https://example.test/product/1', 'canonical still follows the supplied url');
  eq(dom.window.document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    'https://example.test/product/1', 'og:url matches canonical');

  seo.setPageMeta({ title: 'Cart', robots: 'noindex, nofollow' });
  eq(robotsOf(dom), expected, 'a private page cannot weaken noarchive while the shell is noindex');

  seo.setPageMeta({ title: 'Attempted index', robots: 'index, follow' });
  eq(robotsOf(dom), expected, 'an explicit index, follow call cannot remove noindex');
}

// ─── [3] Indexable shell still honours private pages ────────────────────────
heading(3, 'indexable shell keeps the original private-route contract');
{
  const dom = mount('index, follow');
  const seo = await loadSeo('indexable-shell');

  seo.setPageMeta({ title: 'Home' });
  eq(robotsOf(dom), 'index, follow', 'public pages remain indexable when the shell is indexable');

  seo.setPageMeta({ title: 'Cart', robots: 'noindex, nofollow' });
  eq(robotsOf(dom), 'noindex, nofollow', 'private pages still set their own noindex');

  seo.setPageMeta({ title: 'Shop' });
  eq(robotsOf(dom), 'index, follow', 'returning to a public page restores the shell directive');
}

// ─── [4] Product JSON-LD mirrors canonical without query parameters ─────────
heading(4, 'Product JSON-LD url matches canonical and og:url');
{
  // A tracked deep link must not leak UTM/token params into structured data.
  const trackedUrl = 'https://example.test/product/1?utm_source=newsletter&tk=abc123#reviews';
  const dom = mount('index, follow', trackedUrl);
  const seo = await loadSeo('jsonld-canonical-scenario');
  const expectedUrl = 'https://example.test/product/1';
  const product = {
    id: 1,
    name: 'Test Piece',
    description: 'A real description',
    image: 'https://example.test/old.jpg',
    images: ['https://example.test/a.jpg'],
    price: 100,
    salePrice: 80,
    stock: 5,
    sizes: [],
    colors: [],
    variantStock: null,
    sku: 'SKU-1',
    category: 'Test',
  };

  seo.setPageMeta({ title: 'Test Piece', preserveTitle: true });
  const canonical = dom.window.document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const ogUrl = dom.window.document.querySelector('meta[property="og:url"]')?.getAttribute('content');
  eq(canonical, expectedUrl, 'canonical strips query and hash from the product url');
  eq(ogUrl, expectedUrl, 'og:url matches canonical');

  seo.setProductJsonLd(product);
  const node = dom.window.document.getElementById('zashm-product-jsonld');
  const data = node ? JSON.parse(node.textContent) : null;
  eq(data?.name, 'Test Piece', 'JSON-LD uses the real product name');
  eq(data?.offers?.url, expectedUrl, 'offers.url is the absolute canonical product url');
  eq(data?.offers?.url, canonical, 'offers.url matches the canonical link exactly');
  eq(data?.offers?.url, ogUrl, 'offers.url matches og:url exactly');
  ok(!/\?|#/.test(String(data?.offers?.url)), 'offers.url carries no query or hash');
  eq(data?.offers?.price, 80, 'JSON-LD keeps the effective sale price');
  eq(data?.offers?.priceCurrency, 'EGP', 'JSON-LD prices are in EGP');
  eq(data?.offers?.availability, 'https://schema.org/InStock', 'plain stock maps to InStock');

  seo.setProductJsonLd({ ...product, stock: 0 });
  const soldOut = JSON.parse(dom.window.document.getElementById('zashm-product-jsonld').textContent);
  eq(soldOut.offers.availability, 'https://schema.org/OutOfStock', 'zero stock maps to OutOfStock');
  eq(soldOut.offers.url, expectedUrl, 'sold-out offers.url stays on the canonical url');
  eq(soldOut.offers.price, 80, 'sold-out price is still the effective price');

  seo.clearProductJsonLd();
  eq(!!dom.window.document.getElementById('zashm-product-jsonld'), false,
    'leaving the product clears its JSON-LD');

  ok(!seoSource.includes('window.location.href'),
    'runtime JSON-LD never derives offers.url from the full href');
  ok(/canonicalUrl\(window\.location\.pathname, window\.location\.origin\)/.test(seoSource),
    'offers.url is built from the same origin + pathname rule as canonical');
  ok(/const origin = typeof window !== 'undefined'\s*\? window\.location\.origin/.test(seoSource),
    'site JSON-LD uses the live browser origin');

  const sitemap = read('api/sitemap.mjs');
  const staticStart = sitemap.indexOf('const STATIC_URLS');
  const staticEnd = sitemap.indexOf('function env', staticStart);
  const staticBlock = staticEnd > staticStart ? sitemap.slice(staticStart, staticEnd) : '';
  ok(/path: '\/'/.test(staticBlock) && /path: '\/shop'/.test(staticBlock),
    'sitemap advertises the public home and shop shells');
  ok(!/\/(cart|checkout|wishlist|track|admin)/.test(staticBlock),
    'sitemap never lists private routes');
  ok(/resolveSiteOrigin\(\)/.test(sitemap) && /approvedSiteOrigins\(\)/.test(sitemap),
    'sitemap origin is fail-closed through approved origins');
}

// ─── [5] Temporary workers.dev origin stays canonical and fail-closed ───────
heading(5, 'temporary workers.dev origin stays canonical and fail-closed');
{
  const tempOrigin = 'https://zashm.za-shm.workers.dev';
  const wrangler = read('wrangler.production.toml');
  const escaped = tempOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of ['PUBLIC_BASE_URL', 'ALLOWED_ORIGINS', 'SITEMAP_ALLOWED_ORIGINS']) {
    ok(new RegExp(`^${name} = "${escaped}"$`, 'm').test(wrangler),
      `${name} pins the approved temporary workers.dev origin`);
  }
  ok(/^ZASHM_STOREFRONT_NOINDEX = "1"$/m.test(wrangler),
    'the temporary launch still forces storefront noindex');
  ok(!/^\s*(?:route|routes|zone|zone_id)\s*=/m.test(wrangler),
    'no Route or Zone binding was added to the temporary Worker');

  const sitemapApi = await import(new URL('api/sitemap.mjs', root).href);
  const savedOrigins = {
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    SITEMAP_ALLOWED_ORIGINS: process.env.SITEMAP_ALLOWED_ORIGINS,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  };
  process.env.PUBLIC_BASE_URL = tempOrigin;
  process.env.SITEMAP_ALLOWED_ORIGINS = tempOrigin;
  process.env.ALLOWED_ORIGINS = tempOrigin;
  eq(sitemapApi.resolveSiteOrigin(), { origin: tempOrigin, valid: true },
    'the approved workers.dev env resolves as the canonical origin');
  ok(sitemapApi.approvedSiteOrigins().has(tempOrigin),
    'workers.dev is present in the fail-closed sitemap allow-list');
  ok(!sitemapApi.resolveSiteOrigin().origin.includes('vercel.app'),
    'the retired Vercel fallback is not emitted while workers.dev is configured');

  process.env.PUBLIC_BASE_URL = 'https://attacker.example';
  eq(sitemapApi.resolveSiteOrigin().valid, false,
    'an unapproved canonical origin still fails closed');
  for (const [name, value] of Object.entries(savedOrigins)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
