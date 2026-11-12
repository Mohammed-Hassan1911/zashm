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
  missingSizeRanges: false,
  missingTags: false,
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
    _insert: null,
    _update: null,
    select() { return q; },
    insert(rows) { q._insert = Array.isArray(rows) ? rows : [rows]; return q; },
    update(values) { q._update = values; return q; },
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
      // Simulate a database where supabase/product_size_ranges.sql has not
      // been applied yet. The real PostgREST error names the column.
      const touchesRanges = (q._insert || []).some((row) => row && 'sizeRanges' in row)
        || (q._update && 'sizeRanges' in q._update);
      if (state.missingSizeRanges && touchesRanges) {
        return {
          data: null,
          error: { code: 'PGRST204', message: "Could not find the 'sizeRanges' column of 'products' in the schema cache" },
        };
      }
      const touchesTags = (q._insert || []).some((row) => row && 'tags' in row);
      if (state.missingTags && touchesTags) {
        return {
          data: null,
          error: { code: 'PGRST204', message: "Could not find the 'tags' column of 'products' in the schema cache" },
        };
      }
      if (q._insert) {
        const created = q._insert.map((row) => ({ ...row, id: row.id === undefined ? 900 : row.id }));
        state.products.push(...created);
        return { data: created.map((row) => ({ ...row })), error: null };
      }
      if (q._update) {
        const updated = [];
        for (const row of state.products) {
          if (!matches(row, q._filters)) continue;
          Object.assign(row, q._update);
          updated.push({ ...row });
        }
        return { data: updated, error: null };
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

console.log('\n[4b] product payload: duplicate options and server-recomputed stock');
{
  const base = {
    name: 'QA Jacket', category: 'Jackets', price: 100, stock: 999,
    sizes: ['M', ' m ', 'M', 'L'], colors: ['Black', 'black', 'Black'],
    variantStock: { 'M-Black': 6, 'L-Black': 4, 'M-White': 9 },
  };
  const p = lib.validateProductPayload(base);
  ok(p, 'a valid payload is accepted');
  eq(p.sizes, ['M', 'L'], 'duplicate sizes are dropped, first spelling kept');
  eq(p.colors, ['Black'], 'duplicate colours are dropped, first spelling kept');
  eq(p.stock, 10, 'stock is recomputed from declared combinations only (not 999, not 19)');
  eq(p.variantStock['M-White'], 9, 'an orphan variant key keeps its quantity in the payload');

  const noDeclared = lib.validateProductPayload({
    name: 'Legacy Tee', category: 'Tees', price: 50, stock: 12,
    sizes: [], colors: [], variantStock: { 'M-White': 3 },
  });
  eq(noDeclared.stock, 12, 'legacy products without declared options keep their submitted counter');

  const onlySizes = lib.validateProductPayload({
    name: 'Half Tee', category: 'Tees', price: 50, stock: 7,
    sizes: ['M'], colors: [], variantStock: { 'M-White': 3 },
  });
  eq(onlySizes.stock, 7, 'a half-declared product is not silently zeroed');

  const clamped = lib.validateProductPayload({
    ...base,
    variantStock: { 'M-Black': -1, 'L-Black': 4 },
  });
  eq(clamped, null, 'a negative variant quantity is still rejected');
}

console.log('\n[5] admin page navigation and add-product wiring');
{
  const src = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  const pageContentStart = src.indexOf('<div style={{ flex:1, minHeight:0, overflowY:\'auto\', padding:\'16px\'');
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

console.log('\n[6] admin product grid: selectable cards, hover-only actions');
{
  const src = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  ok(!/className="product-card-actions"/.test(src),
    'the admin grid no longer reuses the always-visible storefront action overlay');
  ok(/className=\{`admin-product-card\$\{selected\.has\(p\.id\) \? ' is-selected' : ''\}`\}/.test(src),
    'each admin product card tracks its selected state');
  ok(/onClick=\{\(\) => toggleSelect\(p\.id\)\}/.test(src),
    'clicking a product card selects it');
  ok(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(src),
    'the checkbox does not double-toggle the card selection');
  ok(/className="admin-product-actions"/.test(src),
    'edit/delete live in a dedicated admin overlay');
  ok(/aria-label=\{`Edit \$\{p\.name\}`\}/.test(src) && /aria-label=\{`Delete \$\{p\.name\}`\}/.test(src),
    'edit and delete are labelled for screen readers');
  ok(/\.admin-product-card \.admin-product-actions\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/.test(css),
    'the admin action overlay is hidden by default');
  ok(/\.admin-product-card:hover \.admin-product-actions,[\s\S]{0,180}\.admin-product-card\.is-selected \.admin-product-actions\s*\{[^}]*opacity:\s*1/.test(css),
    'the overlay appears on hover, focus or selection');
  ok(/\.admin-product-card \.admin-product-actions button\s*\{[^}]*pointer-events:\s*none/.test(css)
    && /\.admin-product-card\.is-selected \.admin-product-actions button\s*\{[^}]*pointer-events:\s*auto/.test(css),
    'invisible action buttons never capture clicks');
}

console.log('\n[7] order status safety (final statuses need confirmation)');
{
  const src = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  ok(/const FINAL_ORDER_STATUSES = \['Delivered', 'Cancelled'\]/.test(src),
    'Delivered and Cancelled are declared as final statuses');
  ok(/const requestStatusChange = \(order, status\) => \{[\s\S]*?FINAL_ORDER_STATUSES\.includes\(status\)[\s\S]*?setStatusConfirm\(\{ order, status \}\)/.test(src),
    'final statuses open a confirmation instead of applying immediately');
  ok(/onChange=\{e => \{ const next = e\.target\.value; e\.target\.value = order\.status; requestStatusChange\(order, next\); \}\}/.test(src),
    'the table status dropdown resets itself and asks for confirmation');
  ok(/onClick=\{\(\) => requestStatusChange\(selected, s\)\}/.test(src),
    'the order drawer status buttons use the same confirmation path');
  ok(/ref=\{statusDialogRef\} role="dialog" aria-modal="true" aria-labelledby="order-status-confirm-title"/.test(src),
    'the confirmation is an accessible modal dialog');
  ok(/if \(e\.key === 'Escape'\) \{\s*if \(!statusSaving\) setStatusConfirm\(null\);\s*return;\s*\}/.test(src),
    'Escape dismisses the confirmation but never while a save is in flight');
  ok(/const focusable = root\.querySelectorAll\('button:not\(\[disabled\]\), \[href\], input, select, textarea, \[tabindex\]:not\(\[tabindex="-1"\]\)'\)/.test(src)
    && /if \(e\.shiftKey && document\.activeElement === first\)[\s\S]*?last\.focus\(\)/.test(src)
    && /else if \(!e\.shiftKey && document\.activeElement === last\)[\s\S]*?first\.focus\(\)/.test(src),
    'Tab and Shift+Tab stay inside the confirmation dialog');
  ok(/Order not updated\. \$\{res\.error \|\| 'Please try again\.'\}/.test(src),
    'a failed status change says the order was not updated');
  ok(/toast\.success\(`Order moved to \$\{status\}\.`\)/.test(src),
    'a successful status change is confirmed to the admin');
  ok(!/handleStatusChange/.test(src),
    'no code path can change a status without going through the confirmation helper');
}

console.log('\n[8] size finder windows: payload, persistence and degraded schema');
{
  // Server-side sanitizer mirrors src/lib/fit.js: case-resolve keys, clamp,
  // swap an inverted pair, drop junk.
  const normalized = lib.validateProductPayload({
    name: 'Range Tee', category: 'Tees', price: 100, stock: 5,
    sizes: ['M', 'L'], colors: ['Black'],
    variantStock: { 'M-Black': 3, 'L-Black': 2 },
    sizeRanges: {
      m: { minWeight: '90', maxWeight: 60, minHeight: 190, maxHeight: 170 },
      junk: { minWeight: 'abc', maxWeight: 9999 },
      L: { minWeight: 71, maxWeight: 85, minHeight: 176, maxHeight: 188 },
    },
  });
  eq(normalized.sizeRanges.M, { minWeight: 60, maxWeight: 90, minHeight: 170, maxHeight: 190 },
    'keys resolve to the product spelling and inverted pairs are swapped');
  eq(normalized.sizeRanges.L, { minWeight: 71, maxWeight: 85, minHeight: 176, maxHeight: 188 },
    'a valid window survives untouched');
  eq(Object.prototype.hasOwnProperty.call(normalized.sizeRanges, 'junk'), false,
    'an entry with no usable bound is dropped');

  eq(lib.validateProductPayload({
    name: 'No Ranges', category: 'Tees', price: 100, stock: 1, sizes: ['M'], colors: ['Black'],
    variantStock: { 'M-Black': 1 },
  }).sizeRanges, {}, 'a product without windows stores an empty object');

  // POST: the column exists — windows are stored and no warning is returned.
  state.missingSizeRanges = false;
  const post = await call({
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(admin)}` },
    body: {
      product: {
        name: 'Range Tee', category: 'Tees', price: 100, stock: 5,
        sizes: ['M', 'L'], colors: ['Black'],
        variantStock: { 'M-Black': 3, 'L-Black': 2 },
        images: ['https://example.test/range.jpg'],
        sizeRanges: { M: { minWeight: 60, maxWeight: 75, minHeight: 165, maxHeight: 180 } },
      },
    },
  });
  eq(post.statusCode, 200, 'POST with sizeRanges succeeds');
  eq(post.body.warnings, {}, 'no warning when the column exists');
  eq(post.body.product.sizeRanges.M.maxWeight, 75, 'the window is stored on the new product');

  // POST: column missing — the product still saves, and the client is told.
  state.missingSizeRanges = true;
  const degradedPost = await call({
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(admin)}` },
    body: {
      product: {
        name: 'Degraded Tee', category: 'Tees', price: 90, stock: 2,
        sizes: ['M'], colors: ['Black'], variantStock: { 'M-Black': 2 },
        images: ['https://example.test/degraded.jpg'],
        sizeRanges: { M: { minWeight: 60, maxWeight: 75 } },
      },
    },
  });
  state.missingSizeRanges = false;
  eq(degradedPost.statusCode, 200, 'POST still succeeds when the column is missing');
  eq(degradedPost.body.warnings.sizeRanges, 'column-missing', 'the response reports the missing column');
  eq(degradedPost.body.product.name, 'Degraded Tee', 'the rest of the product is saved');
  eq(degradedPost.body.product.sizeRanges, undefined, 'the unstored window is not echoed as saved');

  // A different missing column must not be blamed on sizeRanges or drop it.
  state.missingTags = true;
  const tagsDegraded = await call({
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(admin)}` },
    body: {
      product: {
        name: 'Tagless Tee', category: 'Tees', price: 80, stock: 1,
        sizes: ['M'], colors: ['Black'], variantStock: { 'M-Black': 1 },
        images: ['https://example.test/tagless.jpg'], tags: 'summer',
        sizeRanges: { M: { minWeight: 60, maxWeight: 70 } },
      },
    },
  });
  state.missingTags = false;
  eq(tagsDegraded.statusCode, 200, 'a missing tags column still saves the product');
  eq(tagsDegraded.body.warnings, {}, 'the tags failure is not misreported as a sizeRanges failure');
  eq(tagsDegraded.body.product.sizeRanges.M.maxWeight, 70, 'sizeRanges survives a tags-only schema retry');

  // PATCH: windows update in place.
  const patch = await call({
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(admin)}` },
    body: { id: 10, updates: { sizeRanges: { L: { minWeight: 71, maxWeight: 85 } } } },
  });
  eq(patch.statusCode, 200, 'PATCH with sizeRanges succeeds');
  eq(patch.body.warnings, {}, 'PATCH reports no warning when the column exists');
  eq(patch.body.product.sizeRanges.L.maxWeight, 85, 'the updated window is returned');

  // PATCH: column missing — the other fields still save.
  state.missingSizeRanges = true;
  const degradedPatch = await call({
    method: 'PATCH',
    headers: { authorization: `Bearer ${tokenFor(admin)}` },
    body: { id: 9, updates: { label: 'Archive', sizeRanges: { M: { minWeight: 60, maxWeight: 70 } } } },
  });
  state.missingSizeRanges = false;
  eq(degradedPatch.statusCode, 200, 'PATCH still succeeds when the column is missing');
  eq(degradedPatch.body.warnings.sizeRanges, 'column-missing', 'PATCH reports the missing column');
  eq(degradedPatch.body.product.label, 'Archive', 'the other edited fields are saved');

  const src = readFileSync(new URL('../api/admin/products.js', import.meta.url), 'utf8');
  ok(/req\.method\s*===\s*'POST'\s*\)\s*return createProduct/.test(src), 'POST is routed');
  ok(/req\.method\s*===\s*'PATCH'\s*\)\s*return updateProduct/.test(src), 'PATCH is routed');
  ok(/isMissingColumn\(updErr, 'sizeRanges'\)/.test(src), 'PATCH detects only the sizeRanges column');
}

