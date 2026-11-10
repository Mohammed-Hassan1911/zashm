/**
 * Backup script regression tests: paging past the 1000-row server cap, the
 * manifest, image download, and the "never leak the service key" rule.
 *
 *   node scripts/test-backup-data.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKUP_TABLES,
  MAX_PAGES,
  PAGE_SIZE,
  fetchAllRows,
  pageRange,
  parseArgs,
  parseContentRange,
  projectHost,
  runBackup,
  sha256,
  stampFolder,
} from './backup-data.mjs';

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

console.log('\n[1] helpers');
{
  eq(stampFolder(new Date('2026-11-10T09:15:00.123Z')), '2026-11-10T09-15-00Z', 'timestamp folder is sortable and safe');
  eq(pageRange(0), '0-999', 'first page asks for 1000 items');
  eq(pageRange(2, 50), '100-149', 'page ranges are inclusive and offset by size');
  eq(parseContentRange('0-999/2500'), { from: 0, to: 999, total: 2500 }, 'content-range total is parsed');
  eq(parseContentRange('1000-1999/*'), { from: 1000, to: 1999, total: null }, 'unknown total is allowed');
  eq(parseContentRange(''), null, 'missing header is safe');
  eq(projectHost('https://ptegprcbtfylqhbnbkih.supabase.co'), 'ptegprcbtfylqhbnbkih.supabase.co', 'only the host is reported');
  eq(projectHost('not a url'), '(invalid url)', 'bad url never throws');
  eq(BACKUP_TABLES, ['products', 'orders', 'users', 'coupons', 'product_reviews'], 'every operational table is covered');
  eq(parseArgs(['--with-images', '--keep', '8']).keep, 8, '--keep parses a number');
  eq(parseArgs(['--keep']).keep, 0, 'a bare --keep is ignored');
  ok(parseArgs(['--dry-run']).dryRun, '--dry-run parses');
  eq(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 matches the reference vector');
}

console.log('\n[2] fetchAllRows pages past the server row cap');
{
  const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `row-${i}`, n: i }));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls += 1;
    const range = String(init.headers?.Range || '');
    const [from, to] = range.split('-').map(Number);
    const page = rows.slice(from, to + 1);
    return {
      ok: true,
      status: page.length ? 206 : 416,
      headers: { get: () => (page.length ? `${from}-${from + page.length - 1}/${rows.length}` : null) },
      json: async () => page,
      text: async () => '',
    };
  };
  try {
    const result = await fetchAllRows('https://example.test', 'orders', 'k');
    eq(result.rows.length, 2500, 'all 2500 rows are fetched across three pages');
    eq(result.total, 2500, 'the reported total is kept');
    eq(calls, 3, 'exactly three page requests are made');
  } finally {
    globalThis.fetch = realFetch;
  }

  // A table with exactly PAGE_SIZE rows must not loop forever.
  let exactCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    exactCalls += 1;
    const range = String(init.headers?.Range || '');
    const [from, to] = range.split('-').map(Number);
    const page = from === 0 ? rows.slice(0, PAGE_SIZE) : [];
    return {
      ok: true,
      status: page.length ? 206 : 416,
      headers: { get: () => (page.length ? `${from}-${to}/${PAGE_SIZE}` : null) },
      json: async () => page,
      text: async () => '',
    };
  };
  try {
    const result = await fetchAllRows('https://example.test', 'products', 'k');
    eq(result.rows.length, PAGE_SIZE, 'an exact multiple of the page size terminates');
    eq(exactCalls, 2, 'one extra empty page ends the loop');
  } finally {
    globalThis.fetch = realFetch;
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 206,
    headers: { get: () => '0-1/9999' },
    json: async () => rows.slice(0, 2),
    text: async () => '',
  });
  let mismatch = '';
  try {
    await fetchAllRows('https://example.test', 'orders', 'k');
  } catch (err) {
    mismatch = (err && err.message) || '';
  } finally {
    globalThis.fetch = realFetch;
  }
  ok(/fetched 2 rows but the server reported 9999/.test(mismatch), 'a short read fails instead of writing a partial backup');
}

console.log('\n[3] runBackup writes verified JSON and a manifest');
{
  const out = mkdtempSync(join(tmpdir(), 'zashm-backup-'));
  const rowsByTable = {
    products: [{ id: 'p1', name: 'Jacket' }],
    orders: Array.from({ length: 1200 }, (_, i) => ({ id: `ZSH-${i}`, total: 1000 + i })),
    users: [{ email: 'admin@example.com', role: 'admin' }],
    coupons: [{ code: 'WELCOME10' }],
    product_reviews: [],
  };
  const objects = [{ id: 'o1', name: 'products/a.jpg', metadata: { size: 4, mimetype: 'image/jpeg' } }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/storage/v1/object/list/')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => objects, text: async () => '' };
    }
    if (path.includes('/storage/v1/object/products/')) {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
    }
    const table = /\/rest\/v1\/([a-z_]+)\?/.exec(path)[1];
    const all = rowsByTable[table];
    const [from, to] = String(init.headers?.Range || '').split('-').map(Number);
    const page = all.slice(from, to + 1);
    return {
      ok: true,
      status: page.length ? 206 : 416,
      headers: { get: () => (page.length ? `${from}-${from + page.length - 1}/${all.length}` : null) },
      json: async () => page,
      text: async () => '',
    };
  };

  const realEnv = { url: process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-must-not-leak';
  try {
    const manifest = await runBackup({ out, withImages: true, quiet: true, now: new Date('2026-11-10T10:00:00.000Z') });
    const dir = join(out, '2026-11-10T10-00-00Z');

    eq(manifest.tables.orders.rows, 1200, 'every order row is backed up');
    eq(manifest.tables.products.rows, 1, 'products are backed up');
    eq(manifest.tables.product_reviews.rows, 0, 'an empty table is still recorded');
    eq(manifest.storage.objects, 1, 'the storage manifest is recorded');
    eq(manifest.storage.downloadedBytes, 4, 'images are downloaded with --with-images');

    const orders = JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8'));
    eq(orders.length, 1200, 'the written file contains every row');
    ok(readFileSync(join(dir, 'manifest.json'), 'utf8').includes('example.supabase.co'), 'the manifest records the project host');
    ok(!readFileSync(join(dir, 'manifest.json'), 'utf8').includes('service-role-key-must-not-leak'), 'the manifest never contains the service key');
    ok(!readFileSync(join(dir, 'orders.json'), 'utf8').includes('service-role-key-must-not-leak'), 'table files never contain the service key');
    eq(readFileSync(join(dir, 'storage', 'products', 'a.jpg')).length, 4, 'the image is written under storage/<bucket>/');
  } finally {
    globalThis.fetch = realFetch;
    if (realEnv.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = realEnv.url;
    if (realEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnv.key;
    rmSync(out, { recursive: true, force: true });
  }
}

console.log('\n[4] a failed source fails the run');
{
  const out = mkdtempSync(join(tmpdir(), 'zashm-backup-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/orders')) {
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom', json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '0-0/1' },
      json: async () => [{ id: 'x' }],
      text: async () => '',
    };
  };
  const realEnv = { url: process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  let message = '';
  try {
    await runBackup({ out, quiet: true, now: new Date('2026-11-10T11:00:00.000Z') });
  } catch (err) {
    message = (err && err.message) || '';
  } finally {
    globalThis.fetch = realFetch;
    if (realEnv.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = realEnv.url;
    if (realEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnv.key;
    rmSync(out, { recursive: true, force: true });
  }
  ok(/incomplete/.test(message), 'an incomplete backup exits non-zero instead of pretending to succeed');
}

console.log('\n[5] missing credentials fail before touching the network');
{
  const realEnv = { url: process.env.VITE_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.REACT_APP_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let message = '';
  try {
    await runBackup({ dryRun: true });
  } catch (err) {
    message = (err && err.message) || '';
  } finally {
    if (realEnv.url !== undefined) process.env.VITE_SUPABASE_URL = realEnv.url;
    if (realEnv.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = realEnv.key;
  }
  ok(/missing/.test(message), 'the script stops with a clear message');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
