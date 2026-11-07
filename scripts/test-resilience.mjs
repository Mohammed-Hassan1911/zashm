/**
 * Resilience regression tests: same-origin image mirror, catalogue snapshot
 * fallback, and the WhatsApp outage hand-off.
 *
 *   node scripts/test-resilience.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_MIRROR_PREFIX,
  WHATSAPP_NUMBER,
  cartWhatsAppMessage,
  fetchCatalogSnapshot,
  isOutageError,
  mirrorCandidates,
  mirrorUrl,
  whatsappUrl,
} from '../src/lib/resilience.js';
import {
  bucketKeyForUrl,
  filterExcluded,
  isOversizedImage,
  listMirrorKeys,
  loadExclusions,
  localMirrorPath,
  MIRROR_MAX_FILE_BYTES,
  pruneMirror,
  safeBucketKey,
  selectOrphanKeys,
} from './resilience-sync.mjs';

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

const BASE = '/media';
const SB = 'https://ptegprcbtfylqhbnbkih.supabase.co';
const IMG = `${SB}/storage/v1/object/public/products/abc123.jpg`;

console.log('\n[1] mirrorUrl: Supabase Storage -> same-origin /media path');
{
  eq(mirrorUrl(IMG, BASE), `${BASE}/products/abc123.jpg`, 'maps the products bucket path');
  eq(mirrorUrl(`${IMG}?download=1`, BASE), `${BASE}/products/abc123.jpg`, 'strips the query string');
  eq(mirrorUrl('https://cdn.example.com/a.jpg', BASE), '', 'leaves external images alone');
  eq(mirrorUrl(`${SB}/storage/v1/object/public/products/../../etc/passwd`, BASE), '', 'rejects path traversal');
  eq(mirrorUrl(`${SB}/storage/v1/object/public/private/a.jpg`, BASE), `${BASE}/private/a.jpg`, 'maps any bucket path (sync filters keys)');
  eq(mirrorUrl(`/media/products/abc123.jpg`, BASE), '', 'already-local URLs are not rewritten');
  eq(mirrorUrl(null, BASE), '', 'null input is safe');
  eq(mirrorUrl(IMG, ''), '', 'empty prefix -> no mirror');
  eq(MEDIA_MIRROR_PREFIX, '/media', 'default prefix is /media');
}

console.log('\n[2] mirrorCandidates: live first, mirror second');
{
  eq(mirrorCandidates(IMG, BASE), [IMG, `${BASE}/products/abc123.jpg`], 'live then mirror');
  eq(mirrorCandidates('', BASE), [], 'empty image -> no candidates');
  eq(mirrorCandidates('https://cdn.example.com/a.jpg', BASE), ['https://cdn.example.com/a.jpg'], 'external URL is not duplicated');
}

console.log('\n[3] isOutageError');
{
  eq(isOutageError(0), true, 'network error (0)');
  eq(isOutageError(408), true, 'timeout');
  eq(isOutageError(500), true, 'server error');
  eq(isOutageError(503), true, 'unavailable');
  eq(isOutageError(400), false, 'validation error is not an outage');
  eq(isOutageError(409), false, 'conflict is not an outage');
  eq(isOutageError(undefined), false, 'missing status is not an outage');
}

console.log('\n[4] WhatsApp hand-off');
{
  const url = whatsappUrl('hello world');
  eq(url.startsWith(`https://wa.me/${WHATSAPP_NUMBER}?text=`), true, 'uses the support number');
  eq(decodeURIComponent(url.split('text=')[1]), 'hello world', 'message is URL-encoded');

  const message = cartWhatsAppMessage([
    { product: { name: 'Jacket Boxy' }, size: 'M', color: 'Black', qty: 2 },
  ], 4800);
  ok(message.includes('Jacket Boxy'), 'includes the product name');
  ok(message.includes('مقاس/Size M'), 'includes the size');
  ok(message.includes('Black'), 'includes the colour');
  ok(message.includes('×2'), 'includes the quantity');
  ok(message.includes('EGP 4,800'), 'includes the estimated total');
  ok(message.includes('مرحبًا ZASHM'), 'is bilingual');
  eq(cartWhatsAppMessage(null, null).includes('مرحبًا ZASHM'), true, 'empty bag still builds a valid intro');
}

console.log('\n[5] fetchCatalogSnapshot');
{
  const rows = [{ id: 1, name: 'A' }];
  const good = await fetchCatalogSnapshot(async () => ({
    ok: true,
    json: async () => ({ generatedAt: 'x', products: rows }),
  }));
  eq(good, rows, 'reads products[] from the snapshot');

  const legacy = await fetchCatalogSnapshot(async () => ({ ok: true, json: async () => rows }));
  eq(legacy, rows, 'accepts a bare array payload');

  let threw = false;
  try {
    await fetchCatalogSnapshot(async () => ({ ok: true, json: async () => ({ products: [] }) }));
  } catch { threw = true; }
  eq(threw, true, 'empty snapshot throws');

  threw = false;
  try {
    await fetchCatalogSnapshot(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  } catch { threw = true; }
  eq(threw, true, 'missing snapshot throws');
}

console.log('\n[6] mirror sync helpers');
{
  eq(safeBucketKey('products/a.jpg'), 'products/a.jpg', 'accepts the products folder');
  eq(safeBucketKey('products/a%20b.jpg'), 'products/a b.jpg', 'decodes percent escapes');
  eq(safeBucketKey('other/a.jpg'), '', 'refuses other folders');
  eq(safeBucketKey('products/../../etc/passwd'), '', 'refuses traversal');
  eq(safeBucketKey(''), '', 'refuses empty keys');
  eq(bucketKeyForUrl(IMG), 'products/abc123.jpg', 'extracts the key from a public URL');
  eq(bucketKeyForUrl(`${IMG}?v=2`), 'products/abc123.jpg', 'ignores the query string');
  eq(bucketKeyForUrl('https://cdn.example.com/a.jpg'), '', 'ignores external URLs');

  const target = localMirrorPath('products/abc123.jpg');
  ok(target.endsWith('/public/media/products/abc123.jpg'), 'resolves inside public/media');
  eq(localMirrorPath('products/../../etc/passwd'), '', 'never escapes public/media');
}

console.log('\n[6b] per-image size guard');
{
  eq(MIRROR_MAX_FILE_BYTES, Math.round(1.5 * 1024 * 1024), 'default per-image limit is 1.5MB');
  eq(isOversizedImage(1.4 * 1024 * 1024), false, '1.4MB is accepted');
  eq(isOversizedImage(MIRROR_MAX_FILE_BYTES), false, 'exactly at the limit is accepted');
  eq(isOversizedImage(MIRROR_MAX_FILE_BYTES + 1), true, 'one byte over the limit is rejected');
  eq(isOversizedImage(3 * 1024 * 1024), true, '3MB is rejected');
  eq(isOversizedImage(NaN), false, 'unknown size is not treated as oversized');

  const sync = readFileSync(new URL('./resilience-sync.mjs', import.meta.url), 'utf8');
  ok(sync.includes('MIRROR_MAX_FILE_MB'), 'the limit is configurable');
  ok(sync.includes('OVERSIZED'), 'oversized files are reported loudly');
  ok(sync.includes('oversized > 0') || sync.includes('result.oversized'), 'oversized files fail the run');
}

console.log('\n[6c] product exclusions (temporary/test products stay out of the backup)');
{
  eq(filterExcluded([{ id: 1 }, { id: '2' }, { id: 3 }], new Set(['2'])), [{ id: 1 }, { id: 3 }],
    'drops excluded ids regardless of number/string type');
  eq(filterExcluded([{ id: 1 }], new Set()), [{ id: 1 }], 'no exclusions keeps every product');
  eq(filterExcluded([{ id: 1 }], null), [{ id: 1 }], 'a missing exclusion set keeps every product');
  eq(filterExcluded(null, new Set(['1'])), [], 'a missing product list is safe');
  eq(filterExcluded([{ id: 7 }], ['7']), [], 'accepts an array of ids');

  const file = new URL('./resilience-exclude.json', import.meta.url);
  ok(existsSync(file), 'scripts/resilience-exclude.json is committed');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  ok(Array.isArray(payload.excludedIds), 'exclusion file has an excludedIds array');
  ok(payload.excludedIds.every((id) => /^\d+$/.test(String(id))), 'excluded ids are numeric');
  eq(loadExclusions(file).size, payload.excludedIds.length, 'loadExclusions reads the committed ids');

  const badDir = mkdtempSync(join(tmpdir(), 'zashm-exclude-'));
  try {
    const badFile = join(badDir, 'bad.json');
    writeFileSync(badFile, '{not json');
    let threw = false;
    try { loadExclusions(badFile); } catch { threw = true; }
    ok(threw, 'a malformed exclusion file is rejected');

    writeFileSync(badFile, JSON.stringify({ ids: ['1'] }));
    threw = false;
    try { loadExclusions(badFile); } catch { threw = true; }
    ok(threw, 'a missing excludedIds array is rejected');
  } finally {
    rmSync(badDir, { recursive: true, force: true });
  }

  const sync = readFileSync(new URL('./resilience-sync.mjs', import.meta.url), 'utf8');
  ok(sync.includes('filterExcluded'), 'sync applies the exclusion list');
  ok(sync.includes('--prune'), 'sync documents the prune flag');
  ok(sync.includes('--force-prune'), 'sync refuses an accidental full wipe without --force-prune');
}

console.log('\n[6d] prune: removed products release their mirror space');
{
  eq(selectOrphanKeys(new Set(['products/a.jpg']), ['products/a.jpg', 'products/b.jpg']),
    ['products/b.jpg'], 'unreferenced keys are orphans');
  eq(selectOrphanKeys(['products/a.jpg'], ['products/a.jpg']), [], 'referenced keys are kept');
  eq(selectOrphanKeys(new Set(), []), [], 'an empty mirror has no orphans');

  const dir = mkdtempSync(join(tmpdir(), 'zashm-prune-'));
  try {
    mkdirSync(join(dir, 'products'), { recursive: true });
    writeFileSync(join(dir, 'products', 'keep.jpg'), Buffer.alloc(10));
    writeFileSync(join(dir, 'products', 'drop.jpg'), Buffer.alloc(20));
    eq(listMirrorKeys(dir), ['products/drop.jpg', 'products/keep.jpg'], 'lists every mirrored file');

    const plan = pruneMirror(new Set(['products/keep.jpg']), { dir, dryRun: true });
    eq(plan.removed, 1, 'dry run reports the orphan');
    ok(existsSync(join(dir, 'products', 'drop.jpg')), 'dry run deletes nothing');

    const done = pruneMirror(new Set(['products/keep.jpg']), { dir });
    eq(done.removed, 1, 'prune removes the orphan');
    ok(done.bytes > 0, 'prune reports the reclaimed bytes');
    ok(!existsSync(join(dir, 'products', 'drop.jpg')), 'the orphan file is gone');
    ok(existsSync(join(dir, 'products', 'keep.jpg')), 'the referenced file survives');

    const emptied = pruneMirror(new Set(), { dir });
    eq(emptied.removed, 1, 'an empty reference set removes everything left');
    eq(listMirrorKeys(dir), [], 'the mirror is empty afterwards');

    mkdirSync(join(dir, 'products'), { recursive: true });
    writeFileSync(join(dir, 'products', 'leftover.tmp'), Buffer.alloc(4));
    eq(listMirrorKeys(dir), [], 'leftover temp files are not treated as mirrored images');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n[7] wiring: fallback is used by the storefront');
{
  const store = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  ok(store.includes('fetchCatalogSnapshot'), 'store imports the snapshot reader');
  ok(store.includes("productsSource: 'snapshot'"), 'store records the snapshot source');
  ok(store.includes('productsDegraded: true'), 'store flags the degraded state');
  ok(store.includes("productsSource: 'live'"), 'store records the live source');

  const app = readFileSync(new URL('../src/App.js', import.meta.url), 'utf8');
  ok(app.includes('<OutageNotice />'), 'App renders the outage notice');

  const notice = readFileSync(new URL('../src/components/ui/OutageNotice.js', import.meta.url), 'utf8');
  ok(notice.includes('نسخة احتياطية'), 'the notice has the backup copy');
  ok(notice.includes('المتجر متوقف مؤقتًا'), 'the notice has an honest copy for an empty backup');
  ok(notice.includes('cartWhatsAppMessage'), 'the notice links to the WhatsApp hand-off');

  const card = readFileSync(new URL('../src/components/shop/ProductCard.js', import.meta.url), 'utf8');
  ok(card.includes('useImageFallback'), 'product cards use the mirror fallback');

  const productPage = readFileSync(new URL('../src/pages/ProductPage.js', import.meta.url), 'utf8');
  ok(productPage.includes('SafeImage'), 'product gallery/size guide use SafeImage');

  const cart = readFileSync(new URL('../src/pages/CartPage.js', import.meta.url), 'utf8');
  ok(cart.includes('orderOutage'), 'checkout tracks an outage');
  ok(cart.includes('cartWhatsAppMessage'), 'checkout offers the WhatsApp hand-off');

  const track = readFileSync(new URL('../src/pages/TrackOrder.js', import.meta.url), 'utf8');
  ok(track.includes('SafeImage'), 'order tracking uses the mirror fallback');

  const sync = readFileSync(new URL('./resilience-sync.mjs', import.meta.url), 'utf8');
  ok(sync.includes("'public/media'"), 'sync writes into public/media');
  ok(sync.includes('MIRROR_MAX_MB'), 'sync enforces a mirror size budget');
  ok(!/R2_|r2\.cloudflarestorage/i.test(sync), 'sync has no external-storage credentials');

  const helper = readFileSync(new URL('../src/lib/resilience.js', import.meta.url), 'utf8');
  ok(!/R2_|r2\.cloudflarestorage/i.test(helper), 'browser helpers have no external-storage credentials');

  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const mediaRule = (vercel.headers || []).find((h) => h.source === '/media/(.*)');
  ok(Boolean(mediaRule), 'vercel.json has a /media header rule');
  ok(
    mediaRule && mediaRule.headers.some((h) => /immutable/.test(h.value)),
    'mirrored images are cached as immutable'
  );
  ok(/img-src[^;]*'self'/.test(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')),
    'CSP allows same-origin mirror images');
}

console.log('\n[8] committed catalogue snapshot + image mirror');
{
  const file = new URL('../public/catalog-snapshot.json', import.meta.url);
  ok(existsSync(file), 'public/catalog-snapshot.json is committed');
  if (existsSync(file)) {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    ok(Array.isArray(payload.products), 'snapshot has a products array');
    ok(Number(payload.count) === payload.products.length, 'count matches the products array');
    ok(Array.isArray(payload.excludedIds), 'snapshot records the excluded product ids');

    const excludedIds = (payload.excludedIds || []).map(String);
    const leaked = payload.products.filter((product) => (
      Object.prototype.hasOwnProperty.call(product, 'reservedStock')
      || Object.prototype.hasOwnProperty.call(product, 'active')
      || excludedIds.includes(String(product && product.id))
    ));
    eq(leaked.length, 0, 'snapshot exposes only public columns and no excluded product');

    const keys = new Set();
    for (const product of payload.products) {
      const urls = [];
      if (product && product.image) urls.push(product.image);
      if (product && Array.isArray(product.images)) urls.push(...product.images);
      if (product && product.sizeGuide) urls.push(product.sizeGuide);
      for (const url of urls) {
        const key = bucketKeyForUrl(url);
        if (key) keys.add(key);
      }
    }

    if (payload.products.length === 0) {
      // Only the temporary product exists live and it is excluded, so the
      // offline backup is intentionally empty until a real product is added.
      eq(keys.size, 0, 'an empty backup references no images');
      eq(listMirrorKeys().length, 0, 'an empty backup ships no orphan images');
    } else {
      ok(keys.size > 0, 'snapshot references at least one Supabase image');
      let total = 0;
      let missing = 0;
      let tooBig = 0;
      for (const key of keys) {
        const target = localMirrorPath(key);
        if (!target || !existsSync(target) || statSync(target).size === 0) {
          missing += 1;
          console.log(`       missing mirror: ${key}`);
        } else {
          const size = statSync(target).size;
          if (size > MIRROR_MAX_FILE_BYTES) tooBig += 1;
          total += size;
        }
      }
      eq(missing, 0, 'every snapshot image has a local mirror file');
      eq(tooBig, 0, 'every mirror file is inside the per-image limit');
      ok(total <= 200 * 1024 * 1024, 'mirror stays inside the 200MB budget');
      ok(total > 0, 'mirror files are not empty');
    }

    eq(selectOrphanKeys(keys, listMirrorKeys()), [], 'the mirror contains only referenced images');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
