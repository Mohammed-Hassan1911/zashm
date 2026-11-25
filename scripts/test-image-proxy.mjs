/**
 * Cloudflare image proxy: URL helpers, edge cache and fail-open fallbacks.
 *
 *   node scripts/test-image-proxy.mjs
 */
import { readFile } from 'node:fs/promises';
import {
  IMAGE_WIDTH_VALUES,
  decodeImageKey,
  encodeImageKey,
  imageCandidates,
  imageKeyFromUrl,
  imageSrcSet,
  isProxyImageUrl,
  isValidImageKey,
  isImageResponse,
  negotiatedImageFormat,
  parseImagePath,
  proxyImageUrl,
  resolveImageWidth,
} from '../src/lib/image-proxy.mjs';
import { mirrorCandidates } from '../src/lib/resilience.js';
import {
  handleImageRequest,
  handleRequest,
} from '../src/lib/worker-runtime.mjs';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`ok - ${label}`);
  } else {
    fail += 1;
    console.log(`NOT OK - ${label} :: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}
function ok(value, label) {
  eq(Boolean(value), true, label);
}
function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const PRODUCT_URL = 'https://ptegprcbtfylqhbnbkih.supabase.co/storage/v1/object/public/products/reviews/7/abc123.jpg';
const KEY = 'products/reviews/7/abc123.jpg';

section(1, 'URL helpers');
eq(resolveImageWidth('thumb'), 160, 'thumb width');
eq(resolveImageWidth('card'), 480, 'card width');
eq(resolveImageWidth('detail'), 1200, 'detail width');
eq(resolveImageWidth(1200), 1200, 'an allowed numeric width is preserved');
eq(resolveImageWidth('9999'), 0, 'unknown widths fail closed');
eq(resolveImageWidth(null), 0, 'missing widths fail closed');
eq(IMAGE_WIDTH_VALUES, [160, 480, 1200], 'only three transformation widths are used');
ok(isValidImageKey(KEY), 'a nested product key is valid');
ok(!isValidImageKey('../etc/passwd'), 'traversal is rejected');
ok(!isValidImageKey('products/../etc/passwd'), 'bucket traversal is rejected');
ok(!isValidImageKey('/absolute.jpg'), 'absolute paths are rejected');
ok(!isValidImageKey('private/a.jpg'), 'other buckets are rejected');
ok(!isValidImageKey('a?b.jpg'), 'query characters are rejected');
eq(decodeImageKey(encodeImageKey(KEY)), KEY, 'encode/decode round-trips a nested key');
eq(encodeImageKey('../bad'), '', 'invalid keys are never encoded');
eq(imageKeyFromUrl(PRODUCT_URL), KEY, 'public Supabase URL yields the object key');
eq(imageKeyFromUrl(`${PRODUCT_URL}?download=1`), KEY, 'query string is ignored');
eq(imageKeyFromUrl('https://x.supabase.co/storage/v1/object/public/private/a.jpg'), '',
  'non-product buckets are not proxied');
eq(imageKeyFromUrl('data:image/svg+xml,a'), '', 'data URIs are not proxied');
eq(imageKeyFromUrl('/media/products/a.jpg'), '', 'the committed mirror is not proxied');
eq(negotiatedImageFormat('image/avif,image/webp'), 'avif', 'AVIF clients get a dedicated variant');
eq(negotiatedImageFormat('text/html,image/webp'), 'webp', 'WebP clients get a dedicated variant');
eq(negotiatedImageFormat('text/html'), '', 'clients without modern formats keep the original encoding');
eq(negotiatedImageFormat('image/avif;q=0,image/webp'), 'webp', 'an explicitly refused AVIF is not served as AVIF');
eq(negotiatedImageFormat('image/avif;q=0,image/webp;q=0,*/*;q=1'), '',
  'explicit q=0 overrides a permissive wildcard');
eq(negotiatedImageFormat('image/*;q=1'), 'avif', 'generic image clients get AVIF');
ok(!isImageResponse(new Response('partial', { status: 206, headers: { 'Content-Type': 'image/jpeg' } })),
  'partial 206 responses are never accepted for the immutable cache');

section(2, 'same-origin proxy URLs');
const card = proxyImageUrl(PRODUCT_URL, 'card');
ok(isProxyImageUrl(card), 'the optimized image is same-origin');
ok(/^\/img\/v1\/w480\/[A-Za-z0-9_-]+$/.test(card), 'the path has no image extension for Wrangler to bypass');
eq(parseImagePath(card), { width: 480, key: KEY }, 'the Worker can parse its own URL');
eq(parseImagePath('/img/v1/w999/abc'), null, 'unknown widths are rejected');
eq(parseImagePath('/img/v1/w480/!!'), null, 'invalid base64url is rejected');
eq(parseImagePath('/img/v2/w480/abc'), null, 'unknown versions are rejected');
eq(parseImagePath('/img/v1/w480/abc.jpg'), null, 'extensions never reach the Worker route');
eq(proxyImageUrl('https://cdn.example.com/a.jpg', 'card'), 'https://cdn.example.com/a.jpg',
  'external images stay external');
eq(proxyImageUrl('data:image/svg+xml,a', 'card'), 'data:image/svg+xml,a',
  'inline placeholders stay inline');
const srcSet = imageSrcSet(PRODUCT_URL);
ok(srcSet.includes('480w') && srcSet.includes('1200w'), 'card srcSet offers both responsive widths');
ok(!srcSet.includes('160w'), 'tiny thumbnails do not inflate the card srcSet');
ok(!srcSet.includes('supabase.co'), 'srcSet never sends the browser back to Supabase');

section(3, 'browser fallbacks');
const candidates = imageCandidates(PRODUCT_URL, { width: 'card', srcSet: true, sizes: '50vw' });
eq(candidates[0].src, card, 'edge image is tried first');
eq(candidates[0].srcSet, srcSet, 'srcSet belongs to the edge candidate');
eq(candidates[0].sizes, '50vw', 'sizes are forwarded');
eq(candidates[1].src, PRODUCT_URL, 'the live Supabase URL is the second candidate');
eq(mirrorCandidates(PRODUCT_URL), [PRODUCT_URL, '/media/products/reviews/7/abc123.jpg'],
  'SafeImage appends the committed mirror after the proxy candidates');
eq(imageCandidates('data:image/svg+xml,a')[0].src, 'data:image/svg+xml,a',
  'data URIs are used unchanged');
eq(imageCandidates(''), [], 'empty sources produce no network request');

section(4, 'Worker edge cache');
function memoryCache() {
  const store = new Map();
  return {
    puts: 0,
    store,
    async match(request) {
      const hit = store.get(request.url);
      return hit ? hit.clone() : undefined;
    },
    async put(request, response) {
      this.puts += 1;
      store.set(request.url, response.clone());
    },
  };
}

const ENV = {
  VITE_SUPABASE_URL: 'https://ptegprcbtfylqhbnbkih.supabase.co',
  ZASHM_STOREFRONT_NOINDEX: '1',
};
const cache = memoryCache();
let fetchCalls = [];
const fetchImpl = async (url, init) => {
  fetchCalls.push({ url, init });
  const format = init.cf && init.cf.image.format ? init.cf.image.format : 'jpeg';
  return new Response(`optimized-${format}`, {
    status: 200,
    headers: { 'Content-Type': `image/${format}`, 'Content-Length': '9999' },
  });
};
const imageUrl = `https://zashm.example${card}`;
const first = await handleImageRequest(new Request(imageUrl, {
  headers: { accept: 'image/avif,image/webp,image/*' },
}), ENV, { cache, fetchImpl });
eq(first.status, 200, 'edge image is served');
eq(first.headers.get('content-type'), 'image/avif', 'transformed content type is preserved');
eq(first.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'browser caches the edge image');
eq(first.headers.get('vary'), 'Accept', 'format negotiation is accounted for');
eq(first.headers.get('x-zashm-image'), 'transformed', 'first response is marked transformed');
eq(first.headers.get('content-length'), null, 'the stale origin content length is dropped');
eq(await first.text(), 'optimized-avif', 'image bytes are streamed');
eq(fetchCalls.length, 1, 'one Supabase fetch creates the transformation');
eq(fetchCalls[0].url, PRODUCT_URL,
  'the fetch uses only the configured project and validated key');
eq(fetchCalls[0].init.cf.image.width, 480, 'cf.image uses the width from the path');
eq(fetchCalls[0].init.cf.image.format, 'avif', 'cf.image uses the negotiated concrete format');
eq(cache.puts, 1, 'the result is cached at the edge');
ok([...cache.store.keys()].some((key) => key.includes('__zashm_format=avif')),
  'the AVIF variant has its own internal cache key');

const acceptAvif = { headers: { accept: 'image/avif,image/webp,image/*' } };
const second = await handleImageRequest(new Request(`${imageUrl}?v=2`, acceptAvif), ENV, { cache, fetchImpl });
eq(second.status, 200, 'cached image is still served');
eq(second.headers.get('x-zashm-image'), 'hit', 'cache hits are identified');
eq(fetchCalls.length, 1, 'a cache-busting query does not re-fetch Supabase');
eq(cache.puts, 1, 'no duplicate cache object is written');

const headHit = await handleImageRequest(new Request(imageUrl, { ...acceptAvif, method: 'HEAD' }), ENV, { cache, fetchImpl });
eq(headHit.status, 200, 'HEAD is served from the edge cache');
eq(headHit.body, null, 'a HEAD cache hit carries no body');
eq(fetchCalls.length, 1, 'HEAD does not re-fetch Supabase');

const webp = await handleImageRequest(new Request(imageUrl, {
  headers: { accept: 'image/webp,image/apng' },
}), ENV, { cache, fetchImpl });
eq(webp.status, 200, 'WebP clients are served');
eq(webp.headers.get('x-zashm-image'), 'transformed', 'a different format creates a new transformation');
eq(await webp.text(), 'optimized-webp', 'WebP bytes are not confused with AVIF');
eq(fetchCalls.length, 2, 'format-specific cache keys do not cross-serve');
const webpAgain = await handleImageRequest(new Request(imageUrl, {
  headers: { accept: 'image/webp,image/apng' },
}), ENV, { cache, fetchImpl });
eq(webpAgain.headers.get('x-zashm-image'), 'hit', 'the WebP variant hits its own cache entry');
eq(fetchCalls.length, 2, 'repeated WebP requests do not touch Supabase');

section(5, 'fallbacks and guards');
const noTransformCache = memoryCache();
let fallbackCalls = 0;
const failingTransformFetch = async (url, init) => {
  fallbackCalls += 1;
  if (init.cf) return new Response('9422', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  return new Response('original-bytes', { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
};
const fallback = await handleImageRequest(new Request(imageUrl), ENV, {
  cache: noTransformCache,
  fetchImpl: failingTransformFetch,
});
eq(fallback.status, 200, 'a transformation limit does not break the photo');
eq(fallback.headers.get('x-zashm-image'), 'original', 'the original is used as the safety net');
eq(fallback.headers.get('cache-control'), 'public, max-age=60', 'the fallback is not pinned as immutable');
eq(await fallback.text(), 'original-bytes', 'original bytes are served');
eq(fallbackCalls, 2, 'only one retry is attempted');
eq(noTransformCache.puts, 0, 'a failed transform does not cache the large original for a year');
let recoveredTransform = 0;
const recovered = await handleImageRequest(new Request(imageUrl, {
  headers: { accept: 'image/avif' },
}), ENV, {
  cache: noTransformCache,
  fetchImpl: async () => {
    recoveredTransform += 1;
    return new Response('resized', { headers: { 'Content-Type': 'image/avif' } });
  },
});
eq(recovered.headers.get('x-zashm-image'), 'transformed', 'the next visitor retries the resize');
eq(recoveredTransform, 1, 'the retry reaches the transform once');

const rangeCache = memoryCache();
let rangedCalls = 0;
const rangedFetch = async () => {
  rangedCalls += 1;
  if (rangedCalls === 1) return new Response('partial', {
    status: 206,
    headers: { 'Content-Type': 'image/jpeg' },
  });
  return new Response('full-original', { headers: { 'Content-Type': 'image/jpeg' } });
};
const ranged = await handleImageRequest(new Request(imageUrl, {
  headers: { range: 'bytes=0-99' },
}), ENV, { cache: rangeCache, fetchImpl: rangedFetch });
eq(ranged.headers.get('x-zashm-image'), 'original', 'a 206 response is treated as a transform failure');
eq(rangeCache.puts, 0, 'partial bytes are never written to the immutable cache');
const afterRange = await handleImageRequest(new Request(imageUrl), ENV, {
  cache: rangeCache,
  fetchImpl: async () => new Response('full-resized', { headers: { 'Content-Type': 'image/jpeg' } }),
});
eq(afterRange.headers.get('x-zashm-image'), 'transformed', 'a later full request gets a real transform');

const broken = await handleImageRequest(new Request(imageUrl), ENV, {
  cache: memoryCache(),
  fetchImpl: async () => new Response('missing', { status: 404 }),
});
eq(broken.status, 502, 'a missing object returns a real error');
eq(broken.headers.get('cache-control'), 'no-store', 'errors are never cached');
const post = await handleImageRequest(new Request(imageUrl, { method: 'POST' }), ENV, {});
eq(post.status, 405, 'the proxy is GET/HEAD only');
eq(post.headers.get('allow'), 'GET, HEAD', 'the allow header is explicit');
const noOrigin = await handleImageRequest(new Request(imageUrl), {}, {
  fetchImpl: () => { throw new Error('must not fetch'); },
});
eq(noOrigin.status, 404, 'an unconfigured Worker never guesses a Supabase project');
const invalid = await handleImageRequest(new Request('https://zashm.example/img/v1/w480/abc'), ENV, {});
eq(invalid.status, 404, 'an invalid key does not become an open proxy');
const head = await handleImageRequest(new Request(imageUrl, { method: 'HEAD' }), ENV, {
  cache: memoryCache(),
  fetchImpl,
});
eq(head.status, 200, 'HEAD is supported');
eq(head.body, null, 'HEAD has no body');

section(6, 'routing and deployed configuration');
let routedFetch = 0;
const routed = await handleRequest(new Request(imageUrl), {
  ...ENV,
  ASSETS: { fetch() { throw new Error('the proxy must not use ASSETS'); } },
}, {
  cache: memoryCache(),
  fetchImpl: async () => {
    routedFetch += 1;
    return new Response('routed-bytes', { headers: { 'Content-Type': 'image/jpeg' } });
  },
});
eq(routed.status, 200, 'handleRequest dispatches the proxy path');
eq(routedFetch, 1, 'the route reaches the image fetch exactly once');
eq(routed.headers.get('content-security-policy') !== null, true, 'image responses keep the CSP');
eq(routed.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', 'temporary noindex covers images too');
const wrangler = await readFile(new URL('../wrangler.production.toml', import.meta.url), 'utf8');
const patterns = /run_worker_first = \[([\s\S]*?)\]/.exec(wrangler)?.[1] || '';
ok(patterns.includes('"/*"'), 'the production Worker keeps its catch-all');
ok(!patterns.includes('!/img'), 'the proxy path is not excluded from the Worker');
const runtime = await readFile(new URL('../src/lib/worker-runtime.mjs', import.meta.url), 'utf8');
ok(runtime.includes('parseImagePath(url.pathname)'), 'handleRequest dispatches the proxy route');
ok(/cf:\s*\{\s*image:/.test(runtime), 'the Worker requests Cloudflare image transformation');
ok(runtime.includes('negotiatedImageFormat(accept)'), 'the Worker negotiates a concrete image format');
ok(!runtime.includes('requestHeaders.Range'), 'client Range headers are never forwarded to the origin');

section(7, 'storefront wiring');
const safeImage = await readFile(new URL('../src/components/ui/SafeImage.js', import.meta.url), 'utf8');
const cardSource = await readFile(new URL('../src/components/shop/ProductCard.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../src/pages/ProductPage.js', import.meta.url), 'utf8');
const lightboxSource = await readFile(new URL('../src/components/ui/ProductImageLightbox.js', import.meta.url), 'utf8');
const cartSource = await readFile(new URL('../src/pages/CartPage.js', import.meta.url), 'utf8');
ok(safeImage.includes("useImageFallback(src, fallback, { width, srcSet: withSrcSet, sizes })"),
  'SafeImage resolves width options in a single unconditional hook call');
ok(safeImage.includes("['data-image-width']: _width"), 'internal width hints never reach the DOM');
ok(cardSource.includes("width: 'card'") && cardSource.includes('srcSet: true'),
  'cards request the 480/1200px responsive pair');
ok(cardSource.includes('srcSet={primary.srcSet || undefined}') && cardSource.includes('srcSet={secondaryRequested'),
  'both card frames expose the edge srcSet');
ok(pageSource.includes('data-image-width="detail"') && pageSource.includes('data-image-width="thumb"'),
  'product hero and thumbnails use different transformation widths');
ok(lightboxSource.includes('data-image-width="detail"'), 'the zoom dialog reuses the cached hero width');
ok(cartSource.includes('data-image-width="thumb"'), 'bag thumbnails stay at 160px');
const prerenderSource = await readFile(new URL('../scripts/prerender-products.mjs', import.meta.url), 'utf8');
ok(prerenderSource.includes("proxyImageUrl(image, 'detail')"),
  'the prerendered LCP preload matches the optimized React image');
ok(prerenderSource.includes('setMeta(html, \'property\', \'og:image\', image)'),
  'OG/Twitter tags still advertise the original Supabase asset to crawlers');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
