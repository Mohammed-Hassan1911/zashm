/**
 * Phase 2 — admin order editing (customer details, items, coupon).
 *
 *   node scripts/test-order-edit.mjs
 *
 * The money/stock/coupon invariants live in supabase/atomic_edit_order.sql and
 * are covered against real PostgreSQL by scripts/test-sql-concurrency.mjs
 * ([4i]). This suite drives the REAL api/admin/orders.js handler through a fake
 * Supabase client and asserts the HTTP contract around that RPC:
 *
 *   - the caller cannot skip the optimistic revision (400/409, never a write);
 *   - every edited line is repriced from the database, never from the request;
 *   - shipping, discount and total are recomputed server-side;
 *   - items are refused outside Pending/Confirmed while customer details stay
 *     editable in every status;
 *   - RPC failure reasons map to stable status/code combinations;
 *   - the edit notification is the short internal template, not the customer
 *     confirmation text;
 *   - the legacy status-only PATCH still works unchanged.
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

// ─── Fake database ──────────────────────────────────────────────────────────
function makeDb() {
  const state = {
    users: [{ id: 'u1', name: 'Admin', email: 'admin@example.com', role: 'admin', session_version: 0 }],
    orders: new Map(),
    products: new Map(),
    coupons: new Map(),
    rpcCalls: [],
    patches: [],
    productLookups: 0,
    rpcOverride: null,
    telegram: [],
  };

  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  function resetOrder({
    id = 'ZSH-TEST-EDIT-1',
    status = 'Pending',
    qty = 2,
    subtotal = 200,
    discount = 20,
    discountCode = 'SAVE10',
    total = 245,
    rev = 0,
  } = {}) {
    state.orders.set(id, {
      id,
      status,
      customer: 'Old Name',
      phone: '01000000000',
      phoneAlt: '',
      email: 'old@example.com',
      address: 'Old address 1',
      city: 'Cairo',
      notes: '',
      items: [{
        productId: 1, name: 'Tee', category: 'clothing',
        size: 'M', color: 'Black', qty, unitPrice: 100, price: qty * 100, image: 'tee.jpg',
      }],
      subtotal,
      discount,
      discountCode,
      total,
      date: '2026-01-01',
      timestamps: { created: '2026-01-01T00:00:00.000Z', rev },
      tracking_url: `https://za-shm.vercel.app/?track=${id}&tk=test`,
    });
  }

  function seedCoupons({ exhausted = false } = {}) {
    state.coupons.clear();
    state.coupons.set('SAVE10', {
      code: 'SAVE10', type: 'percentage', value: 10, discountValue: 10,
      minOrderAmount: 0, maxDiscount: 0, active: true,
      startDate: '2020-01-01', endDate: '2099-12-31',
      usageLimit: exhausted ? 10 : 10, usageCount: exhausted ? 10 : 1,
    });
    state.coupons.set('MIN500', {
      code: 'MIN500', type: 'fixed', value: 50, discountValue: 50,
      minOrderAmount: 500, maxDiscount: 0, active: true,
      startDate: '2020-01-01', endDate: '2099-12-31',
      usageLimit: 10, usageCount: 1,
    });
  }

  function seed({ exhausted = false, ...order } = {}) {
    state.orders.clear();
    state.products.clear();
    state.coupons.clear();
    state.rpcCalls = [];
    state.patches = [];
    state.productLookups = 0;
    state.rpcOverride = null;
    state.telegram = [];
    resetOrder(order);
    seedCoupons({ exhausted });
    state.products.set(1, {
      id: 1, name: 'Tee', category: 'clothing', price: 100, salePrice: null,
      active: true, stock: 10, variantStock: { 'M-Black': 10, 'L-White': 4 },
      sizes: ['M', 'L'], colors: ['Black', 'White'], images: ['tee.jpg'],
    });
    state.products.set(2, {
      id: 2, name: 'Hat', category: 'accessories', price: 200, salePrice: 150,
      active: true, stock: 5, variantStock: {}, sizes: [], colors: [], images: ['hat.jpg'],
    });
  }

  // Mirror the NET stock reconciliation of atomic_edit_order. Validation runs
  // before any mutation, so a rejected edit cannot leave partial stock behind.
  function applyStock(items) {
    const current = state.orders.get('ZSH-TEST-EDIT-1');
    const group = (list) => {
      const map = new Map();
      for (const it of list) {
        const key = `${Number(it.productId)}|${it.size || ''}|${it.color || ''}`;
        map.set(key, (map.get(key) || 0) + Number(it.qty));
      }
      return map;
    };
    const oldLines = group(current.items);
    const newLines = group(items);
    const keys = new Set([...oldLines.keys(), ...newLines.keys()]);
    const deduct = [];
    const restore = [];

    for (const key of keys) {
      const [pidRaw, size, color] = key.split('|');
      const productId = Number(pidRaw);
      const oldQty = oldLines.get(key) || 0;
      const newQty = newLines.get(key) || 0;
      if (newQty > oldQty) deduct.push({ productId, size, color, qty: newQty - oldQty });
      if (oldQty > newQty) restore.push({ productId, size, color, qty: oldQty - newQty });
    }

    for (const line of deduct) {
      const product = state.products.get(line.productId);
      if (!product) return { ok: false, reason: 'missing_product', productId: line.productId };
      const hasVariants = product.variantStock && Object.keys(product.variantStock).length > 0;
      if (hasVariants) {
        const key = `${line.size}-${line.color}`;
        if (!(key in product.variantStock)) {
          return { ok: false, reason: 'missing_variant', productId: line.productId, variant: key };
        }
        const available = Number(product.variantStock[key]) || 0;
        if (line.qty > available) {
          return {
            ok: false, reason: 'unavailable', productId: line.productId,
            available: Math.max(0, available), requested: line.qty,
          };
        }
      } else if (line.qty > Number(product.stock || 0)) {
        return {
          ok: false, reason: 'unavailable', productId: line.productId,
          available: Math.max(0, Number(product.stock || 0)), requested: line.qty,
        };
      }
    }

    for (const line of deduct) {
      const product = state.products.get(line.productId);
      const hasVariants = product.variantStock && Object.keys(product.variantStock).length > 0;
      if (hasVariants) {
        const key = `${line.size}-${line.color}`;
        product.variantStock[key] = Math.max(0, Number(product.variantStock[key] || 0) - line.qty);
      } else {
        product.stock = Math.max(0, Number(product.stock || 0) - line.qty);
      }
    }
    for (const line of restore) {
      const product = state.products.get(line.productId);
      if (!product) continue; // partial/tolerant restore, as in SQL
      const hasVariants = product.variantStock && Object.keys(product.variantStock).length > 0;
      if (hasVariants) {
        const key = `${line.size}-${line.color}`;
        if (!(key in product.variantStock)) continue;
        product.variantStock[key] = Number(product.variantStock[key] || 0) + line.qty;
      } else {
        product.stock = Number(product.stock || 0) + line.qty;
      }
    }
    return { ok: true };
  }

  function applyEdit(args) {
    const order = state.orders.get(String(args.p_id));
    if (!order) return { ok: false, reason: 'not_found' };

    const rev = Number(order.timestamps && order.timestamps.rev) || 0;
    if (rev !== Number(args.p_expected_rev)) {
      return { ok: false, reason: 'rev_conflict', rev };
    }

    const patch = args.p_patch || {};
    const itemsChanged = Object.prototype.hasOwnProperty.call(patch, 'items');
    if (itemsChanged && !['Pending', 'Confirmed'].includes(order.status)) {
      return { ok: false, reason: 'items_locked', status: order.status };
    }

    if (itemsChanged) {
      for (const item of patch.items) {
        if (!state.products.get(Number(item.productId))) {
          return { ok: false, reason: 'missing_product', productId: item.productId };
        }
      }
      const stock = applyStock(patch.items);
      if (!stock.ok) return stock;
    }

    state.patches.push(clone(patch));
    if (itemsChanged) order.items = clone(patch.items);
    for (const key of ['customer', 'phone', 'phoneAlt', 'email', 'address', 'city', 'notes']) {
      if (patch[key] !== undefined) order[key] = patch[key];
    }
    order.subtotal = patch.subtotal;
    order.discount = patch.discount;
    order.total = patch.total;
    order.discountCode = patch.discountCode || '';
    order.timestamps = {
      ...(order.timestamps || {}),
      edited: '2026-01-02T00:00:00.000Z',
      rev: rev + 1,
    };

    return { ok: true, rev: rev + 1, warnings: [] };
  }

  const sb = {
    from(table) {
      const q = {
        _filter: null,
        select() { return q; },
        eq(col, val) { q._filter = { col, val }; return q; },
        async maybeSingle() {
          const list = table === 'users' ? state.users
            : table === 'orders' ? [...state.orders.values()]
              : table === 'coupons' ? [...state.coupons.values()]
                : [];
          const filter = q._filter;
          const row = list.find((r) => String(r[filter ? filter.col : 'id']) === String(filter ? filter.val : ''));
          return { data: clone(row) || null, error: null };
        },
        in(col, values) {
          state.productLookups += 1;
          const wanted = new Set((values || []).map(String));
          const list = table === 'products' ? [...state.products.values()] : [];
          return Promise.resolve({
            data: clone(list.filter((r) => wanted.has(String(r[col])))),
            error: null,
          });
        },
      };
      return q;
    },

    async rpc(name, args) {
      state.rpcCalls.push(name);
      if (name === 'zshm_rate_limit') {
        return { data: { allowed: true, count: 1, remaining: 59, resetIn: 60 }, error: null };
      }
      if (name === 'atomic_set_order_status') {
        const order = state.orders.get(String(args.p_id));
        if (!order) return { data: { ok: false, reason: 'not_found' }, error: null };
        if (args.p_expected_status && order.status !== args.p_expected_status) {
          return { data: { ok: false, reason: 'status_changed', status: order.status }, error: null };
        }
        order.status = args.p_new_status;
        if (args.p_timestamps) order.timestamps = args.p_timestamps;
        return { data: { ok: true, changed: true, to: order.status, warnings: [] }, error: null };
      }
      if (name === 'atomic_edit_order') {
        if (state.rpcOverride) return clone(state.rpcOverride);
        return { data: applyEdit(args), error: null };
      }
      return { data: { ok: false, reason: 'unknown_rpc' }, error: null };
    },
  };

  return { state, sb, seed };
}

// ─── Boot the real handler against the fake client ──────────────────────────
process.env.SESSION_SECRET = 'test-session-secret-for-order-edit-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-token';
process.env.TELEGRAM_CHAT_ID = '123456';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { state, sb, seed } = makeDb();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => sb };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
const cachedClient = lib.supabaseAdmin();
const handler = require('../api/admin/orders.js');
Module._load = originalLoad;
if (cachedClient !== sb) {
  console.error('FAIL: fake Supabase client was not injected');
  process.exit(1);
}

// Capture Telegram so the edit template can be asserted without network.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  state.telegram.push({ url: String(url), init });
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

const token = lib.signSession({
  id: 'u1', role: 'admin', name: 'Admin',
  email: 'admin@example.com', session_version: 0,
});

function makeReq({ method, body, query } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const listeners = {};
  let started = false;
  const req = {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-real-ip': '203.0.113.7',
      origin: 'https://za-shm.vercel.app',
    },
    query: query || {},
    socket: { remoteAddress: '203.0.113.7' },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (started) {
        if (event === 'data' && text) setImmediate(() => cb(Buffer.from(text)));
        if (event === 'end') setImmediate(() => cb());
      }
      return req;
    },
    destroy() {},
  };
  setImmediate(() => {
    started = true;
    if (text) (listeners.data || []).forEach((cb) => cb(Buffer.from(text)));
    (listeners.end || []).forEach((cb) => cb());
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(text) { this.body = text ? JSON.parse(text) : null; this.done = true; },
  };
}

async function call(method, body, query) {
  const req = makeReq({ method, body, query });
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

const CUSTOMER = {
  name: 'New Name',
  phone: '01123456789',
  phoneAlt: '',
  email: 'new@example.com',
  address: 'New address 123',
  city: 'Cairo',
  notes: 'please call',
};

function editBody(extra = {}) {
  return { id: 'ZSH-TEST-EDIT-1', action: 'edit', expectedRev: 0, customer: CUSTOMER, ...extra };
}

// ─── [1] static: edit is atomic and money stays server-side ─────────────────
console.log('\n[1] static checks: atomic edit, no direct writes');
{
  const api = readFileSync(new URL('../api/admin/orders.js', import.meta.url), 'utf8');
  ok(/atomic_edit_order/.test(api), 'the API calls atomic_edit_order');
  ok(/isEditRequest/.test(api) && /validateOrderEditPayload/.test(api),
    'the edit path is explicitly gated and validated');
  ok(!/\.from\('orders'\)\s*\.update\(/.test(api), 'the API never writes the order row directly');
  ok(/getShippingCost\(validated\.customer\.city\)/.test(api), 'shipping is recomputed server-side');
  ok(/buildOrderStatusMessage\(updated, 'Edited'\)/.test(api),
    'the edit notification uses the short internal template');

  const sql = readFileSync(new URL('../supabase/atomic_edit_order.sql', import.meta.url), 'utf8');
  ok(/CREATE OR REPLACE FUNCTION public\.atomic_edit_order/.test(sql), 'SQL defines atomic_edit_order');
  ok(/FROM public\.orders WHERE id = p_id FOR UPDATE/.test(sql), 'SQL locks the order row FOR UPDATE');
  ok(/rev_conflict/.test(sql), 'SQL enforces the optimistic revision');
  ok(/items_locked/.test(sql), 'SQL enforces the item status gate');
  ok(/atomic_adjust_stock/.test(sql), 'SQL reconciles stock through the shared helper');
  ok(/FROM PUBLIC, anon, authenticated/.test(sql), 'SQL revokes execution from anon/authenticated');
  ok(/GRANT EXECUTE ON FUNCTION public\.atomic_edit_order[\s\S]*TO service_role/.test(sql),
    'SQL grants atomic_edit_order to service_role');
  const lockPos = sql.indexOf('FROM public.orders WHERE id = p_id FOR UPDATE');
  const stockPos = sql.indexOf('public.atomic_adjust_stock');
  ok(lockPos > 0 && stockPos > lockPos, 'the order is locked before products (deadlock-free)');

  const store = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  ok(/action: 'edit'/.test(store), 'the store sends the explicit edit action');
  ok(/expectedRev/.test(store), 'the store sends the optimistic revision');

  const admin = readFileSync(new URL('../src/pages/AdminApp.js', import.meta.url), 'utf8');
  ok(/function OrderEditModal/.test(admin), 'the dashboard has an order edit modal');
  ok(/changes\.items = form\.items\.map\(normalizeEditItem\)/.test(admin),
    'the modal sends item identifiers/quantities, not prices');
}

// ─── [2] request validation ─────────────────────────────────────────────────
console.log('\n[2] request validation');
{
  seed();
  const noRev = await call('PATCH', { id: 'ZSH-TEST-EDIT-1', action: 'edit', customer: CUSTOMER });
  eq(noRev.status, 400, 'a missing revision is rejected with 400');
  ok(/revision/i.test(noRev.body.error), 'the error mentions the revision');

  const badPhone = await call('PATCH', editBody({
    customer: { ...CUSTOMER, phone: '12345' },
  }));
  eq(badPhone.status, 422, 'an invalid phone is rejected with 422');
  ok(Array.isArray(badPhone.body.errors) && badPhone.body.errors.length > 0,
    'validation errors are returned as a list');

  const badCity = await call('PATCH', editBody({
    customer: { ...CUSTOMER, city: 'Atlantis' },
  }));
  eq(badCity.status, 422, 'an unknown governorate is rejected with 422');

  const tooMany = await call('PATCH', editBody({
    items: Array.from({ length: 31 }, () => ({ productId: 1, qty: 1, size: 'M', color: 'Black' })),
  }));
  eq(tooMany.status, 422, 'more than 30 items is rejected with 422');

  state.orders.clear();
  const missing = await call('PATCH', editBody());
  eq(missing.status, 404, 'an unknown order is a 404');
  ok(!state.rpcCalls.includes('atomic_edit_order'), 'no edit RPC is attempted for a missing order');
}

// ─── [3] optimistic revision ────────────────────────────────────────────────
console.log('\n[3] optimistic revision');
{
  seed({ rev: 2 });
  const stale = await call('PATCH', editBody({ expectedRev: 1 }));
  eq(stale.status, 409, 'a stale revision is rejected with 409');
  eq(stale.body.code, 'rev_conflict', 'the conflict carries a stable code');
  eq(stale.body.rev, 2, 'the current revision is returned');
  eq(state.orders.get('ZSH-TEST-EDIT-1').customer, 'Old Name', 'the stale edit wrote nothing');
  ok(!state.rpcCalls.includes('atomic_edit_order'), 'the stale edit never reaches the RPC');
}

// ─── [4] customer-only edit: no stock/coupon churn ──────────────────────────
console.log('\n[4] customer-only edit');
{
  seed();
  // An inactive coupon proves a customer-only edit does not re-validate it.
  state.coupons.get('SAVE10').active = false;
  const before = state.products.get(1).variantStock['M-Black'];

  const r = await call('PATCH', editBody());
  eq(r.status, 200, 'a customer-only edit succeeds');
  eq(r.body.success, true, 'the response reports success');
  eq(r.body.rev, 1, 'the revision advances to 1');
  eq(r.body.order.customer, 'New Name', 'the customer name is updated');
  eq(r.body.order.total, 245, 'the total keeps subtotal + shipping - discount');
  eq(state.products.get(1).variantStock['M-Black'], before, 'stock is untouched');
  eq(state.coupons.get('SAVE10').usageCount, 1, 'coupon usage is untouched');

  const patch = state.patches[state.patches.length - 1];
  ok(!Object.prototype.hasOwnProperty.call(patch, 'items'), 'the patch omits unchanged items');
  eq(patch.discount, 20, 'the existing discount is preserved');
  eq(patch.discountCode, 'SAVE10', 'the existing coupon code is preserved');
}

// ─── [5] item edits are repriced from the database ──────────────────────────
console.log('\n[5] authoritative item pricing');
{
  seed();
  const r = await call('PATCH', editBody({
    items: [
      { productId: 1, qty: 3, size: 'M', color: 'Black', unitPrice: 9999, price: 9999 },
      { productId: 2, qty: 1, size: '', color: '', unitPrice: 9999, price: 9999 },
    ],
  }));
  eq(r.status, 200, 'an item edit succeeds');
  const patch = state.patches[state.patches.length - 1];
  eq(patch.items[0].unitPrice, 100, 'the first line uses the database price');
  eq(patch.items[1].unitPrice, 150, 'the second line uses the sale price');
  ok(patch.items.every((item) => item.unitPrice !== 9999),
    'client-supplied prices are ignored');
  eq(patch.subtotal, 450, 'the subtotal is recomputed');
  eq(patch.discount, 45, 'the percentage discount follows the new subtotal');
  eq(patch.total, 470, 'shipping + discount produce the new total');
  eq(state.products.get(1).variantStock['M-Black'], 9, 'only the extra unit is deducted (10 → 9)');
  eq(state.products.get(2).stock, 4, 'the non-variant product is deducted once');
  eq(r.body.order.items.length, 2, 'the response contains the edited lines');
}

// ─── [6] stock is enforced by net difference ────────────────────────────────
console.log('\n[6] stock reconciliation');
{
  seed();
  const before = state.products.get(1).variantStock['M-Black'];
  const r = await call('PATCH', editBody({
    items: [{ productId: 1, qty: 20, size: 'M', color: 'Black' }],
  }));
  eq(r.status, 409, 'increasing beyond available stock is a 409');
  eq(r.body.code, 'unavailable', 'the rejection carries the unavailable code');
  eq(r.body.available, before, 'the available quantity is reported');
  eq(state.products.get(1).variantStock['M-Black'], before, 'no partial stock write survives');
  eq(state.orders.get('ZSH-TEST-EDIT-1').items[0].qty, 2, 'the stored items are unchanged');
}

// ─── [7] item status gate ───────────────────────────────────────────────────
console.log('\n[7] status gate');
{
  seed({ status: 'Shipped' });
  const locked = await call('PATCH', editBody({
    items: [{ productId: 1, qty: 1, size: 'M', color: 'Black' }],
  }));
  eq(locked.status, 422, 'items cannot be edited after shipment');
  eq(locked.body.code, 'items_locked', 'the rejection carries the items_locked code');
  eq(state.productLookups, 0, 'the product lookup is skipped when items are locked');

  const customer = await call('PATCH', editBody());
  eq(customer.status, 200, 'customer details stay editable after shipment');
  eq(customer.body.order.customer, 'New Name', 'the shipped order keeps its customer edit');
  eq(state.orders.get('ZSH-TEST-EDIT-1').status, 'Shipped', 'the status is not changed by an edit');
}

// ─── [8] coupon rules ───────────────────────────────────────────────────────
console.log('\n[8] coupon rules');
{
  seed();
  const unknown = await call('PATCH', editBody({ couponCode: 'NOPE' }));
  eq(unknown.status, 422, 'an unknown coupon is rejected');
  eq(unknown.body.code, 'coupon_unavailable', 'the rejection names coupon_unavailable');
  eq(state.coupons.get('SAVE10').usageCount, 1, 'the old coupon is not released on failure');
}
{
  seed();
  const removed = await call('PATCH', editBody({ couponCode: '' }));
  eq(removed.status, 200, 'removing the coupon succeeds');
  eq(removed.body.order.discount, 0, 'the discount is zero without a coupon');
  eq(removed.body.order.total, 265, 'the total is subtotal + shipping');
  eq(removed.body.order.discountCode, null, 'the order no longer references a coupon');
}
{
  // The order is currently below the coupon minimum after the item edit.
  seed({
    qty: 6, subtotal: 600, discount: 50, discountCode: 'MIN500', total: 615,
  });
  const r = await call('PATCH', editBody({
    items: [{ productId: 1, qty: 2, size: 'M', color: 'Black' }],
  }));
  eq(r.status, 422, 'an item edit that breaks the coupon minimum is rejected');
  eq(r.body.code, 'coupon_changed', 'the rejection names coupon_changed');
  eq(state.products.get(1).variantStock['M-Black'], 10, 'stock is untouched on coupon failure');
}
{
  // The order already consumed the last slot; keeping the SAME coupon must not
  // be rejected just because the counter is exhausted.
  seed({ exhausted: true });
  const r = await call('PATCH', editBody({
    items: [{ productId: 1, qty: 3, size: 'M', color: 'Black' }],
  }));
  eq(r.status, 200, 'keeping an exhausted coupon still succeeds');
  eq(r.body.order.discount, 30, 'the discount is recomputed for the new subtotal');
}

// ─── [9] RPC failure mapping ────────────────────────────────────────────────
console.log('\n[9] RPC failure mapping');
{
  const cases = [
    { result: { ok: false, reason: 'unavailable', available: 2 }, status: 409, code: 'unavailable' },
    { result: { ok: false, reason: 'rev_conflict', rev: 9 }, status: 409, code: 'rev_conflict' },
    { result: { ok: false, reason: 'items_locked', status: 'Delivered' }, status: 422, code: 'items_locked' },
    { result: { ok: false, reason: 'coupon_unavailable' }, status: 422, code: 'coupon_unavailable' },
    { result: { ok: false, reason: 'coupon_changed' }, status: 422, code: 'coupon_changed' },
    { result: { ok: false, reason: 'missing_product' }, status: 409, code: undefined },
    { result: { ok: false, reason: 'missing_variant' }, status: 409, code: undefined },
    { result: { ok: false, reason: 'invalid_payload' }, status: 400, code: undefined },
    { result: { ok: false, reason: 'not_found' }, status: 404, code: undefined },
    { result: { ok: false, reason: 'weird_failure' }, status: 500, code: undefined },
  ];
  for (const item of cases) {
    seed();
    state.rpcOverride = { data: item.result, error: null };
    const r = await call('PATCH', editBody());
    eq(r.status, item.status, `RPC ${item.result.reason} maps to ${item.status}`);
    if (item.code) eq(r.body.code, item.code, `RPC ${item.result.reason} carries ${item.code}`);
    eq(state.orders.get('ZSH-TEST-EDIT-1').customer, 'Old Name',
      `RPC ${item.result.reason} leaves the order unchanged`);
  }

  seed();
  state.rpcOverride = { data: null, error: { message: 'simulated failure' } };
  const failed = await call('PATCH', editBody());
  eq(failed.status, 500, 'a transport-level RPC error is a 500');
  ok(!/simulated failure/.test(JSON.stringify(failed.body)), 'the raw database error is not exposed');
}

// ─── [10] notification + legacy PATCH ───────────────────────────────────────
console.log('\n[10] notification + legacy status PATCH');
{
  seed();
  const r = await call('PATCH', editBody());
  eq(r.status, 200, 'the edit succeeds before the notification assertion');
  const sent = state.telegram[state.telegram.length - 1];
  ok(sent && /api\.telegram\.org/.test(sent.url), 'a Telegram notification is sent');
  const body = JSON.parse(sent.init.body);
  ok(/تم تعديل الطلب/.test(body.text), 'the notification is the edit template');
  ok(/تم تعديل البيانات/.test(body.text), 'the notification shows the edited status line');
  ok(!/السلام عليكم/.test(body.text), 'the customer confirmation greeting is not reused');
  ok(!/بيانات العميل/.test(body.text), 'the customer PII block is not reused');
  eq(body.parse_mode, undefined, 'the edit notification is plain text');
  ok(body.reply_markup && typeof body.reply_markup === 'object', 'the notification keeps action buttons');
  ok(!JSON.stringify(body.reply_markup).includes('wa=1'), 'the edit alert has no WhatsApp confirmation button');
}
{
  seed();
  const r = await call('PATCH', { id: 'ZSH-TEST-EDIT-1', status: 'Confirmed' });
  eq(r.status, 200, 'the legacy status-only PATCH still works');
  eq(state.orders.get('ZSH-TEST-EDIT-1').status, 'Confirmed', 'the status is written');
  eq(state.patches.length, 0, 'the status path does not call the edit RPC');
}

// ─── Summary ────────────────────────────────────────────────────────────────
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
