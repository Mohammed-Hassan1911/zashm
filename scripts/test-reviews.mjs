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
    { id: 1, productId: 7, name: 'Mona', rating: 5, comment: 'Lovely fabric', status: 'approved', createdAt: '2026-11-01T10:00:00.000Z', publishedAt: '2026-11-01T12:00:00.000Z', ipHash: 'secret', photoPath: 'reviews/7/0123456789abcdef01234567.jpg' },
    { id: 2, productId: 7, name: 'Omar', rating: 4, comment: 'Great fit', status: 'approved', createdAt: '2026-11-02T10:00:00.000Z', publishedAt: null, ipHash: 'secret' },
    { id: 3, productId: 7, name: 'Hidden', rating: 1, comment: 'pending row', status: 'pending', createdAt: '2026-11-03T10:00:00.000Z', publishedAt: null, ipHash: 'secret' },
  ],
  inserts: [],
  storage: new Map(),
  storageRemoved: [],
  storageFail: false,
  missingPhotoColumn: false,
  probeFail: false,
};

const MISSING_PHOTO_COLUMN = {
  message: 'column product_reviews.photoPath does not exist',
  code: '42703',
};

function makeQuery(table) {
  let filters = [];
  let orderBy = null;
  let limitN = null;
  let mode = 'select';
  let single = false;
  let insertRows = null;
  let updateRow = null;
  let columnError = null;

  const rows = () => (table === 'products' ? state.products : state.reviews);

  // Before the migration the column genuinely is not in the table, so a row
  // read from it must not carry `photoPath` at all.
  function project(row) {
    if (!row || !state.missingPhotoColumn) return row;
    const copy = { ...row };
    delete copy.photoPath;
    return copy;
  }

  function execute() {
    if (columnError) return Promise.resolve({ data: null, error: columnError });

    if (mode === 'insert') {
      for (const row of insertRows || []) {
        state.inserts.push({ ...row });
      }
      return Promise.resolve({ data: null, error: null });
    }

    if (mode === 'update') {
      const updated = [];
      state.reviews = state.reviews.map((row) => {
        const hit = filters.every(([col, value]) => String(row[col]) === String(value));
        if (!hit) return row;
        const next = { ...row, ...updateRow };
        updated.push(next);
        return next;
      });
      return Promise.resolve({ data: single ? (updated[0] || null) : updated, error: null });
    }

    if (mode === 'delete') {
      const removed = [];
      state.reviews = state.reviews.filter((row) => {
        const hit = filters.every(([col, value]) => String(row[col]) === String(value));
        if (hit) removed.push({ ...row });
        return !hit;
      });
      return Promise.resolve({ data: single ? (removed[0] || null) : removed, error: null });
    }

    let result = rows().filter((row) =>
      filters.every(([col, value]) => (
        Array.isArray(value)
          ? value.map(String).includes(String(row[col]))
          : String(row[col]) === String(value)
      ))
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

    if (single) {
      return Promise.resolve({ data: project(result[0]) || null, error: null });
    }
    return Promise.resolve({
      data: JSON.parse(JSON.stringify(result)).map(project),
      error: null,
    });
  }

  const query = {
    select(cols) {
      if (typeof cols === 'string' && cols.includes('photoPath')) {
        if (state.probeFail && cols.trim() === '"photoPath"') {
          // Only the one-column support probe fails, the way a timeout would.
          columnError = { message: 'upstream request timed out', code: 'ETIMEDOUT' };
        } else if (state.missingPhotoColumn) {
          columnError = MISSING_PHOTO_COLUMN;
        }
      }
      return query;
    },
    eq(col, value) { filters.push([col, value]); return query; },
    in(col, values) { filters.push([col, values]); return query; },
    order(col, options) { orderBy = { col, ascending: !options || options.ascending !== false }; return query; },
    limit(n) { limitN = n; return query; },
    delete() { mode = 'delete'; return query; },
    update(patch) { mode = 'update'; updateRow = patch; return query; },
    maybeSingle() { single = true; return execute(); },
    insert(rowsToInsert) { mode = 'insert'; insertRows = rowsToInsert; return execute(); },
    then(resolve, reject) { return execute().then(resolve, reject); },
  };
  return query;
}

const fakeStorage = {
  from: (bucket) => ({
    upload: async (objectPath, buffer, options) => {
      if (state.storageFail) return { error: { message: 'upload exploded' } };
      state.storage.set(objectPath, {
        bucket,
        size: buffer.length,
        contentType: options && options.contentType,
      });
      return { error: null };
    },
    remove: async (paths) => {
      for (const objectPath of paths) {
        state.storage.delete(objectPath);
        state.storageRemoved.push(objectPath);
      }
      return { error: null };
    },
    getPublicUrl: (objectPath) => ({
      data: { publicUrl: `https://zashm-test.supabase.co/storage/v1/object/public/products/${objectPath}` },
    }),
  }),
};

const fakeSupabase = {
  from: (table) => makeQuery(table),
  storage: fakeStorage,
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
lib.requirePerm = async () => ({ id: 1, role: 'admin', permissions: ['reviews.read', 'reviews.write'] });
const { resetReviewPhotoSupportCache } = lib;

const handlerModule = require('../api/reviews.js');
const handler = handlerModule;
const { _test } = handlerModule;
// Loaded after the helpers are patched so it captures the fake Supabase client
// and the allow-all permission check.
const adminHandler = require('../api/admin/reviews.js');

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
  return invoke(handler, method, { query, body });
}

async function callAdmin(method, { query = {}, body = null } = {}) {
  return invoke(adminHandler, method, { query, body });
}

async function invoke(fn, method, { query, body }) {
  currentBody = body;
  const req = { method, query, headers: {}, body };
  const res = makeRes();
  await fn(req, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

function reset() {
  state.inserts = [];
  state.storage = new Map();
  state.storageRemoved = [];
  state.storageFail = false;
  state.missingPhotoColumn = false;
  state.probeFail = false;
  limiterAllowed = true;
  currentBody = null;
  resetReviewPhotoSupportCache();
}

// A tiny but valid JPEG: SOI + APP0 marker is all detectImageType needs.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegDataUrl = (extraBytes = 0) => (
  `data:image/jpeg;base64,${Buffer.concat([JPEG_BYTES, Buffer.alloc(extraBytes)]).toString('base64')}`
);

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

  const { normalizeEgyptPhone } = _test;
  eq(normalizeEgyptPhone('01012345678'), '01012345678', 'a local mobile passes');
  eq(normalizeEgyptPhone('011 2345 6789'), '01123456789', 'spaces are ignored');
  eq(normalizeEgyptPhone('+201012345678'), '01012345678', '+20 is normalised to local');
  eq(normalizeEgyptPhone('00201012345678'), '01012345678', '0020 is normalised to local');
  eq(normalizeEgyptPhone('010123456789'), undefined, 'an extra digit is rejected');
  eq(normalizeEgyptPhone('02012345678'), undefined, 'a wrong prefix is rejected');
  eq(normalizeEgyptPhone('0101234567'), undefined, 'a short number is rejected');
  eq(normalizeEgyptPhone(''), null, 'an empty phone is allowed');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: 'Nice', phone: '01012345678' }).value.phone, '01012345678', 'a valid phone is accepted and normalised');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: 'Nice', phone: '010123456789' }).ok, false, 'an invalid phone rejects the payload');
  eq(readReviewPayload({ productId: 7, name: 'Mona', rating: 5, comment: 'Nice' }).value.phone, null, 'phone is optional');

  const { readReviewPhoto } = _test;
  const base = { productId: 7, name: 'Mona', rating: 5, comment: 'Nice' };
  eq(readReviewPayload(base).value.photo, null, 'a photo is optional');
  eq(readReviewPhoto(''), { photo: null }, 'an empty photo is treated as none');
  eq(readReviewPayload({ ...base, photo: jpegDataUrl() }).value.photo.contentType, 'image/jpeg',
    'a JPEG data URL is accepted');
  eq(readReviewPayload({ ...base, photo: `data:image/png;base64,${PNG_BYTES.toString('base64')}` }).value.photo.contentType,
    'image/png', 'a PNG data URL is accepted');
  eq(readReviewPayload({ ...base, photo: 'https://example.com/photo.jpg' }).ok, false,
    'a remote URL is not accepted as an upload');
  eq(readReviewPayload({ ...base, photo: `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}` }).ok, false,
    'GIF is refused even though the bucket allows it for products');
  eq(readReviewPayload({ ...base, photo: `data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}` }).ok,
    false, 'the magic bytes decide, not the declared MIME type');
  eq(readReviewPayload({ ...base, photo: jpegDataUrl(lib.REVIEW_PHOTO_MAX_BYTES) }).ok, false,
    'a photo above the decoded cap is refused before storage');
  ok(!JSON.stringify(readReviewPayload({ ...base, photo: jpegDataUrl(32) })).includes('data:image'),
    'the payload carries the decoded photo, never the raw data URL string');
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
  ok(list.body.reviews.every((r) => !('phone' in r)), 'the submitter phone is never exposed publicly');
  eq(list.headers['cache-control'].includes('s-maxage'), true, 'the list is cacheable for a short window');

  const withPhoto = list.body.reviews.find((r) => r.id === 1);
  eq(withPhoto.photoUrl,
    'https://zashm-test.supabase.co/storage/v1/object/public/products/reviews/7/0123456789abcdef01234567.jpg',
    'an approved review exposes its photo URL');
  ok(!('photoPath' in withPhoto), 'the stored object path stays server-side');
  eq(list.body.photosEnabled, true, 'the form is told that photos can be stored');
  const withoutPhoto = list.body.reviews.find((r) => r.id === 2);
  ok(!('photoUrl' in withoutPhoto), 'a review without a photo has no photo key at all');

  // Before the migration is applied the endpoint must still work, just without
  // any photo support.
  state.missingPhotoColumn = true;
  resetReviewPhotoSupportCache();
  const legacy = await call('GET', { query: { productId: 7 } });
  eq(legacy.status, 200, 'reviews still load when the photo column is missing');
  eq(legacy.body.photosEnabled, false, 'the form hides the picker until the column exists');
  ok(legacy.body.reviews.every((r) => !('photoUrl' in r)), 'no photo URL is produced without the column');
  state.missingPhotoColumn = false;
  resetReviewPhotoSupportCache();

  // A transient probe failure (timeout, network) must never be remembered: the
  // next request sees photos as soon as the database answers again.
  state.probeFail = true;
  resetReviewPhotoSupportCache();
  const probeDown = await call('GET', { query: { productId: 7 } });
  eq(probeDown.status, 200, 'reviews still load when the column probe fails');
  eq(probeDown.body.photosEnabled, false, 'a failed probe answers this request without photos');
  state.probeFail = false;
  const probeBack = await call('GET', { query: { productId: 7 } });
  eq(probeBack.body.photosEnabled, true, 'a transient probe failure is not cached');

  // A cached "no" expires, so an instance that started before the migration
  // offers the picker shortly after the column appears — no cold start needed.
  state.missingPhotoColumn = true;
  resetReviewPhotoSupportCache();
  const beforeMigration = await call('GET', { query: { productId: 7 } });
  eq(beforeMigration.body.photosEnabled, false, 'a missing column hides the picker');
  state.missingPhotoColumn = false;
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 1000;
  try {
    const afterMigration = await call('GET', { query: { productId: 7 } });
    eq(afterMigration.body.photosEnabled, true, 'a cached "no" is re-probed after its TTL');
  } finally {
    Date.now = realNow;
  }
  resetReviewPhotoSupportCache();
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

  const withPhone = await call('POST', { body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice', phone: '+201012345678' } });
  eq(withPhone.status, 201, 'a review with a valid phone is accepted');
  eq(state.inserts[1].phone, '01012345678', 'the phone is stored in local form');

  const badPhone = await call('POST', { body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice', phone: '010123456789' } });
  eq(badPhone.status, 400, 'an invalid phone is rejected before the database');
  eq(state.inserts.length, 2, 'the invalid phone writes nothing');

  const withPhoto = await call('POST', {
    body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice', photo: jpegDataUrl(2048) },
  });
  eq(withPhoto.status, 201, 'a review with a photo is accepted');
  eq(withPhoto.body.photoSaved, true, 'the response says the photo was stored');
  const photoRow = state.inserts[state.inserts.length - 1];
  ok(/^reviews\/7\/[a-f0-9]{24}\.jpg$/.test(photoRow.photoPath),
    'the row stores only a short path under reviews/<productId>/');
  ok(!JSON.stringify(photoRow).includes('base64'), 'no image bytes are written to the database');
  eq(state.storage.get(photoRow.photoPath).contentType, 'image/jpeg', 'the file is stored with its real type');
  eq(state.storage.get(photoRow.photoPath).bucket, 'products', 'the existing bucket is reused');

  const before = state.storage.size;
  state.storageFail = true;
  const failedUpload = await call('POST', {
    body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice', photo: jpegDataUrl(2048) },
  });
  eq(failedUpload.status, 201, 'a failed photo upload never loses the review');
  eq(failedUpload.body.photoSaved, false, 'the response is honest about the lost photo');
  eq(state.inserts[state.inserts.length - 1].photoPath, undefined, 'no path is stored for a failed upload');
  eq(state.storage.size, before, 'nothing is left in storage');
  state.storageFail = false;

  state.missingPhotoColumn = true;
  resetReviewPhotoSupportCache();
  const noColumn = await call('POST', {
    body: { productId: 7, name: 'Mona', rating: 5, comment: 'Nice', photo: jpegDataUrl(2048) },
  });
  eq(noColumn.status, 201, 'a submission still succeeds before the migration');
  eq(noColumn.body.photoSaved, false, 'the photo is reported as not stored');
  eq(state.inserts[state.inserts.length - 1].photoPath, undefined, 'the missing column is never referenced');
  eq(state.storage.size, before, 'no orphan file is uploaded either');
  state.missingPhotoColumn = false;
  resetReviewPhotoSupportCache();
}

// ─── [6] Admin moderation + photos ─────────────────────────────────────────
console.log('\n[6] admin moderation + photos');
{
  reset();
  const photoPath = 'reviews/7/0123456789abcdef01234567.jpg';
  state.storage.set(photoPath, { bucket: 'products', size: 128, contentType: 'image/jpeg' });

  const list = await callAdmin('GET', { query: { status: 'all' } });
  eq(list.status, 200, 'the moderation list loads');
  const withPhoto = list.body.reviews.find((r) => r.id === 1);
  eq(withPhoto.photoUrl,
    `https://zashm-test.supabase.co/storage/v1/object/public/products/${photoPath}`,
    'the moderator sees the customer photo');
  ok(!('photoPath' in withPhoto), 'the admin response never leaks the raw object path');
  eq(list.body.reviews.find((r) => r.id === 2).photoUrl, null,
    'a review without a photo reports null');

  const hide = await callAdmin('PATCH', { body: { id: 1, status: 'rejected' } });
  eq(hide.status, 200, 'a review can be hidden');
  ok(state.storage.has(photoPath), 'hiding a review keeps its photo for a later re-approval');

  const del = await callAdmin('DELETE', { body: { id: 1 } });
  eq(del.status, 200, 'a review can be deleted');
  ok(!state.storage.has(photoPath), 'deleting a review removes its stored photo');
  ok(state.storageRemoved.includes(photoPath), 'the removal goes through the storage API');
  ok(!state.reviews.some((r) => r.id === 1), 'the row is gone from the table');

  const delPlain = await callAdmin('DELETE', { body: { id: 2 } });
  eq(delPlain.status, 200, 'a review without a photo deletes cleanly');
  eq(state.storageRemoved.length, 1, 'no storage call is made when there is no photo');
}

// ─── [7] Rate limit + method guard ─────────────────────────────────────────
console.log('\n[7] abuse + method guards');
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

// ─── [8] Static wiring ─────────────────────────────────────────────────────
console.log('\n[8] static wiring');
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
  const photoSql = read('supabase/product_review_photos.sql');
  const imagePrep = read('src/lib/imagePrep.js');
  const adminUploader = read('src/components/admin/ImageUploader.js');

  ok(publicApi.includes("status: 'pending'"), 'public submissions are forced to pending');
  ok(publicApi.includes('website'), 'the honeypot field is read server-side');
  ok(publicApi.includes('rateLimitShared'), 'public submissions are rate limited');

  ok(adminApi.includes("requirePerm(req, res, 'reviews.read')"), 'listing requires reviews.read');
  ok(typeof require('../api/admin/reviews.js') === 'function', 'the moderation handler parses and loads');
  ok(adminApi.includes("requirePerm(req, res, 'reviews.write')"), 'moderation requires reviews.write');
  ok(adminApi.includes("'pending', 'approved', 'rejected'"), 'the moderation statuses are allow-listed');

  ok(serverLib.includes("'reviews.read', 'reviews.write'"), 'the server grants review permissions to managers');
  ok(clientSecurity.includes("'reviews.read', 'reviews.write'"), 'the client permissions mirror the server');
  ok(authLib.includes("reviews: 'reviews.read'"), 'the admin route has a page permission');

  ok(card.includes('StarRating'), 'product cards show stars');
  ok(page.includes('ProductReviews'), 'the product page renders the reviews section');
  ok(reviewsUi.includes("api.post('/reviews'"), 'the form submits to the public endpoint');
  ok(reviewsUi.includes('pending') || reviewsUi.includes('once approved'), 'the form explains moderation');

  const css = read('src/index.css');
  const reviewCss = css.slice(css.indexOf('.review-form input'));
  ok(reviewsUi.includes('className="review-form"'), 'the review form is scoped for mobile input sizing');
  ok(!/fontSize:\s*13/.test(reviewsUi.slice(reviewsUi.indexOf('const inputStyle'), reviewsUi.indexOf('function formatDate'))),
    'the field font size comes from CSS, not an inline override');
  ok(/@media \(max-width: 768px\)[\s\S]{0,120}font-size:\s*16px/.test(reviewCss.slice(0, 320)),
    'review fields use 16px on small screens (no iOS zoom on focus)');
  ok(adminUi.includes("adminPage === 'reviews'"), 'the admin console has a reviews route');
  ok(adminUi.includes("id:'reviews'"), 'the admin sidebar links to reviews');
  ok(/id:'reviews'[^\n]*badge:'reviews'/.test(adminUi), 'the reviews item carries a pending badge');
  ok(adminUi.includes('/admin/reviews?status=pending&limit=1'),
    'the badge number is the pending count read from the database');
  ok(adminUi.includes('onCountsChange={setPendingReviews}'),
    'moderating a review refreshes the badge immediately');

  ok(/CREATE TABLE IF NOT EXISTS public\.product_reviews/.test(sql), 'the migration creates the table');
  ok(/ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS is enabled');
  ok(/REVOKE ALL ON public\.product_reviews FROM PUBLIC, anon, authenticated/.test(sql), 'the browser roles are denied');
  ok(/zshm_product_review_sync/.test(sql), 'the aggregate trigger is installed');
  ok(/CREATE VIEW public\.products_public/.test(sql), 'the public view is refreshed');
  ok(/'rating',\s*'reviews'/.test(sql), 'the view allow-list exposes rating and reviews');
  ok(/'reservedStock' = ANY \(v_allow\)/.test(sql),
    'the recreated view fails closed if reservedStock enters the allow-list');

  // ── optional review photos ──
  ok(publicApi.includes('photoSaved'), 'the public API reports whether the photo was stored');
  ok(publicApi.includes('photosEnabled'), 'the public API tells the form when photos are supported');
  ok(publicApi.includes('uploadReviewPhoto'), 'the public API stores the photo in Supabase Storage');
  ok(!/insertRow\.photo\s*=/.test(publicApi), 'the image bytes are never put on the database row');
  ok(adminApi.includes('removeReviewPhoto'), 'deleting a review also removes its stored photo');
  ok(adminApi.includes('photoUrl'), 'the moderation list returns a usable photo URL');

  ok(serverLib.includes("const REVIEW_PHOTO_BUCKET = 'products'"),
    'review photos reuse the existing products bucket (no new bucket needed)');
  ok(serverLib.includes("const REVIEW_PHOTO_PREFIX = 'reviews'"),
    'review photos are namespaced under reviews/ so they are easy to clean up');
  ok(serverLib.includes('isMissingColumnError'),
    'the optional column is probed instead of assumed');

  ok(reviewsUi.includes('photosEnabled'), 'the form shows the picker only when storage is available');
  ok(reviewsUi.includes('accept="image/jpeg,image/png,image/webp"'),
    'the picker only offers the formats the server accepts');
  ok(reviewsUi.includes('photo: form.photo'), 'the chosen photo is sent with the review');
  ok(reviewsUi.includes('review.photoUrl'), 'approved reviews render their photo');
  ok(reviewsUi.includes('prepareImage'), 'the photo is compressed in the browser before upload');
  ok(reviewsUi.includes('photoSaved === false'),
    'a lost photo is reported without hiding the saved review');
  ok(adminUi.includes('review.photoUrl'), 'the moderator sees the attached photo');

  ok(imagePrep.includes('export async function prepareImage'),
    'the shared image pipeline exposes prepareImage');
  ok(adminUploader.includes("from '../../lib/imagePrep'"),
    'the admin uploader reuses the same pipeline instead of duplicating it');
  ok(!/function compressImage/.test(adminUploader),
    'the duplicated compression helpers were removed from the admin uploader');

  ok(/"photoPath" text/.test(photoSql), 'the photo migration adds the short path column');
  ok(/product_reviews_photo_path_len/.test(photoSql),
    'the migration constrains the stored path');
  ok(/ADD COLUMN IF NOT EXISTS "photoPath"/.test(sql),
    'the canonical schema file also carries the column');

  // ── photo field: same shape as every other field, with motion ──
  ok(reviewsUi.includes('review-photo-drop'),
    'the photo field is the full-width dropzone, not a small button');
  ok(reviewsUi.includes('onDrop={onPhotoDrop}') && reviewsUi.includes('onDragOver={onPhotoDragOver}'),
    'the dropzone accepts a dragged photo through the same pipeline');
  ok(/Upload the product exactly as it arrived/.test(reviewsUi),
    'the field explains what photo to send: the piece as it arrived');
  ok(reviewsUi.includes('aria-describedby="review-photo-lede review-photo-meta"'),
    'the dropzone is described by its helper copy for screen readers');
  ok(reviewsUi.includes('className={`review-input${'),
    'the text fields share the animated review-input treatment');
  ok(/\.review-photo-drop \{[\s\S]{0,400}min-height: 172px/.test(css),
    'the dropzone is tall enough to read as a field, not a link');
  ok(/\.review-field:focus-within > label[\s\S]{0,80}color: var\(--gold\)/.test(css),
    'field labels turn gold while the field has focus');
  const motionCss = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  ok(/\.review-photo-icon,[\s\S]{0,40}\.review-photo-preview \{\s*animation: none/.test(motionCss) &&
     /\.review-photo-drop\.is-busy::before \{\s*animation: none/.test(motionCss),
    'every new animation is disabled in the shared reduced-motion block');
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
