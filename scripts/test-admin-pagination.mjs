/**
 * Optional server-side paging for the admin product/order lists.
 *
 *   node scripts/test-admin-pagination.mjs
 *
 * The dashboard, 10s poll, analytics, unread badge and CSV export still need
 * complete snapshots, so BOTH endpoints must keep their legacy "no params →
 * every row" response. When `page`/`pageSize` are supplied, the response must
 * contain exactly one bounded page plus a total count and pager metadata.
 *
 * Drives the REAL handlers against a fake Supabase client that records
 * range()/head-count calls. Nothing here touches Supabase or production.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Module from 'node:module';

const require = createRequire(import.meta.url);

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

// ─── Fake database ───────────────────────────────────────────────────────────
const state = {
  users: [
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', session_version: 0 },
  ],
  products: Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    name: `Product ${i + 1}`,
    price: 100 + i,
    salePrice: null,
    stock: 3,
    variantStock: {},
    tags: '',
    active: true,
    images: [],
    colors: [],
    sizes: [],
  })),
  orders: Array.from({ length: 5 }, (_, i) => ({
    id: `ZSH-TEST-${String(i + 1).padStart(4, '0')}`,
    customer: `Customer ${i + 1}`,
    phone: '01000000000',
    items: '[]',
    timestamps: '{}',
    // Two orders share a date on purpose: page boundaries must still be stable.
    date: `2026-01-0${i === 3 ? 3 : i + 1}`,
    total: 100 + i,
    status: 'Pending',
  })),
  rangeCalls: { products: 0, orders: 0 },
  countCalls: { products: 0, orders: 0 },
  failCount: { products: false, orders: false },
};

function makeQuery(table) {
  const q = {
    _filters: [],
    _orders: [],
    _range: null,
    _head: false,
    select(_columns, options) {
      if (options && options.count) q._countRequested = true;
      if (options && options.head) q._head = true;
      return q;
    },
    eq(col, val) { q._filters.push([col, val]); return q; },
    order(col, options) {
      q._orders.push({ col, ascending: !(options && options.ascending === false) });
      return q;
    },
    range(from, to) {
      q._range = [from, to];
      state.rangeCalls[table] = (state.rangeCalls[table] || 0) + 1;
      return q;
    },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(onOk, onErr) { return run().then(onOk, onErr); },
  };

  async function run() {
    let rows = (state[table] || []).map((row) => ({ ...row }));
    rows = rows.filter((row) => q._filters.every(([col, val]) => String(row[col]) === String(val)));
    if (q._orders.length) {
      rows.sort((a, b) => {
        for (const { col, ascending } of q._orders) {
          const av = a[col];
          const bv = b[col];
          const cmp = typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
          if (cmp !== 0) return ascending ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (q._countRequested && q._head) {
      state.countCalls[table] = (state.countCalls[table] || 0) + 1;
      if (state.failCount[table]) {
        return { data: [], count: null, error: new Error(`count secret for ${table}`) };
      }
      return { data: [], count: rows.length, error: null };
    }
    if (q._range) rows = rows.slice(q._range[0], q._range[1] + 1);
    return { data: rows, error: null };
  }

  return q;
}

const sb = { from(table) { return makeQuery(table); } };

process.env.SESSION_SECRET = 'test-session-secret-for-admin-pagination';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.PUBLIC_BASE_URL = 'https://za-shm.vercel.app';
delete process.env.ALLOWED_ORIGINS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => sb };
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
lib.supabaseAdmin();
const productsHandler = require('../api/admin/products.js');
const ordersHandler = require('../api/admin/orders.js');
Module._load = originalLoad;

const token = lib.signSession({
  id: state.users[0].id,
  role: state.users[0].role,
  name: state.users[0].name,
  email: state.users[0].email,
  session_version: state.users[0].session_version,
});

function makeReq(query = {}) {
  return {
    method: 'GET',
    headers: {
      origin: 'https://za-shm.vercel.app',
      'x-real-ip': '203.0.113.88',
      authorization: `Bearer ${token}`,
    },
    query,
    socket: { remoteAddress: '203.0.113.1' },
    on() { return this; },
    destroy() {},
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    end(text) { this.body = text ? JSON.parse(text) : null; this.done = true; },
  };
}

async function call(handler, query = {}) {
  const res = makeRes();
  await handler(makeReq(query), res);
  return res;
}

// ─── [1] bounded parsing helpers ─────────────────────────────────────────────
console.log('\n[1] pagination helpers');
{
  eq(lib.parseListPagination({}, 16), null, 'no params keeps the legacy full-list mode');
  eq(lib.parseListPagination({ page: '2', pageSize: '3' }, 16), { page: 2, pageSize: 3 },
    'valid string params are parsed to integers');
  eq(lib.parseListPagination({ page: '0', pageSize: '9999' }, 16), { page: 1, pageSize: 16 },
    'out-of-range params fall back to the endpoint default, never passed through');
  eq(lib.parseListPagination({ page: 'abc', pageSize: '-4' }, 16), { page: 1, pageSize: 16 },
    'non-numeric params fall back to the endpoint default');
  eq(lib.paginationMeta(2, 3, 7), {
    page: 2, pageSize: 3, total: 7, totalPages: 3, hasPrev: true, hasNext: true,
  }, 'pager metadata matches the UI paginate() shape');
  eq(lib.paginationMeta(9, 3, 7).page, 3, 'a page past the end is clamped to the last page');
  eq(lib.ADMIN_LIST_MAX_PAGE_SIZE, 200, 'page size ceiling is exported for tests/docs');
}

// ─── [2] product list paging ─────────────────────────────────────────────────
console.log('\n[2] product page response');
{
  state.rangeCalls.products = 0;
  state.countCalls.products = 0;
  const res = await call(productsHandler, { page: '2', pageSize: '3' });
  eq(res.statusCode, 200, 'paged product GET succeeds');
  eq(res.body.success, true, 'success flag is preserved');
  eq(res.body.count, 7, 'count is the exact table total, not the page length');
  eq(res.body.products.map((p) => p.id), [4, 3, 2], 'page 2 is the second newest-first slice');
  eq(res.body.pagination, {
    page: 2, pageSize: 3, total: 7, totalPages: 3, hasPrev: true, hasNext: true,
  }, 'products pager metadata is complete');
  eq(state.rangeCalls.products, 1, 'exactly one bounded range() is issued');
  eq(state.countCalls.products, 1, 'exactly one head count is issued');

  const last = await call(productsHandler, { page: 3, pageSize: 3 });
  eq(last.body.products.map((p) => p.id), [1], 'last page returns the remaining row');
  eq(last.body.pagination.hasNext, false, 'last page advertises no next page');
}

// ─── [3] product legacy path ─────────────────────────────────────────────────
console.log('\n[3] product legacy full-list response');
{
  state.rangeCalls.products = 0;
  state.countCalls.products = 0;
  const res = await call(productsHandler);
  eq(res.statusCode, 200, 'unpaged product GET still succeeds');
  eq(res.body.products.length, 7, 'every product is returned');
  eq(res.body.count, 7, 'legacy count is the row count');
  eq(res.body.pagination, undefined, 'no pagination field is added in legacy mode');
  eq(state.rangeCalls.products, 0, 'legacy mode never calls range()');
  eq(state.countCalls.products, 0, 'legacy mode never issues a separate count query');
}

// ─── [4] order list paging ───────────────────────────────────────────────────
console.log('\n[4] order page response');
{
  state.rangeCalls.orders = 0;
  state.countCalls.orders = 0;
  const res = await call(ordersHandler, { page: '2', pageSize: '2' });
  eq(res.statusCode, 200, 'paged order GET succeeds');
  eq(res.body.count, 5, 'order count is the exact table total');
  eq(res.body.orders.map((o) => o.id), ['ZSH-TEST-0003', 'ZSH-TEST-0002'],
    'page 2 is the second newest-first slice');
  eq(res.body.pagination, {
    page: 2, pageSize: 2, total: 5, totalPages: 3, hasPrev: true, hasNext: true,
  }, 'orders pager metadata is complete');
  eq(state.rangeCalls.orders, 1, 'exactly one bounded range() is issued for orders');
  eq(state.countCalls.orders, 1, 'exactly one head count is issued for orders');
  ok(typeof res.body.orders[0].tracking_url === 'string', 'tracking URL is still attached to paged rows');
}

// ─── [4b] stable boundaries when dates collide ───────────────────────────────
console.log('\n[4b] stable pages when dates collide');
{
  const expected = [...state.orders]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .map((o) => o.id);
  const seen = [];
  for (let p = 1; p <= expected.length; p += 1) {
    const page = await call(ordersHandler, { page: String(p), pageSize: '1' });
    seen.push(...page.body.orders.map((o) => o.id));
  }
  eq(seen, expected, 'paging one row at a time returns every order exactly once');
  eq(new Set(seen).size, seen.length, 'no duplicate order across page boundaries');
}

// ─── [5] order legacy path ───────────────────────────────────────────────────
console.log('\n[5] order legacy full-list response');
{
  state.rangeCalls.orders = 0;
  state.countCalls.orders = 0;
  const res = await call(ordersHandler);
  eq(res.statusCode, 200, 'unpaged order GET still succeeds');
  eq(res.body.orders.length, 5, 'every order is returned for analytics/notifications');
  eq(res.body.pagination, undefined, 'no pagination field is added in legacy mode');
  eq(res.body.count, undefined, 'legacy orders response shape is unchanged');
  eq(state.rangeCalls.orders, 0, 'legacy order mode never calls range()');
  eq(state.countCalls.orders, 0, 'legacy order mode never issues a separate count query');
}

// ─── [6] count failures stay generic ────────────────────────────────────────
console.log('\n[6] count failure contract');
{
  state.failCount.products = true;
  const products = await call(productsHandler, { page: 1, pageSize: 2 });
  eq(products.statusCode, 500, 'a product count failure returns 500');
  eq(products.body.error, 'Could not load products', 'product count failure uses the safe message');
  ok(!/secret/.test(JSON.stringify(products.body)), 'raw count error is not echoed');
  state.failCount.products = false;

  state.failCount.orders = true;
  const orders = await call(ordersHandler, { page: 1, pageSize: 2 });
  eq(orders.statusCode, 500, 'an order count failure returns 500');
  eq(orders.body.error, 'Could not load orders', 'order count failure uses the safe message');
  ok(!/secret/.test(JSON.stringify(orders.body)), 'raw count error is not echoed');
  state.failCount.orders = false;
}

// ─── [7] static route guards ─────────────────────────────────────────────────
console.log('\n[7] static guards');
{
  const productsSrc = readFileSync(new URL('../api/admin/products.js', import.meta.url), 'utf8');
  const ordersSrc = readFileSync(new URL('../api/admin/orders.js', import.meta.url), 'utf8');
  ok(/parseListPagination\(req\.query, 16\)/.test(productsSrc), 'products uses bounded 16-row paging');
  ok(/parseListPagination\(req\.query, 15\)/.test(ordersSrc), 'orders uses bounded 15-row paging');
  ok(/\.range\(offset, offset \+ pageSize - 1\)/.test(productsSrc), 'products ranges by computed offset');
  ok(/\.range\(offset, offset \+ pageSize - 1\)/.test(ordersSrc), 'orders ranges by computed offset');
  ok(/\.order\('date', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: false \}\)/.test(ordersSrc),
    'orders uses a unique id tie-breaker for stable pages');
  ok(/requirePerm\(req,\s*res,\s*'products\.read'\)/.test(productsSrc), 'products keeps its permission gate');
  ok(/requirePerm\(req,\s*res,\s*'orders\.read'\)/.test(ordersSrc), 'orders keeps its permission gate');
  ok(!/count:\s*req\.query/.test(productsSrc + ordersSrc), 'client cannot override the exact count mode');
}

console.log(`\nadmin-pagination: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
