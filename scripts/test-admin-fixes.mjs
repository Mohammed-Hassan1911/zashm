/**
 * Focused regressions for the admin live-poll / PII / tracking / limiter fixes.
 *
 *   node scripts/test-admin-fixes.mjs
 *
 * Drives the REAL handlers against a fake service-role client and the REAL
 * store/analytics modules through a Vite SSR harness. Nothing here touches
 * Supabase, Vercel or production data.
 */
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import Module from 'node:module';
import { createServer } from 'vite';

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

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
const today = new Date().toISOString().slice(0, 10);
const createdAt = new Date().toISOString();

const state = {
  users: [
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', session_version: 0 },
    { id: 2, name: 'Manager', email: 'manager@example.com', role: 'manager', session_version: 0 },
    { id: 3, name: 'Support', email: 'support@example.com', role: 'support', session_version: 0 },
  ],
  orders: [],
  orderSelects: [],
  orderReads: 0,
  rpc: async () => { throw new Error('db rate limiter unavailable'); },
};

function project(row, columns) {
  if (columns === '*' || !columns) return { ...row };
  const out = {};
  for (const col of String(columns).split(',')) {
    const key = col.trim();
    if (key && Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  }
  return out;
}

function makeQuery(table) {
  const q = {
    _columns: null,
    _filters: [],
    _orders: [],
    _limit: null,
    _range: null,
    _head: false,
    select(columns, options) {
      q._columns = columns;
      if (options && options.head) q._head = true;
      if (options && options.count) q._count = true;
      return q;
    },
    eq(col, val) { q._filters.push([col, val]); return q; },
    order(col, options) { q._orders.push({ col, ascending: !(options && options.ascending === false) }); return q; },
    limit(n) { q._limit = n; return q; },
    range(from, to) { q._range = [from, to]; return q; },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(onOk, onErr) { return run().then(onOk, onErr); },
  };

  async function run() {
    if (table === 'users') {
      const rows = state.users.filter((row) =>
        q._filters.every(([col, val]) => String(row[col]) === String(val))
      ).map((row) => ({ ...row }));
      return { data: rows, error: null };
    }
    if (table === 'orders') {
      state.orderSelects.push(q._columns);
      state.orderReads += 1;
      let rows = state.orders.map((row) => project(row, q._columns));
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
      if (q._head && q._count) return { data: [], count: rows.length, error: null };
      if (q._range) rows = rows.slice(q._range[0], q._range[1] + 1);
      if (q._limit !== null) rows = rows.slice(0, q._limit);
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  }
  return q;
}

const sb = {
  from(table) { return makeQuery(table); },
  rpc(name, args) { return state.rpc(name, args); },
};

// ─── Boot the real shared library while stubbing both rate-limit providers ───
process.env.SESSION_SECRET = 'test-session-secret-for-admin-fixes';
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
const adminOrdersHandler = require('../api/admin/orders.js');
const ordersHandler = require('../api/orders.js');
Module._load = originalLoad;

function tokenFor(role) {
  const user = state.users.find((u) => u.role === role);
  return lib.signSession({
    id: user.id, role: user.role, name: user.name,
    email: user.email, session_version: user.session_version,
  });
}

let ipCounter = 1;
function makeReq({ method = 'GET', query = {}, role = 'admin', headers = {} } = {}) {
  return {
    method,
    query,
    headers: {
      origin: 'https://za-shm.vercel.app',
      'content-type': 'application/json',
      'x-real-ip': `203.0.113.${(ipCounter++ % 200) + 1}`,
      ...(role ? { authorization: `Bearer ${tokenFor(role)}` } : {}),
      ...headers,
    },
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
async function call(handler, opts = {}) {
  const req = makeReq(opts);
  const res = makeRes();
  await handler(req, res);
  return res;
}

// ─── [1] strict limiter fails closed when both shared providers are down ─────
console.log('\n[1] strict rate limiter');
{
  const strict = await lib.rateLimitSharedStrict('strict:both-down', 5, 60 * 1000);
  eq(strict, { allowed: false, degraded: true, remaining: 0, resetIn: 60 },
    'both providers down returns an explicit degraded denial');
  const lenient = await lib.rateLimitShared('lenient:both-down', 5, 60 * 1000);
  eq(lenient.allowed, true, 'read-only limiter keeps its per-instance fallback');
  eq('degraded' in lenient, false, 'lenient fallback is not marked degraded');

  const realFetch = globalThis.fetch;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = async () => { throw new Error('Upstash down'); };
  const redisAndDbDown = await lib.rateLimitSharedStrict('strict:redis-and-db-down', 5, 60 * 1000);
  eq(redisAndDbDown, { allowed: false, degraded: true, remaining: 0, resetIn: 60 },
    'Upstash outage plus DB outage fails closed too');
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  state.rpc = async () => ({ data: { allowed: true, count: 1, remaining: 4, resetIn: 60 }, error: null });
  const healthy = await lib.rateLimitSharedStrict('strict:db-up', 5, 60 * 1000);
  eq(healthy, { allowed: true, remaining: 4, resetIn: 60 },
    'a healthy shared provider still issues a normal decision');
  state.rpc = async () => { throw new Error('db rate limiter unavailable'); };
}

// ─── Fixture: full order rows (with one internal-only column) ────────────────
function fixtureOrder(n, status, date) {
  return {
    id: `ZSH-FIX-${String(n).padStart(4, '0')}`,
    customer: `Customer ${n}`,
    phone: `0100000000${n}`,
    phoneAlt: `0110000000${n}`,
    email: `customer${n}@example.com`,
    address: `${n} Example Street`,
    city: 'Cairo',
    notes: `note ${n}`,
    items: [{ productId: 1, name: 'Shirt', qty: 1, price: 100, unitPrice: 100, size: 'M', color: 'Black' }],
    timestamps: { created: createdAt },
    subtotal: 100,
    discount: 0,
    total: 100 + n,
    discountCode: 'SAVE10',
    status,
    date,
    tracking_url: `https://za-shm.vercel.app/?track=ZSH-FIX-${String(n).padStart(4, '0')}&tk=fresh`,
    internalSecret: 'should-never-be-selected',
  };
}

state.orders = [
  fixtureOrder(1, 'Pending', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 6)).padStart(2, '0')}`),
  fixtureOrder(2, 'Confirmed', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 5)).padStart(2, '0')}`),
  fixtureOrder(3, 'Processing', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 4)).padStart(2, '0')}`),
  fixtureOrder(4, 'Shipped', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 3)).padStart(2, '0')}`),
  fixtureOrder(5, 'Delivered', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 2)).padStart(2, '0')}`),
  fixtureOrder(6, 'Cancelled', `2026-11-${String(Math.max(1, Number(today.slice(8)) - 1)).padStart(2, '0')}`),
  fixtureOrder(7, 'pending', today), // legacy lowercase status → Pending bucket
];

// ─── [2] compact summary shape + support masking ─────────────────────────────
console.log('\n[2] GET /api/admin/orders?summary=1');
{
  const anon = await call(adminOrdersHandler, { query: { summary: '1' }, role: null });
  eq(anon.statusCode, 401, 'summary requires a session');

  state.orderSelects = [];
  const res = await call(adminOrdersHandler, { query: { summary: '1' }, role: 'admin' });
  eq(res.statusCode, 200, 'admin summary succeeds');
  eq(Object.keys(res.body).sort(), ['summary'], 'the response has only the summary envelope');
  eq(Object.keys(res.body.summary).sort(), ['byStatus', 'newest', 'total'],
    'the summary has exactly total/byStatus/newest');
  eq(res.body.summary.total, 7, 'total counts every order');
  eq(res.body.summary.byStatus, {
    Pending: 2, Confirmed: 1, Processing: 1, Shipped: 1, Delivered: 1, Cancelled: 1,
  }, 'every status bucket is present and legacy casing is normalised');
  eq(res.body.summary.newest.length, 5, 'newest is bounded to five rows');
  eq(Object.keys(res.body.summary.newest[0]).sort(), ['customer', 'date', 'id', 'status', 'total'],
    'newest rows expose only id/status/total/date/customer');
  eq(res.body.summary.newest[0].id, 'ZSH-FIX-0007', 'newest is ordered by date descending');
  eq(res.body.summary.newest[0].customer, 'Customer 7', 'manager/admin see the customer');
  ok(state.orderSelects.every((cols) => cols !== '*'), 'summary never uses select("*")');
  ok(state.orderSelects.some((cols) => cols === 'status'), 'status counts read one explicit column');
  ok(state.orderSelects.some((cols) => cols === 'id, status, total, date, customer'),
    'newest rows read one explicit column list');

  const support = await call(adminOrdersHandler, { query: { summary: '1' }, role: 'support' });
  eq(support.statusCode, 200, 'support can read the live summary');
  eq(support.body.summary.total, 7, 'support gets the same totals');
  ok(support.body.summary.newest.every((row) => row.customer === ''),
    'support never receives customer names in the compact poll');

  // Same requirePerm + same adminorderread budget as the full list.
  const ip = '203.0.113.199';
  let allowed = 0;
  for (let i = 0; i < 120; i += 1) {
    const r = await call(adminOrdersHandler, {
      query: { summary: '1' }, role: 'admin', headers: { 'x-real-ip': ip },
    });
    if (r.statusCode === 200) allowed += 1;
  }
  eq(allowed, 120, 'summary shares the 120/min read budget');
  const blocked = await call(adminOrdersHandler, {
    query: { summary: '1' }, role: 'admin', headers: { 'x-real-ip': ip },
  });
  eq(blocked.statusCode, 429, 'the 121st summary poll is throttled');
  ok(Number(blocked.getHeader('Retry-After')) >= 1, '429 advertises Retry-After');
}

// ─── [3] full list: explicit columns + per-role PII ───────────────────────────
console.log('\n[3] GET /api/admin/orders full snapshot');
{
  const admin = await call(adminOrdersHandler, {});
  const manager = await call(adminOrdersHandler, { role: 'manager' });
  const support = await call(adminOrdersHandler, { role: 'support' });

  for (const [role, res] of [['admin', admin], ['manager', manager], ['support', support]]) {
    eq(res.statusCode, 200, `${role} full list succeeds`);
    eq(res.body.orders.length, 7, `${role} still receives the full snapshot`);
    const first = res.body.orders[0];
    eq(first.status, 'pending', `${role} keeps raw legacy status values`);
    eq(first.items.length, 1, 'lifecycle item data is preserved');
    ok(Boolean(first.timestamps && first.timestamps.created), `${role} keeps timestamps`);
    eq(first.discountCode, 'SAVE10', `${role} keeps discountCode`);
    if (role === 'support') {
      // The tracking URL is a bearer token for the full unmasked order. A
      // support user must not receive a usable one through the admin list.
      eq(String(first.tracking_url || ''), '', 'support has no usable tracking link');
    } else {
      ok(Boolean(first.tracking_url), `${role} keeps a tracking link`);
    }
    eq('internalSecret' in first, false, `${role} never sees unlisted columns`);
  }

  for (const field of ['customer', 'phone', 'phoneAlt', 'email', 'address']) {
    eq(admin.body.orders[0][field], state.orders[6][field], `admin keeps ${field}`);
    eq(manager.body.orders[0][field], state.orders[6][field], `manager keeps ${field}`);
    eq(support.body.orders[0][field], '', `support is masked for ${field}`);
  }
  eq(support.body.orders[0].city, 'Cairo', 'support keeps non-identifying city');
  eq(support.body.orders[0].notes, '', 'support never sees customer free-text notes');

  const listSelects = state.orderSelects.filter((cols) => cols && cols.includes('tracking_url'));
  ok(listSelects.length >= 3, 'full list queries were recorded');
  ok(listSelects.every((cols) => cols !== '*'), 'full list does not use select("*")');
  for (const field of [
    'id', 'status', 'date', 'customer', 'phone', 'phoneAlt', 'email', 'address', 'city',
    'notes', 'items', 'timestamps', 'subtotal', 'discount', 'total', 'discountCode', 'tracking_url',
  ]) ok(listSelects[0].split(',').map((s) => s.trim()).includes(field), `explicit select includes ${field}`);
}

// ─── [4] legacy tracking links expire from the order's date ──────────────────
console.log('\n[4] legacy tracking token age');
{
  const orderId = 'ZSH-TRACK-0001';
  const legacy = crypto.createHmac('sha256', process.env.SESSION_SECRET)
    .update(`track:${orderId}`).digest('hex').slice(0, 32);
  const track = async (tk, ip) => {
    const res = await call(ordersHandler, {
      query: { track: orderId, tk }, headers: { 'x-real-ip': ip || '198.51.100.77' },
    });
    return res;
  };
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const oldIso = oldDate.toISOString();
  const oldDay = oldIso.slice(0, 10);

  state.orders = [{ ...fixtureOrder(1, 'Shipped', today), id: orderId }];
  eq((await track(legacy)).body.found, true, 'a fresh legacy link still works');

  state.orders = [{
    ...fixtureOrder(1, 'Shipped', oldDay),
    id: orderId,
    timestamps: { created: oldIso },
  }];
  eq((await track(legacy)).body, { found: false },
    'an old legacy link is rejected with the generic response');

  state.orders[0].timestamps = { created: createdAt };
  eq((await track(legacy)).body.found, true,
    'an explicit creation timestamp takes precedence over the wall date');

  state.orders[0].timestamps = {};
  state.orders[0].date = null;
  eq((await track(legacy)).body, { found: false }, 'missing/invalid order age fails closed');

  state.orderReads = 0;
  eq((await track('f'.repeat(32), '198.51.100.78')).body, { found: false },
    'invalid legacy signature is still generic');
  eq(state.orderReads, 0, 'invalid signature never touches the database');

  const versioned = lib.trackToken(orderId, Date.now() + 60 * 1000);
  state.orders[0].date = oldDay;
  eq((await track(versioned, '198.51.100.79')).body.found, true,
    'v1 tokens are untouched by the legacy age rule');
}

// ─── [5] real store + analytics through Vite SSR ─────────────────────────────
console.log('\n[5] store contract and all-time labels');
{
  const memoryStorage = () => {
    const values = new Map();
    return {
      getItem: (k) => (values.has(k) ? values.get(k) : null),
      setItem: (k, v) => { values.set(k, String(v)); },
      removeItem: (k) => { values.delete(k); },
    };
  };
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();

  const apiState = { calls: [], mode: 'products', summary: null, fullOrders: [], failure: null };
  globalThis.__zashmApi = {
    get: async (path) => {
      apiState.calls.push(['get', path]);
      if (apiState.failure) throw apiState.failure;
      if (path === '/admin/products') {
        return { products: [{ id: 99, name: 'Imported', price: 100, stock: 2 }] };
      }
      if (path === '/admin/coupons') return { discounts: [{ id: 1, code: 'SAVE10' }] };
      if (path === '/admin/orders?summary=1') return { summary: apiState.summary };
      if (path === '/admin/orders') return { orders: apiState.fullOrders };
      return {};
    },
    post: async (path, body) => {
      apiState.calls.push(['post', path, body]);
      return { count: 1 };
    },
    patch: async () => ({}),
    del: async () => ({}),
  };

  const mocks = new Map([
    ['zustand', `
      export const create = (initializer) => {
        let state;
        const listeners = new Set();
        const set = (patch) => {
          const next = typeof patch === 'function' ? patch(state) : patch;
          state = { ...state, ...next };
          listeners.forEach((listener) => listener());
          return state;
        };
        const get = () => state;
        state = initializer(set, get);
        const hook = (selector) => (selector ? selector(state) : state);
        hook.getState = get;
        hook.setState = set;
        return hook;
      };
    `],
    ['./lib/security', `
      export const db = {
        getAll: (key) => ({ products: [], orders: [], notifications: [] })[key],
        setAll: () => {},
        delete: () => {},
      };
      export const trackEvent = () => {};
    `],
    ['./lib/supabase', `
      export const SUPABASE_URL = 'https://test.supabase.co';
      export const fetchPublicProducts = async () => ([{
        id: 99, name: 'Imported', price: 100, stock: 2,
        variantStock: {}, sizes: [], colors: [], images: [], active: true,
      }]);
    `],
    ['./lib/api', `
      export const api = globalThis.__zashmApi;
    `],
    ['./lib/resilience', 'export const fetchCatalogSnapshot = async () => [];'],
    ['./lib/routes', `
      export const pageUrl = () => '/';
      export const resolveRoute = () => ({ page: 'home', productId: null });
      export const syncLocationToStore = () => {};
    `],
    ['./lib/orderConfirmation.mjs', 'export const clearOrderConfirmation = () => {};'],
    ['./lib/pricing', `
      export const effectivePrice = (p) => Number(p && p.price) || 0;
      export const hasInvalidVariantConfig = () => false;
      export const hasVariantStock = () => false;
      export const isSellableVariant = () => true;
      export const sellableStockFor = (p) => Number(p && p.stock) || 0;
    `],
    ['./lib/fit', 'export const sanitizeSizeRanges = () => ({});'],
  ]);
  const mocksPlugin = {
    name: 'admin-fixes-test-mocks',
    enforce: 'pre',
    resolveId(source) {
      return mocks.has(source) ? `\0admin-fixes:${source}` : null;
    },
    load(id) {
      return id.startsWith('\0admin-fixes:') ? mocks.get(id.slice('\0admin-fixes:'.length)) : null;
    },
  };

  let server;
  try {
    const envDir = await mkdtemp(path.join(tmpdir(), 'zashm-admin-fixes-env-'));
    server = await createServer({
      configFile: false,
      root,
      envDir,
      plugins: [mocksPlugin],
      optimizeDeps: { noDiscovery: true, entries: [] },
      appType: 'custom',
      logLevel: 'error',
      server: { middlewareMode: true },
    });
    const { useStore } = await server.ssrLoadModule('/src/store.js');
    const analytics = await server.ssrLoadModule('/src/lib/analytics.js');

    // [5a] importProducts refreshes the admin grid, like addProduct.
    apiState.calls = [];
    const imported = await useStore.getState().importProducts([{ name: 'Imported' }]);
    eq(imported.success, true, 'import succeeds');
    ok(apiState.calls.some(([verb, url]) => verb === 'post' && url === '/admin/products'),
      'import posts to the admin products endpoint');
    ok(apiState.calls.some(([verb, url]) => verb === 'get' && url === '/admin/products'),
      'import re-reads the admin products grid after the POST');
    eq(useStore.getState().adminProducts[0].id, 99, 'adminProducts is refreshed immediately');

    // [5b] discounts never look like a healthy empty list after a failure.
    await useStore.getState().refreshDiscounts();
    eq(useStore.getState().discountsLoadStatus, 'success', 'successful discounts load is recorded');
    eq(useStore.getState().discountsError, null, 'no error on success');
    eq(useStore.getState().discounts.length, 1, 'discounts are loaded');

    apiState.failure = { status: 403, message: 'Forbidden' };
    await useStore.getState().refreshDiscounts();
    eq(useStore.getState().discountsLoadStatus, 'error', '401/403 marks the load as error');
    eq(useStore.getState().discountsError, 'Not authorized to load discounts',
      'unauthorized discounts have an explicit message');
    apiState.failure = { status: 429, message: 'Too many attempts' };
    await useStore.getState().refreshDiscounts();
    eq(useStore.getState().discountsLoadStatus, 'error', 'a 429 is an error, not an empty list');
    eq(useStore.getState().discountsError, 'Too many attempts', 'real error message is preserved');
    apiState.failure = null;

    // [5c] compact summary poll vs full refresh.
    const fullOrder = {
      id: 'ZSH-OLD-1', customer: 'Old', status: 'Pending', total: 50,
      items: [], date: today, timestamps: { created: createdAt },
    };
    localStorage.setItem('zashm_notif_read_at', '0');
    useStore.setState({ orders: [fullOrder], unreadOrderCount: 0, newOrderNotification: null });
    apiState.fullOrders = [fullOrder];
    apiState.summary = {
      total: 1,
      byStatus: { Pending: 1, Confirmed: 0, Processing: 0, Shipped: 0, Delivered: 0, Cancelled: 0 },
      newest: [{ id: 'ZSH-NEW-1', status: 'Pending', total: 60, date: today, customer: '' }],
    };
    apiState.calls = [];
    const first = await useStore.getState().refreshOrderSummary(true);
    eq(apiState.calls, [['get', '/admin/orders?summary=1']], 'silent poll only calls the compact endpoint');
    eq(first.total, 1, 'summary is stored');
    eq(useStore.getState().ordersLiveStatus, 'ok', 'live status is ok on success');
    eq(useStore.getState().orderSummary.newest[0].id, 'ZSH-NEW-1', 'newest is copied into state');
    eq(useStore.getState().newOrderNotification, null, 'first summary establishes the baseline');
    eq(useStore.getState().unreadOrderCount, 1, 'unread count is computed from known orders');

    apiState.summary = {
      ...apiState.summary,
      total: 2,
      newest: [
        { id: 'ZSH-NEW-1', status: 'Pending', total: 60, date: today, customer: '' },
        { id: 'ZSH-NEW-2', status: 'Pending', total: 70, date: today, customer: '' },
      ],
    };
    const newFullOrder = {
      id: 'ZSH-NEW-2', customer: 'New', status: 'Pending', total: 70,
      items: [], date: today, timestamps: { created: new Date().toISOString() },
    };
    apiState.fullOrders = [fullOrder, newFullOrder];
    apiState.calls = [];
    await useStore.getState().refreshOrderSummary(true);
    eq(useStore.getState().newOrderNotification.order.id, 'ZSH-NEW-2',
      'a genuinely new summary id raises a notification');
    eq(useStore.getState().unreadOrderCount, 2, 'unread count grows with the new order');

    // The compact poll must merge the new id into the authoritative snapshot so
    // the Orders panel, notification dropdown and KPIs do not stay stale.
    await new Promise((resolve) => setTimeout(resolve, 0));
    ok(apiState.calls.some(([verb, url]) => verb === 'get' && url === '/admin/orders'),
      'a new summary id triggers one authoritative full refresh');
    ok(useStore.getState().orders.some((o) => o.id === 'ZSH-NEW-2'),
      'the new order is merged into the full Orders list');
    ok(useStore.getState().getNotifications().some((n) => n.orderId === 'ZSH-NEW-2'),
      'the notification dropdown sees the new order');

    const lastGood = useStore.getState().orderSummary;
    apiState.failure = { status: 429, message: 'Too many attempts' };
    await useStore.getState().refreshOrderSummary(true);
    eq(useStore.getState().ordersLiveStatus, 'degraded', 'silent 429 is a visible degraded state');
    eq(useStore.getState().ordersError, 'Too many attempts', 'silent 429 is surfaced as an error');
    eq(useStore.getState().orderSummary, lastGood, 'last good summary survives a failed poll');
    apiState.failure = { status: 403, message: 'Forbidden' };
    await useStore.getState().refreshOrderSummary(true);
    eq(useStore.getState().ordersLiveStatus, 'unauthorized', '401/403 maps to unauthorized');
    apiState.failure = null;

    apiState.calls = [];
    await useStore.getState().refreshOrders();
    ok(apiState.calls.some(([verb, url]) => verb === 'get' && url === '/admin/orders'),
      'refreshOrders stays the full snapshot fetch');
    ok(!apiState.calls.some(([, url]) => String(url).includes('summary=')),
      'refreshOrders never downgrades to the compact endpoint');
    eq(useStore.getState().ordersLiveStatus, 'ok', 'full refresh also marks live status ok');

    // [5d] all-time month labels carry the year only when needed.
    const NOW = new Date('2026-11-26T12:00:00Z');
    const orders = [
      { date: '2025-01-10', status: 'Delivered', total: 100 },
      { date: '2026-01-10', status: 'Delivered', total: 200 },
    ];
    const labels = analytics.computeSalesOverview(orders, 'all', NOW).series.map((b) => b.label);
    eq(labels, ['Jan 25', 'Jan 26'], 'a >12-month span disambiguates identical months');
    const short = analytics.computeSalesOverview([
      { date: '2026-01-10', status: 'Delivered', total: 100 },
      { date: '2026-02-10', status: 'Delivered', total: 100 },
    ], 'all', NOW).series.map((b) => b.label);
    eq(short, ['Jan', 'Feb'], 'short all-time ranges keep the original labels');

    // [5e] the frontend contract names stay stable.
    const storeSrc = read('src/store.js');
    for (const name of [
      'discountsLoadStatus', 'discountsError', 'orderSummary', 'ordersLiveStatus', 'refreshOrderSummary',
    ]) ok(storeSrc.includes(name), `store exposes ${name}`);
    ok(/api\.get\('\/admin\/orders\?summary=1'\)/.test(storeSrc),
      'the store calls the compact endpoint');
    ok(/'degraded'[\s\S]{0,200}status === 429/.test(storeSrc),
      'a silent 429 still sets the degraded status');
    ok(/summaryFullRefreshPending/.test(storeSrc),
      'a new summary id coalesces a full authoritative refresh');
    const adminSrc = read('src/pages/AdminApp.js');
    ok(/const pendingCount = orderSummary && ordersLiveStatus === 'ok'/.test(adminSrc) &&
      /byStatus\?\.Pending/.test(adminSrc),
    'the pending badge prefers the fresh summary count');
  } finally {
    if (server) await server.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
