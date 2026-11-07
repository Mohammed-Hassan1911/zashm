/**
 * Product reviews — public API contract + static wiring.
 *
 *   node scripts/test-reviews.mjs
 *
 * Drives the real api/reviews.js handler through a fake Supabase client and a
 * fake rate limiter, then asserts the source files that must stay in sync:
 * moderation API, permissions, storefront components, admin panel, migration.
 * The database-side trigger/view behaviour is covered against real PostgreSQL
 * in scripts/test-sql-concurrency.mjs.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

// ─── Fake Supabase ──────────────────────────────────────────────────────────
const state = {
  products: [
    { id: 7, active: true, rating: 4.5, reviews: 2 },
    { id: 8, active: false, rating: 0, reviews: 0 },
  ],
  reviews: [
    { id: 1, productId: 7, name: 'Mona', rating: 5, comment: 'Lovely fabric', status: 'approved', createdAt: '2026-11-01T10:00:00.000Z', publishedAt: '2026-11-01T12:00:00.000Z', ipHash: 'secret' },
    { id: 2, productId: 7, name: 'Omar', rating: 4, comment: 'Great fit', status: 'approved', createdAt: '2026-11-02T10:00:00.000Z', publishedAt: null, ipHash: 'secret' },
    { id: 3, productId: 7, name: 'Hidden', rating: 1, comment: 'pending row', status: 'pending', createdAt: '2026-11-03T10:00:00.000Z', publishedAt: null, ipHash: 'secret' },
  ],
  inserts: [],
};

function makeQuery(table) {
  let filters = [];
  let orderBy = null;
  let limitN = null;
  let mode = 'select';
  let insertRows = null;

  const rows = () => (table === 'products' ? state.products : state.reviews);

  function execute() {
    if (mode === 'insert') {
      for (const row of insertRows || []) {
        state.inserts.push({ ...row });
      }
      return Promise.resolve({ data: null, error: null });
    }

    let result = rows().filter((row) =>
      filters.every(([col, value]) => String(row[col]) === String(value))
    );
    if (orderBy) {
      const { col, ascending } = orderBy;
      result = result.slice().sort((a, b) => {
        const av = a[col] == null ? '' : String(a[col]);
        const bv = b[col] == null ? '' : String(b[col]);
        return ascending ? (av < bv ? -1 : av > bv ? 1 : 0) : (av > bv ? -1 : av < bv ? 1 : 0);
      });
    }
    if (limitN !== null) result = result.slice(0, limitN);

    if (mode === 'single') {
      return Promise.resolve({ data: result[0] || null, error: null });
    }
    return Promise.resolve({ data: JSON.parse(JSON.stringify(result)), error: null });
  }

  const query = {
    select() { return query; },
    eq(col, value) { filters.push([col, value]); return query; },
    order(col, options) { orderBy = { col, ascending: !options || options.ascending !== false }; return query; },
    limit(n) { limitN = n; return query; },
    maybeSingle() { mode = 'single'; return execute(); },
    insert(rowsToInsert) { mode = 'insert'; insertRows = rowsToInsert; return execute(); },
    then(resolve, reject) { return execute().then(resolve, reject); },
  };
  return query;
}

const fakeSupabase = {
  from: (table) => makeQuery(table),
};

// ─── Patch the shared helpers BEFORE the handler is loaded ──────────────────
const lib = require('../api/_lib.js');
let currentBody = null;
let limiterAllowed = true;
lib.supabaseAdmin = () => fakeSupabase;
lib.readBody = async () => currentBody;
lib.clientIp = () => '203.0.113.9';
lib.rateLimitShared = async () => ({
  allowed: limiterAllowed,
  resetIn: limiterAllowed ? 0 : 42,
});

const handlerModule = require('../api/reviews.js');
const handler = handlerModule;
const { _test } = handlerModule;

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    getHeader(key) { return this.headers[String(key).toLowerCase()]; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); },
  };
}

async function call(method, { query = {}, body = null } = {}) {
  currentBody = body;
  const req = { method, query, headers: {}, body };
  const res = makeRes();
  await handler(req, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

function reset() {
  state.inserts = [];
  limiterAllowed = true;
  currentBody = null;
}

// ─── [1] Text sanitisation ──────────────────────────────────────────────────
console.log('\n[1] sanitisation');
{
  const { cleanReviewText } = _test;
  eq(cleanReviewText('  hello   <b>world</b>  ', 100), 'hello bworld/b', 'angle brackets are removed and whitespace collapsed');
  eq(cleanReviewText('line\nbreak\ttab', 100), 'line break tab', 'control characters become spaces');
  eq(cleanReviewText('x'.repeat(700), 600).length, 600, 'comments are truncated to the cap');
  eq(cleanReviewText(null, 10), '', 'non-strings are rejected');
  eq(cleanReviewText('  ', 10), '', 'blank text is empty');
}

// ─── [2] Payload validation ─────────────────────────────────────────────────
console.log('\n[2] payload validation');
{
  const { readReviewPayload } = _test;
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: 'Nice' }).ok, true, 'a valid payload passes');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: 'Nice' }).value.rating, 5, 'rating is numeric');
  eq(readReviewPayload({ productId: 'x', name: 'Mona', rating: 5, comment: 'Nice' }).ok, false, 'invalid product id fails');
  eq(readReviewPayload({ productId: 7, name: 'M', rating: 5, comment: 'Nice' }).ok, false, 'one-letter name fails');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 0, comment: 'Nice' }).ok, false, 'rating below 1 fails');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 6, comment: 'Nice' }).ok, false, 'rating above 5 fails');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 4.5, comment: 'Nice' }).ok, false, 'fractional ratings fail');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: '' }).ok, false, 'empty comment fails');
  const honeypot = readReviewPayload({ website: 'http://spam.example', productId: 7, name: 'Mona', rating: 5, comment: 'Nice' });
  eq(honeypot.honeypot, true, 'a filled honeypot is flagged');
  eq(honeypot.ok, true, 'a honeypot is answered like a success');
}

// ─── [3] IP hashing ─────────────────────────────────────────────────────────
console.log('\n[3] ip hash');
{
  const { hashIp } = _test;
  const a = hashIp('203.0.113.9');
  eq(a, hashIp('203.0.113.9'), 'the hash is deterministic');
  ok(!a.includes('203.0.113.9'), 'the raw IP is never stored');
  eq(a.length, 32, 'the hash is truncated');
}

// ─── [4] GET contract ───────────────────────────────────────────────────────
console.log('\n[4] GET /api/reviews');
{
  reset();
  const missing = await call('GET', { query: {} });
  eq(missing.status, 400, 'a missing productId is rejected');

  const inactive = await call('GET', { query: { productId: 8 } });
  eq(inactive.status, 404, 'an inactive product is not found');

  const list = await call('GET', { query: { productId: 7 } });
  eq(list.status, 200, 'approved reviews are returned');
  eq(list.body.reviews.length, 2, 'pending reviews are never returned');
  eq(list.body.reviews.every((r) => r.comment !== 'pending row'), true, 'the pending row is filtered out');
  eq(list.body.reviews[0].comment, 'Great fit', 'the newest approved review is first');
  eq(list.body.summary, { average: 4.5, count: 2 }, 'the summary comes from the aggregate columns');
  ok(!('ipHash' in list.body.reviews[0]), 'the submitter hash is never exposed');
  eq(list.headers['cache-control'].includes('s-maxage'), true, 'the list is cacheable for a short window');
}

// ─── [5] POST contract ──────────────────────────────────────────────────────
console.log('\n[5] POST /api/reviews');
{
  reset();
  const honeypot = await call('POST', { body: { website: 'spam', productId: 7, name: 'Bot', rating: 5, comment: 'buy now' } });
  eq(honeypot.status, 201, 'a honeypot submission gets a success-shaped answer');
  eq(state.inserts.length, 0, 'nothing is written for a honeypot');

  const badRating = await call('POST', { body: { productId: 7, name: 'Mona', rating: 9, comment: 'Nice' } });
  eq(badRating.status, 400, 'an out-of-range rating is rejected before the database');
  eq(state.inserts.length, 0, 'the rejected rating writes nothing');

  const missingProduct = await call('POST', { body: { productId: 999, name: 'Mona', rating: 5, comment: 'Nice' } });
  eq(missingProduct.status, 404, 'a review for a missing product is refused');
  eq(state.inserts.length, 0, 'nothing is written for a missing product');

  const inactiveProduct = await call('POST', { body: { productId: 8, name: 'Mona', rating: 5, comment: 'Nice' } });
  eq(inactiveProduct.status, 404, 'a review for an inactive product is refused');

  const good = await call('POST', { body: { productId: 7, name: '  Mona  ', rating: 4, comment: '  Great <fit>  ' } });
  eq(good.status, 201, 'a valid review is accepted');
  eq(good.body.pending, true, 'the response says the review is pending');
  eq(state.inserts.length, 1, 'exactly one row is written');
  eq(state.inserts[0].status, 'pending', 'new reviews always start pending');
  eq(state.inserts[0].rating, 4, 'the rating is stored');
  eq(state.inserts[0].name, 'Mona', 'the name is trimmed');
  eq(state.inserts[0].comment, 'Great fit', 'the comment is sanitised');
  ok(state.inserts[0].ipHash && state.inserts[0].ipHash !== '203.0.113.9', 'the IP is stored only as a salted hash');
  ok(!('publishedAt' in state.inserts[0]), 'a pending review has no publish date');
}

// ─── [6] Rate limit + method guard ─────────────────────────────────────────
console.log('\n[6] abuse + method guards');
{
  reset();
  limiterAllowed = false;
  const limited = await call('POST', { body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice' } });
  eq(limited.status, 429, 'the submission endpoint is rate limited');
  eq(state.inserts.length, 0, 'a limited submission writes nothing');
  limiterAllowed = true;

  const wrong = await call('PUT', {});
  eq(wrong.status, 405, 'unsupported methods are refused');
  ok(wrong.headers.allow.includes('POST'), 'the allowed methods are advertised');
}

// ─── [7] Static wiring ─────────────────────────────────────────────────────
console.log('\n[7] static wiring');
{
  const read = (path) => readFileSync(`${ROOT}${path}`, 'utf8');
  const publicApi = read('api/reviews.js');
  const adminApi = read('api/admin/reviews.js');
  const serverLib = read('api/_lib.js');
  const clientSecurity = read('src/lib/security.js');
  const authLib = read('src/lib/auth.js');
  const card = read('src/components/shop/ProductCard.js');
  const page = read('src/pages/ProductPage.js');
  const reviewsUi = read('src/components/shop/ProductReviews.js');
  const adminUi = read('src/pages/AdminApp.js');
  const sql = read('supabase/product_reviews.sql');

  ok(publicApi.includes("status: 'pending'"), 'public submissions are forced to pending');
  ok(publicApi.includes('website'), 'the honeypot field is read server-side');
  ok(publicApi.includes('rateLimitShared'), 'public submissions are rate limited');

  ok(adminApi.includes("requirePerm(req, res, 'reviews.read')"), 'listing requires reviews.read');
  ok(adminApi.includes("requirePerm(req, res, 'reviews.write')"), 'moderation requires reviews.write');
  ok(adminApi.includes("'pending', 'approved', 'rejected'"), 'the moderation statuses are allow-listed');

  ok(serverLib.includes("'reviews.read', 'reviews.write'"), 'the server grants review permissions to managers');
  ok(clientSecurity.includes("'reviews.read', 'reviews.write'"), 'the client permissions mirror the server');
  ok(authLib.includes("reviews: 'reviews.read'"), 'the admin route has a page permission');

  ok(card.includes('StarRating'), 'product cards show stars');
  ok(page.includes('ProductReviews'), 'the product page renders the reviews section');
  ok(reviewsUi.includes("api.post('/reviews'"), 'the form submits to the public endpoint');
  ok(reviewsUi.includes('pending') || reviewsUi.includes('once approved'), 'the form explains moderation');
  ok(adminUi.includes("adminPage === 'reviews'"), 'the admin console has a reviews route');
  ok(adminUi.includes("id:'reviews'"), 'the admin sidebar links to reviews');

  ok(/CREATE TABLE IF NOT EXISTS public\.product_reviews/.test(sql), 'the migration creates the table');
  ok(/ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS is enabled');
  ok(/REVOKE ALL ON public\.product_reviews FROM PUBLIC, anon, authenticated/.test(sql), 'the browser roles are denied');
  ok(/zshm_product_review_sync/.test(sql), 'the aggregate trigger is installed');
  ok(/CREATE VIEW public\.products_public/.test(sql), 'the public view is refreshed');
  ok(/rating,\s*\n\s*reviews\s*\nFROM public\.products/.test(sql), 'the view exposes rating and reviews');
  const viewBlock = sql
    .split('CREATE VIEW public.products_public')[1]
    .split('REVOKE ALL ON public.products_public')[0];
  ok(!/reservedStock/i.test(viewBlock), 'the recreated view still hides reservedStock');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
