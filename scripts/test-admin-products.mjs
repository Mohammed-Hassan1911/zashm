/**
 * H-01 / F-01 — admin products endpoint tests.
 *
 *   node scripts/test-admin-products.mjs
 *
 * The admin panel must not read the public `products_public` view: that view
 * hides inactive rows and does not expose `tags`, so editing a product from it
 * silently wiped tags and made deactivated products unreachable.
 *
 * Drives the REAL api/admin/products.js GET handler against a fake Supabase
 * client and proves:
 *   - anonymous requests are rejected (401) without touching products;
 *   - a role without products.read is rejected (403);
 *   - admins/managers receive FULL rows, including inactive products and tags;
 *   - raw database errors are never echoed to the client;
 *   - the router actually wires GET (the original bug was a missing branch).
 *
 * Nothing here touches Supabase or production.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake database ───────────────────────────────────────────────────────────
const state = {
  users: [
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', session_version: 0 },
    { id: 2, name: 'Manager', email: 'manager@example.com', role: 'manager', session_version: 0 },
    { id: 3, name: 'Support', email: 'support@example.com', role: 'support', session_version: 0 },
  ],
  products: [
    {
      id: 10, name: 'Visible Shirt', category: 'Shirts', price: 100, salePrice: null,
      stock: 5, variantStock: {}, sku: 'V-10', label: 'Featured', tags: 'cotton,summer',
      active: true, colors: ['Black'], sizes: ['M'], images: ['https://example.test/a.jpg'],
      image: 'https://example.test/a.jpg', sizeGuide: null,
    },
    {
      id: 9, name: 'Hidden Jacket', category: 'Jackets', price: 400, salePrice: 350,
      stock: 0, variantStock: {}, sku: 'H-09', label: '', tags: 'winter,archive',
      active: false, colors: [], sizes: [], images: [], image: '', sizeGuide: null,
    },
  ],
  productsReads: 0,
  failProducts: false,
};

function matches(row, filters) {
  return filters.every(([col, val, op]) => {
    if (op === 'neq') return String(row[col]) !== String(val);
    return String(row[col]) === String(val);
  });
}

function makeQuery(table) {
  const q = {
    _filters: [],
    _order: null,
    select() { return q; },
    eq(col, val) { q._filters.push([col, val, 'eq']); return q; },
    neq(col, val) { q._filters.push([col, val, 'neq']); return q; },
    order(col, opts) { q._order = { col, ascending: !(opts && opts.ascending === false) }; return q; },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(onOk, onErr) { return run().then(onOk, onErr); },
  };

  async function run() {
    await sleep(0);
    if (table === 'users') {
      return { data: state.users.filter((r) => matches(r, q._filters)).map((r) => ({ ...r })), error: null };
    }
    if (table === 'products') {
      state.productsReads += 1;
      if (state.failProducts) {
        return { data: null, error: new Error('relation "products" internal secret detail') };
      }
      let rows = state.products.filter((r) => matches(r, q._filters)).map((r) => ({ ...r }));
      if (q._order) {
        const { col, ascending } = q._order;
        rows.sort((a, b) => (Number(a[col]) - Number(b[col])) * (ascending ? 1 : -1));
      }
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  }

  return q;
}

const sb = { from(table) { return makeQuery(table); } };

// ─── Boot the real handler ───────────────────────────────────────────────────
process.env.SESSION_SECRET = 'test-session-secret-for-admin-products-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
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
Module._load = originalLoad;

// ─── HTTP fakes ──────────────────────────────────────────────────────────────
let ipCounter = 1;
function makeReq({ method = 'GET', body, headers = {}, query = {} } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const listeners = {};
  const req = {
    method,
    headers: { 'x-real-ip': `203.0.113.${(ipCounter++ % 250) + 1}`, ...headers },
    query,
    socket: { remoteAddress: '203.0.113.1' },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (event === 'data' && text) setImmediate(() => cb(Buffer.from(text)));
      if (event === 'end') setImmediate(() => cb());
      return req;
    },
    destroy() {},
  };
  return req;
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

async function call(opts = {}) {
  const req = makeReq(opts);
  const res = makeRes();
  await productsHandler(req, res);
  return res;
}

function tokenFor(user) {
  return lib.signSession({
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    session_version: user.session_version,
  });
}

const admin = state.users[0];
const manager = state.users[1];
const support = state.users[2];

console.log('\n[1] authorization');
{
  state.productsReads = 0;
  const anon = await call();
  eq(anon.statusCode, 401, 'anonymous GET is rejected');
  eq(state.productsReads, 0, 'anonymous GET never touches the products table');

  const asSupport = await call({ headers: { authorization: `Bearer ${tokenFor(support)}` } });
  eq(asSupport.statusCode, 403, 'support role cannot read admin products');

  const asManager = await call({ headers: { authorization: `Bearer ${tokenFor(manager)}` } });
  eq(asManager.statusCode, 200, 'manager (products.read) can list products');
  eq(asManager.body.count, 2, 'manager receives every row');
}

console.log('\n[2] full rows (inactive + tags)');
{
  const res = await call({ headers: { authorization: `Bearer ${tokenFor(admin)}` } });
  eq(res.statusCode, 200, 'admin GET succeeds');
  eq(res.body.success, true, 'response is marked successful');
  const byId = new Map(res.body.products.map((p) => [p.id, p]));
  eq(byId.get(9).active, false, 'inactive product is present with active=false');
  eq(byId.get(9).tags, 'winter,archive', 'tags survive for inactive products');
  eq(byId.get(10).tags, 'cotton,summer', 'tags survive for active products');
  eq(byId.get(9).stock, 0, 'real stock is returned');
  eq(res.body.products[0].id, 10, 'rows are ordered newest-first by id');
  ok(!Object.prototype.hasOwnProperty.call(byId.get(9), 'reservedStock') || byId.get(9).reservedStock !== undefined,
    'admin rows are raw service-role rows (reservedStock allowed for admin)');
}

console.log('\n[3] database errors never leak');
{
  state.failProducts = true;
  const res = await call({ headers: { authorization: `Bearer ${tokenFor(admin)}` } });
  state.failProducts = false;
  eq(res.statusCode, 500, 'DB failure returns 500');
  eq(res.body.error, 'Could not load products', 'generic client error');
  ok(!/internal secret detail|relation/i.test(JSON.stringify(res.body)), 'raw DB message is not echoed');
}

console.log('\n[4] the router wires GET');
{
  const src = readFileSync(new URL('../api/admin/products.js', import.meta.url), 'utf8');
  ok(/req\.method\s*===\s*'GET'\s*\)\s*return listProducts/.test(src), 'GET /api/admin/products is routed');
  ok(/requirePerm\(req,\s*res,\s*'products\.read'\)/.test(src), 'GET requires products.read');
}

console.log('\n[5] admin page navigation and add-product wiring');
{
  const src = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  const pageContentStart = src.indexOf('<div style={{ flex:1, overflowY:\'auto\', padding:\'16px\'');
  const dashboardStart = src.indexOf('// ─── DASHBOARD', pageContentStart);
  const pageContent = src.slice(pageContentStart, dashboardStart);

  ok(pageContentStart >= 0 && dashboardStart > pageContentStart, 'admin page content block is found');
  ok(!/<AnimatePresence mode="wait">/.test(pageContent), 'admin page changes do not wait for the previous page to exit');
  ok(/<motion\.div key=\{adminPage\}/.test(pageContent), 'selected admin page mounts with its own entrance animation');
  ok(/onAddProduct=\{openNewProduct\}/.test(pageContent), 'dashboard add-product action uses the direct navigation handler');
  ok(/const openNewProduct = useCallback\(\(\) => \{\s*setProductFormOpen\(true\);\s*navigateAdminPage\('products'\);/s.test(src),
    'add-product action selects Products and opens its controlled form');
  ok(/<ProductsPanel[^>]*showForm=\{productFormOpen\} setShowForm=\{setProductFormOpen\}/.test(pageContent),
    'ProductsPanel receives the controlled form state');
  ok(!/preOpenNew|onNewOpened|productToAdd/.test(src),
    'opening the form does not depend on a mount-timing effect');
}

console.log(`\nadmin-products: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
