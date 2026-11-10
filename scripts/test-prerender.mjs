/**
 * Product-page prerender.
 *
 * The prerendered file is the built SPA shell with product metadata, Product
 * JSON-LD and an LCP image preload injected. These tests lock the two things
 * that can actually break:
 *
 *   1. the shell stays a working SPA (`#root` + module script untouched);
 *   2. the injected values are correct and HTML/JSON-safe.
 *
 *   node scripts/test-prerender.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  absoluteImageUrl,
  baseUrlFromEnv,
  escapeHtml,
  renderProductHtml,
  writeProductPages,
} from './prerender-products.mjs';

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

const ROOT = new URL('..', import.meta.url).pathname;
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

// A trimmed copy of the real built shell: the parts the injection touches.
const TEMPLATE = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8"/>',
  '  <title>ZASHM — Luxury Fashion</title>',
  '  <meta name="description" content="ZASHM — luxury fashion."/>',
  '  <meta name="robots" content="index, follow"/>',
  '  <link rel="canonical" href="https://za-shm.vercel.app/"/>',
  '  <meta property="og:type" content="website"/>',
  '  <meta property="og:site_name" content="ZASHM"/>',
  '  <meta property="og:title" content="ZASHM — Luxury Fashion"/>',
  '  <meta property="og:description" content="ZASHM — luxury fashion."/>',
  '  <meta property="og:url" content="https://za-shm.vercel.app/"/>',
  '  <meta property="og:image" content="https://za-shm.vercel.app/og-image.jpg"/>',
  '  <meta property="og:image:width" content="1200"/>',
  '  <meta property="og:image:height" content="630"/>',
  '  <meta property="og:image:alt" content="ZASHM — Luxury Fashion"/>',
  '  <meta name="twitter:card" content="summary_large_image"/>',
  '  <meta name="twitter:title" content="ZASHM — Luxury Fashion"/>',
  '  <meta name="twitter:description" content="ZASHM — luxury fashion."/>',
  '  <meta name="twitter:image" content="https://za-shm.vercel.app/og-image.jpg"/>',
  '  <meta name="twitter:image:alt" content="ZASHM — Luxury Fashion"/>',
  '  <link rel="preconnect" href="https://ptegprcbtfylqhbnbkih.supabase.co" crossorigin/>',
  '  <link rel="stylesheet" href="/assets/index-abc.css"/>',
  '</head>',
  '<body>',
  '  <div id="root"></div>',
  '  <script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '</body>',
  '</html>',
].join('\n');

const PRODUCT = {
  id: '1794232720755261',
  name: 'Jacket',
  description: 'Structured wool jacket with a sculpted shoulder.',
  category: 'Outerwear',
  price: 2500,
  salePrice: 2000,
  stock: 9,
  sizes: ['M', 'L'],
  colors: ['Black', 'Burgundy'],
  variantStock: { 'M-Black': 2, 'L-Black': 1, 'L-Burgundy': 2 },
  images: ['https://ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/jacket.jpg'],
  sku: 'ZSH-JKT-1',
};

const jsonLdOf = (html) => {
  const match = /<script type="application\/ld\+json" id="zashm-product-jsonld">([\s\S]*?)<\/script>/.exec(html);
  return match ? JSON.parse(match[1]) : null;
};

console.log('\n[1] the prerendered file is still the SPA shell');
{
  const html = renderProductHtml(TEMPLATE, PRODUCT);
  ok(html, 'a product page is produced');
  ok(html.includes('<div id="root"></div>'), 'the React root is untouched');
  ok(html.includes('src="/assets/index-abc.js"'), 'the module entry still loads');
  ok(html.includes('<link rel="stylesheet" href="/assets/index-abc.css"/>'), 'styles are untouched');
  ok(html.includes('id="zashm-product-jsonld"'), 'the client and the prerender share one JSON-LD id');
  ok(html.startsWith('<!DOCTYPE html>'), 'doctype preserved');
}

console.log('\n[2] metadata matches what the SPA sets after mount');
{
  const html = renderProductHtml(TEMPLATE, PRODUCT);
  ok(html.includes('<title>Jacket — ZASHM</title>'), 'title');
  ok(html.includes('<meta name="description" content="Structured wool jacket with a sculpted shoulder."/>'), 'description');
  ok(html.includes('<link rel="canonical" href="https://za-shm.vercel.app/product/1794232720755261"/>'), 'canonical');
  ok(html.includes('<meta property="og:title" content="Jacket — ZASHM"/>'), 'og:title');
  ok(html.includes('<meta property="og:url" content="https://za-shm.vercel.app/product/1794232720755261"/>'), 'og:url');
  ok(html.includes('<meta property="og:image" content="https://ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/jacket.jpg"/>'), 'og:image');
  ok(html.includes('<meta property="og:image:alt" content="Jacket"/>'), 'og:image:alt');
  ok(!html.includes('og:image:width'), 'the site card dimensions are removed');
  ok(!html.includes('og:image:height'), 'the site card dimensions are removed');
  ok(html.includes('<meta name="twitter:image" content="https://ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/jacket.jpg"/>'), 'twitter:image');
  ok(html.includes('<meta name="robots" content="index, follow"/>'), 'robots stays indexable');
}

console.log('\n[3] the LCP image is discovered before the bundle runs');
{
  const html = renderProductHtml(TEMPLATE, PRODUCT);
  const preload = /<meta charset="utf-8"\/>\n\s*<link rel="preload" as="image" href="([^"]+)" fetchpriority="high"\/>/.exec(html);
  ok(preload, 'a preload link is injected right after the charset');
  eq(preload && preload[1], PRODUCT.images[0], 'it points at the first product image');
  ok(html.indexOf('rel="preload"') < html.indexOf('rel="stylesheet"'), 'the preload comes before the stylesheet');
}

console.log('\n[4] Product structured data mirrors the storefront rules');
{
  const data = jsonLdOf(renderProductHtml(TEMPLATE, PRODUCT));
  eq(data && data['@type'], 'Product', 'type');
  eq(data && data.name, 'Jacket', 'name');
  eq(data && data.offers.price, 2000, 'sale price is used when 0 < salePrice < price');
  eq(data && data.offers.priceCurrency, 'EGP', 'currency');
  eq(data && data.offers.availability, 'https://schema.org/InStock', 'variant stock makes it InStock');
  eq(data && data.offers.url, 'https://za-shm.vercel.app/product/1794232720755261', 'offer url');
  eq(data && data.brand.name, 'ZASHM', 'brand');
  eq(data && data.sku, 'ZSH-JKT-1', 'sku');

  const noSale = jsonLdOf(renderProductHtml(TEMPLATE, { ...PRODUCT, salePrice: 0 }));
  eq(noSale && noSale.offers.price, 2500, 'salePrice 0 never becomes a free product');

  const tooHigh = jsonLdOf(renderProductHtml(TEMPLATE, { ...PRODUCT, salePrice: 9999 }));
  eq(tooHigh && tooHigh.offers.price, 2500, 'a sale price above price is ignored');

  const soldOut = jsonLdOf(renderProductHtml(TEMPLATE, {
    ...PRODUCT,
    variantStock: { 'M-Black': 0, 'L-Black': 0, 'L-Burgundy': 0 },
  }));
  eq(soldOut && soldOut.offers.availability, 'https://schema.org/OutOfStock', 'zero variant stock is OutOfStock');
}

console.log('\n[5] customer-controlled text cannot break the HTML or the JSON');
{
  const hostile = {
    ...PRODUCT,
    name: 'Silk <Abaya> & "Co"',
    description: 'Line one </script><img src=x onerror=alert(1)>',
  };
  const html = renderProductHtml(TEMPLATE, hostile);
  ok(html.includes('<title>Silk &lt;Abaya&gt; &amp; &quot;Co&quot; — ZASHM</title>'), 'title is escaped');
  ok(!html.includes('<img src=x onerror=alert(1)>'), 'no live markup from the description');
  const match = /<script type="application\/ld\+json" id="zashm-product-jsonld">([\s\S]*?)<\/script>/.exec(html);
  ok(match, 'the JSON-LD block is intact');
  ok(!match[1].includes('</script>'), 'the JSON payload cannot close the script tag');
  const data = JSON.parse(match[1]);
  eq(data.name, 'Silk <Abaya> & "Co"', 'the parsed name keeps the real characters');
  ok(match[1].includes('\\u003c'), 'angle brackets are unicode-escaped inside JSON');
}

console.log('\n[6] nothing unsafe gets a page');
{
  eq(renderProductHtml(TEMPLATE, { ...PRODUCT, id: 'abc' }), null, 'a non-numeric id is refused');
  eq(renderProductHtml(TEMPLATE, { ...PRODUCT, id: '../etc' }), null, 'a traversal id is refused');
  eq(renderProductHtml(TEMPLATE, { ...PRODUCT, id: '0' }), null, 'id 0 is refused');
  eq(renderProductHtml(TEMPLATE, { ...PRODUCT, active: false }), null, 'an inactive product is refused');
  eq(renderProductHtml('<html><head></head><body></body></html>', PRODUCT), null, 'a shell without #root is refused');

  const noImage = renderProductHtml(TEMPLATE, { ...PRODUCT, images: [], image: '' });
  ok(!noImage.includes('rel="preload"'), 'no preload without an image');
  ok(noImage.includes('<meta property="og:image" content="https://za-shm.vercel.app/og-image.jpg"/>'), 'the site card is kept as the fallback');
  ok(noImage.includes('og:image:width'), 'the site card dimensions are kept');
}

console.log('\n[7] files land at the path Vercel already serves');
{
  const dir = mkdtempSync(join(tmpdir(), 'zashm-prerender-'));
  try {
    const result = writeProductPages([PRODUCT, { ...PRODUCT, id: 'bad' }], TEMPLATE, { buildDir: dir });
    eq(result.written, 1, 'one page written');
    eq(result.skipped, ['bad'], 'the unsafe id is reported, not written');
    const file = join(dir, 'product', PRODUCT.id, 'index.html');
    ok(existsSync(file), 'build/product/<id>/index.html exists');
    ok(readFileSync(file, 'utf8').includes('<title>Jacket — ZASHM</title>'), 'the written file is the product page');
    eq(writeProductPages([], TEMPLATE, { buildDir: dir }).written, 0, 'an empty catalogue writes nothing');

    const plan = writeProductPages([{ ...PRODUCT, id: '123' }], TEMPLATE, { buildDir: dir, dryRun: true });
    eq(plan.written, 1, 'a dry run counts the page');
    ok(!existsSync(join(dir, 'product', '123')), 'a dry run writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n[8] URLs and environment');
{
  eq(absoluteImageUrl('products/a.jpg', 'https://za-shm.vercel.app'), 'https://za-shm.vercel.app/products/a.jpg', 'relative image resolved against the site');
  eq(absoluteImageUrl('data:image/svg+xml;base64,AAAA'), '', 'a data URL is never preloaded');
  eq(absoluteImageUrl(''), '', 'empty stays empty');
  eq(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'escape covers the five entities');
  eq(baseUrlFromEnv({ PUBLIC_BASE_URL: 'https://za-shm.vercel.app/' }), 'https://za-shm.vercel.app', 'trailing slash removed');
  eq(baseUrlFromEnv({}), 'https://za-shm.vercel.app', 'sane default');
}

console.log('\n[9] build wiring');
{
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.scripts.build.includes('scripts/prerender-products.mjs'), 'npm run build prerenders');
  ok(pkg.scripts.test.includes('scripts/test-prerender.mjs'), 'this suite runs in npm test');

  const vercel = JSON.parse(read('vercel.json'));
  ok(!vercel.cleanUrls, 'routing config is unchanged (no cleanUrls)');
  ok((vercel.rewrites || []).some((r) => r.source === '/product/:path*' && r.destination === '/index.html'),
    'the SPA fallback rewrite still exists');

  const script = read('scripts/prerender-products.mjs');
  ok(!script.includes('SERVICE_ROLE'), 'the prerender never touches a service-role key');
  ok(!script.includes('loadExclusions'), 'live products are not filtered by the offline-backup exclusions');
  ok(!script.includes('EXCLUSIONS_FILE'), 'the exclusion file is never read');
  ok(script.includes("type: 'application/ld+json'") || script.includes('application/ld+json'), 'JSON-LD is emitted');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