console.log('\n[9] admin size-window editor wiring');
{
  const src = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  ok(/const SIZE_RANGE_FIELDS = \[/.test(src), 'the four window fields are declared');
  ok(/key: 'minWeight'/.test(src) && /key: 'maxWeight'/.test(src)
    && /key: 'minHeight'/.test(src) && /key: 'maxHeight'/.test(src),
    'min/max weight and min/max height are all present');
  ok(/📏 Size finder windows/.test(src), 'the panel is labelled for the owner');
  ok(/sizeRangeProblems\(form\.sizeRanges\)/.test(src), 'inverted windows block the save');
  ok(/toast\.error\(`⚠️ \$\{rangeProblems\[0\]\}/.test(src), 'the exact problem is shown to the owner');
  ok(/sanitizeSizeRanges\(form\.sizeRanges, cleanSizes\)/.test(src), 'windows are sanitized against the declared sizes');
  ok(/\.filter\(\(\[size\]\) => cleanSizes\.includes\(size\)\)/.test(src),
    'windows for removed sizes are not saved');
  ok(/warnings\?\.sizeRanges/.test(src), 'the admin surfaces the missing-column warning');
  ok(/supabase\/product_size_ranges\.sql/.test(src), 'the warning names the migration to apply');
  ok(/Clear/.test(src), 'each size window can be cleared');
  ok(/aria-label=\{`\$\{size\} \$\{field\.label\}`\}/.test(src), 'each window input is labelled for screen readers');
}

console.log(`\nadmin-products: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
