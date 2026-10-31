/**
 * Group B — coupon pricing + inactive-product tests.
 *
 *   node scripts/test-order-pricing.mjs
 *
 * Drives the REAL api/orders.js handler through a fake Supabase client, so the
 * assertions cover the actual request path (validation → product lookup →
 * coupon pricing → atomic_place_order payload). The database function cannot be
 * executed here (no SQL channel), so the suite also statically proves the RPC
 * enforces the same rules under a row lock.
 *
 * Covers SEC-06 (minOrderAmount / maxDiscount / discountValue, one pricing
 * source of truth) and SEC-11 (active === false is never sellable).
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

// Same canonical signature as public.zshm_order_signature().
function orderSignature(items) {
  let list = items;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (e) { list = []; }
  }
  if (!Array.isArray(list)) return '';
  return list
    .map((it) => `${it.productId}:${it.qty}:${it.size || ''}:${it.color || ''}`)
    .sort()
    .join('|');
}

// ─── Fake database ───────────────────────────────────────────────────────────
function makeDb() {
  const state = {
    products: new Map(),
    coupons: new Map(),
    ordersById: new Map(),
    ordersByKey: new Map(),
    rpcCalls: [],
    rpcResult: null,
    // When set, the next two atomic_place_order calls both pass the "fast"
    // idempotency check before either INSERTs — modelling the real race where
    // two requests lock different products and only meet at the UNIQUE index.
    raceBarrier: 0,
    raceWaiters: [],
    raceGate: null,
  };

  function seed({
    stock = 10,
    reservedStock = 0,
    active = true,
    coupon = null,
  } = {}) {
    state.products.clear();
    state.coupons.clear();
    state.ordersById.clear();
    state.ordersByKey.clear();
    state.rpcCalls = [];
    state.rpcResult = null;
    state.raceBarrier = 0;
    state.raceWaiters = [];
    state.raceGate = null;
    state.products.set(1, {
      id: 1,
      name: 'Test Piece',
      category: 'Dresses',
      price: 100,
      salePrice: null,
      stock,
      reservedStock,
      variantStock: {},
      active,
      images: [],
    });
    if (coupon) state.coupons.set(coupon.code, coupon);
  }

  function couponRow(over = {}) {
    return {
      code: 'SAVE10',
      type: 'percentage',
      value: 10,
      discountValue: 10,
      minOrderAmount: null,
      maxDiscount: null,
      active: true,
      startDate: '2020-01-01',
      endDate: '2099-12-31',
      usageLimit: 100,
      usageCount: 0,
      ...over,
    };
  }

  const sb = {
    from(table) {
      const q = {
        _ids: null,
        _filter: null,
        select() { return q; },
        in(col, vals) { q._ids = (vals || []).map(Number); return q; },
        eq(col, val) { q._filter = { col, val }; return q; },
        order() { return q; },
        async maybeSingle() {
          await sleep(1);
          let rows = [];
          if (table === 'products') rows = [...state.products.values()];
          if (table === 'coupons') rows = [...state.coupons.values()];
          if (table === 'orders') rows = [...state.ordersById.values()];
          const row = rows.find((r) =>
            q._filter ? String(r[q._filter.col]) === String(q._filter.val) : false
          );
          return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
        },
        then(resolve, reject) {
          const run = (async () => {
            await sleep(1);
            if (table === 'products') {
              const rows = [...state.products.values()]
                .filter((p) => !q._ids || q._ids.includes(Number(p.id)));
              return { data: JSON.parse(JSON.stringify(rows)), error: null };
            }
            return { data: [], error: null };
          })();
          return run.then(resolve, reject);
        },
      };
      return q;
    },

    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      if (name !== 'atomic_place_order') {
        return { data: { ok: false, reason: 'unexpected_rpc' }, error: null };
      }
      if (state.rpcResult) return { data: state.rpcResult, error: null };

      const order = args.p_order;
      const key = args.p_idempotency_key;
      const sig = orderSignature(order.items);

      function existingResult() {
        const winner = key ? state.ordersByKey.get(key) : null;
        if (!winner) return null;
        if (winner.sig === sig) {
          return { data: { ok: true, duplicate: true, orderId: winner.orderId }, error: null };
        }
        return { data: { ok: false, reason: 'idempotency_conflict', orderId: winner.orderId }, error: null };
      }

      // Fast path: the first request already committed.
      const fast = existingResult();
      if (fast) return fast;

      // Model two requests that passed the pre-lock checks together. Both reach
      // the INSERT; the UNIQUE index lets exactly one win.
      if (state.raceBarrier > 0) {
        await new Promise((resolve) => {
          state.raceWaiters.push(resolve);
          if (state.raceWaiters.length >= state.raceBarrier) {
            const waiters = state.raceWaiters;
            state.raceWaiters = [];
            state.raceBarrier = 0;
            waiters.forEach((release) => release());
          }
        });
      }

      // The unique-key loser re-reads the committed row (SQL EXCEPTION handler).
      const raced = existingResult();
      if (raced) return raced;

      if (state.ordersById.has(order.id)) {
        return { data: { ok: false, reason: 'order_id_collision' }, error: null };
      }

      // Successful INSERT: coupon usage and stock are written only now.
      state.ordersById.set(order.id, JSON.parse(JSON.stringify(order)));
      if (key) state.ordersByKey.set(key, { orderId: order.id, sig });
      if (order.discountCode) {
        const coupon = state.coupons.get(order.discountCode);
        if (coupon) coupon.usageCount = Number(coupon.usageCount || 0) + 1;
      }
      for (const item of order.items || []) {
        const p = state.products.get(Number(item.productId));
        if (p) p.stock = Math.max(0, Number(p.stock || 0) - Number(item.qty || 0));
      }
      return { data: { ok: true, orderId: order.id }, error: null };
    },
  };

  return { state, sb, seed, couponRow };
}

// ─── Boot the real handler against the fake client ───────────────────────────
process.env.SESSION_SECRET = 'test-session-secret-for-order-pricing-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const { state, sb, seed, couponRow } = makeDb();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => sb };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
const cachedClient = lib.supabaseAdmin();
const handler = require('../api/orders.js');
Module._load = originalLoad;
if (cachedClient !== sb) {
  console.error('FAIL: fake Supabase client was not injected');
  process.exit(1);
}

let ipCounter = 1;
function makeReq(body) {
  const text = JSON.stringify(body);
  const listeners = {};
  let started = false;
  const req = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipCounter++ % 250) + 1}`,
      origin: 'https://za-shm.vercel.app',
    },
    query: {},
    socket: { remoteAddress: '198.51.100.1' },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (started) {
        if (event === 'data') setImmediate(() => cb(Buffer.from(text)));
        if (event === 'end') setImmediate(() => cb());
      }
      return req;
    },
    destroy() {},
  };
  setImmediate(() => {
    started = true;
    (listeners.data || []).forEach((cb) => cb(Buffer.from(text)));
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

const BASE_BODY = () => ({
  items: [{ productId: 1, qty: 2, size: 'M', color: 'Black', price: 1 }],
  customer: {
    name: 'Test Shopper',
    phone: '01012345678',
    address: '123 Test Street, Apt 4',
    city: 'Cairo',
    date: '2026-10-31',
  },
});

async function place({ coupon, ...overrides } = {}) {
  const body = { ...BASE_BODY(), ...overrides };
  if (coupon) body.couponCode = coupon;
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

const rpcOrder = () => {
  const call = state.rpcCalls.find((c) => c.name === 'atomic_place_order');
  return call ? call.args.p_order : null;
};

// ─── [1] static contract ─────────────────────────────────────────────────────
console.log('\n[1] static checks: the pricing rule has one source of truth');
{
  const libSrc = readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8');
  ok(/function computeCouponDiscount/.test(libSrc), '_lib.js owns computeCouponDiscount');
  ok(/function couponDiscountValue/.test(libSrc), '_lib.js owns the value/discountValue alias');
  ok(/function couponIsRedeemable/.test(libSrc), '_lib.js owns the redeemability rule');

  const ordersSrc = readFileSync(new URL('../api/orders.js', import.meta.url), 'utf8');
  ok(/couponIsRedeemable\(c, today\)/.test(ordersSrc), 'orders.js uses the shared redeemability rule');
  ok(/computeCouponDiscount\(c, subtotal\)/.test(ordersSrc), 'orders.js uses the shared pricing rule');
  ok(/p\.active === false/.test(ordersSrc), 'orders.js rejects inactive products (SEC-11)');
  ok(/reason === 'inactive_product'/.test(ordersSrc), 'orders.js maps inactive_product to 422');
  ok(/reason === 'coupon_changed'/.test(ordersSrc), 'orders.js maps coupon_changed to 409');
  ok(!/Number\(couponRow\.value\)/.test(ordersSrc), 'orders.js never reads value directly');

  const sql = readFileSync(new URL('../supabase/atomic_place_order.sql', import.meta.url), 'utf8');
  ok(/FROM public\.coupons[\s\S]*FOR UPDATE/.test(sql), 'RPC locks the coupon row FOR UPDATE');
  ok(/coupon_changed/.test(sql), 'RPC rejects a mismatched discount');
  ok(/inactive_product/.test(sql), 'RPC rejects inactive products');
  ok(/"minOrderAmount"::numeric/.test(sql), 'RPC applies minOrderAmount');
  ok(/"maxDiscount"::numeric/.test(sql), 'RPC applies maxDiscount');
  ok(/"discountValue"::numeric/.test(sql), 'RPC reads the legacy discountValue alias');
  ok(/round\(v_subtotal \* v_coupon_value \/ 100\)/.test(sql), 'RPC mirrors the percentage rounding');

  // Idempotency race contract (REVISION 6).
  const uniquePos = sql.indexOf('EXCEPTION WHEN unique_violation');
  const sigAfterUnique = sql.indexOf('zshm_order_signature', uniquePos);
  ok(uniquePos > 0 && sigAfterUnique > uniquePos,
    'unique_violation handler compares the cart signature before answering');
  ok(/idempotency_conflict/.test(sql.slice(uniquePos, sql.indexOf('-- Coupon consumption happens'))),
    'unique_violation handler can return idempotency_conflict');
  const insertPos = sql.indexOf('INSERT INTO public.orders (');
  const couponWritePos = sql.indexOf('IF v_coupon.code IS NOT NULL THEN');
  ok(insertPos > 0 && couponWritePos > insertPos,
    'coupon usageCount is written AFTER the order INSERT succeeds');
  ok(!/UPDATE public\.coupons[\s\S]{0,120}"usageCount" = COALESCE\("usageCount", 0\) \+ 1/.test(
    sql.slice(0, insertPos)
  ), 'no coupon increment happens before the INSERT');
}

// ─── [2] SEC-11: inactive product ────────────────────────────────────────────
console.log('\n[2] SEC-11: inactive product');
{
  seed({ active: false });
  const r = await place();
  eq(r.status, 422, 'inactive product → 422');
  eq(state.rpcCalls.length, 0, 'no order RPC is attempted');
  eq(r.body.stockIssues[0].missing, true, 'client is told to remove the item');
}

// ─── [3] baseline: DB price wins, no coupon ─────────────────────────────────
console.log('\n[3] baseline totals');
{
  seed();
  const r = await place();
  eq(r.status, 200, 'order succeeds');
  const sent = rpcOrder();
  eq(sent.subtotal, 200, 'subtotal uses the DB price (2 × 100), not the client price');
  eq(sent.discount, 0, 'no coupon ⇒ 0 discount');
  eq(sent.total, 265, 'total = 200 + 65 Cairo shipping');
  eq(sent.items[0].price, 200, 'line price is server-computed');
}

// ─── [4] percentage / cap / fixed matrix ────────────────────────────────────
console.log('\n[4] SEC-06: pricing matrix');
{
  seed({ coupon: couponRow({ type: 'percentage', value: 10 }) });
  let r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'plain percentage accepted');
  eq(rpcOrder().discount, 20, '10% of 200 = 20');

  seed({ coupon: couponRow({ type: 'percentage', value: 10, maxDiscount: 5 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'capped percentage accepted');
  eq(rpcOrder().discount, 5, 'maxDiscount caps the percentage');

  seed({ coupon: couponRow({ type: 'fixed', value: 250 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(rpcOrder().discount, 200, 'fixed discount is capped at the subtotal');

  seed({ coupon: couponRow({ type: 'fixed', value: 50, maxDiscount: 30 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(rpcOrder().discount, 30, 'maxDiscount also caps a fixed coupon');

  seed({ coupon: couponRow({ type: 'fixed', value: 50, discountValue: 40 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(rpcOrder().discount, 50, 'value wins when both columns are present');

  seed({ coupon: couponRow({ type: 'fixed', value: null, discountValue: 25 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'discountValue-only row accepted');
  eq(rpcOrder().discount, 25, 'discountValue is used when value is missing');

  seed({ coupon: couponRow({ type: 'percentage', value: 150 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'corrupt >100% row still yields a safe price');
  eq(rpcOrder().discount, 200, 'discount never exceeds the subtotal');
}

// ─── [5] SEC-06: minimum order amount ───────────────────────────────────────
console.log('\n[5] SEC-06: minOrderAmount');
{
  seed({ coupon: couponRow({ minOrderAmount: 500 }) });
  let r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'subtotal below the minimum → 422 (never a silent full price)');
  eq(state.rpcCalls.length, 0, 'no order is written');
  eq(r.body.reason, 'min_order_amount', 'reason is reported for diagnostics');

  seed({ coupon: couponRow({ minOrderAmount: 150 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'subtotal above the minimum accepted');
  eq(rpcOrder().discount, 20, 'discount applied normally');

  seed({ coupon: couponRow({ minOrderAmount: 200 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 200, 'exactly at the minimum accepted');
}

// ─── [6] unusable coupons are rejected, never ignored ───────────────────────
console.log('\n[6] unusable coupon');
{
  seed({ coupon: couponRow({ active: false }) });
  let r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'inactive coupon → 422');

  seed({ coupon: couponRow({ startDate: '2020-01-01', endDate: '2020-01-02' }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'expired coupon → 422');

  seed({ coupon: couponRow({ usageCount: 100, usageLimit: 100 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'exhausted coupon → 422');

  seed({ coupon: couponRow({ usageLimit: 0, usageCount: 0 }) });
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'usageLimit 0 → 422');

  seed();
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'unknown coupon → 422');
}

// ─── [7] RPC is the final authority ─────────────────────────────────────────
console.log('\n[7] RPC reasons are mapped to safe HTTP responses');
{
  seed({ coupon: couponRow() });
  state.rpcResult = { ok: false, reason: 'coupon_changed', discount: 5 };
  let r = await place({ coupon: 'SAVE10' });
  eq(r.status, 409, 'coupon_changed → 409 (refresh the bag)');

  state.rpcResult = { ok: false, reason: 'coupon_unavailable' };
  r = await place({ coupon: 'SAVE10' });
  eq(r.status, 422, 'coupon_unavailable → 422');

  state.rpcResult = { ok: false, reason: 'inactive_product', productId: 1 };
  r = await place();
  eq(r.status, 422, 'inactive_product → 422');
  eq(r.body.stockIssues[0].productId, 1, 'the offending product is reported');

  state.rpcResult = { ok: false, reason: 'missing_product', productId: 1 };
  r = await place();
  eq(r.status, 422, 'missing_product → 422');
  eq(r.body.stockIssues[0].missing, true, 'missing product is reported');
}

// ─── [8] stock availability, including reservedStock ────────────────────────
console.log('\n[8] stock availability');
{
  seed({ stock: 1 });
  let r = await place();
  eq(r.status, 422, 'requesting 2 with stock 1 → 422');
  eq(state.rpcCalls.length, 0, 'no order written for an unavailable line');

  seed({ stock: 5, reservedStock: 4 });
  r = await place();
  eq(r.status, 422, 'reservedStock is subtracted from availability');

  seed({ stock: 2, reservedStock: 0 });
  r = await place();
  eq(r.status, 200, 'exactly available stock accepted');

  // Products WITHOUT variants share one global pool: split lines across
  // sizes/colors must be summed before validation (mirrors the RPC).
  seed({ stock: 5, reservedStock: 0 });
  r = await place({
    items: [
      { productId: 1, qty: 3, size: 'M', color: 'Black', price: 1 },
      { productId: 1, qty: 3, size: 'L', color: 'White', price: 1 },
    ],
  });
  eq(r.status, 422, 'non-variant split lines are aggregated (6 > 5) → 422');
  eq(state.rpcCalls.length, 0, 'no order RPC is attempted for the aggregated oversell');

  seed({ stock: 6, reservedStock: 0 });
  r = await place({
    items: [
      { productId: 1, qty: 3, size: 'M', color: 'Black', price: 1 },
      { productId: 1, qty: 3, size: 'L', color: 'White', price: 1 },
    ],
  });
  eq(r.status, 200, 'non-variant split lines within stock are accepted');
  eq(rpcOrder().items.length, 2, 'both cart lines are preserved for the RPC');

  // Variant products are aggregated per variant, not per size/color line.
  seed({ stock: 5 });
  state.products.get(1).variantStock = { 'M-Black': 5 };
  r = await place({
    items: [
      { productId: 1, qty: 3, size: 'M', color: 'Black', price: 1 },
      { productId: 1, qty: 3, size: 'M', color: 'Black', price: 1 },
    ],
  });
  eq(r.status, 422, 'duplicate variant lines are aggregated (6 > 5) → 422');
  eq(state.rpcCalls.length, 0, 'no order RPC is attempted for the variant oversell');
}

// ─── [9] idempotency race: one key, two carts, one coupon ──────────────────
console.log('\n[9] idempotency race: same key + different carts + coupon');
{
  const makeSecondProduct = () => {
    const second = JSON.parse(JSON.stringify(state.products.get(1)));
    second.id = 2;
    second.name = 'Second Piece';
    state.products.set(2, second);
  };
  const key = 'race-key-different-carts';
  const cartA = [{ productId: 1, qty: 2, size: 'M', color: 'Black', price: 1 }];
  const cartB = [{ productId: 2, qty: 1, size: 'L', color: 'White', price: 1 }];

  seed({ coupon: couponRow({ usageLimit: 100, usageCount: 0 }) });
  makeSecondProduct();
  state.raceBarrier = 2; // both requests pass the pre-INSERT check together
  const [a, b] = await Promise.all([
    place({ items: cartA, idempotencyKey: key, coupon: 'SAVE10' }),
    place({ items: cartB, idempotencyKey: key, coupon: 'SAVE10' }),
  ]);

  eq([a.status, b.status].sort(), [200, 409], 'exactly one request wins; the other is a conflict');
  eq([a.body.duplicate, b.body.duplicate].filter(Boolean).length, 0,
    'a different cart is NEVER reported as duplicate=true');
  eq(state.coupons.get('SAVE10').usageCount, 1, 'coupon usageCount moved exactly once');

  const winner = a.status === 200 ? a : b;
  const winnerProduct = Number(winner.body.order.items[0].productId);
  const loserProduct = winnerProduct === 1 ? 2 : 1;
  eq(state.products.get(winnerProduct).stock, winnerProduct === 1 ? 8 : 9,
    'only the winning cart decremented its product');
  eq(state.products.get(loserProduct).stock, 10, 'the losing cart did not touch stock');

  // Replaying the same key with yet another cart stays a conflict and does not
  // consume the coupon again.
  const replay = await place({
    items: [{ productId: 2, qty: 3, size: 'S', color: 'Red', price: 1 }],
    idempotencyKey: key,
    coupon: 'SAVE10',
  });
  eq(replay.status, 409, 'same key + different cart is rejected on replay');
  eq(state.coupons.get('SAVE10').usageCount, 1, 'replay does not consume the coupon');
}

// ─── [10] idempotency race: same key + same cart returns duplicate once ─────
console.log('\n[10] idempotency race: same key + same cart + coupon');
{
  const key = 'race-key-same-cart';
  const cart = [{ productId: 1, qty: 2, size: 'M', color: 'Black', price: 1 }];

  seed({ coupon: couponRow({ usageLimit: 100, usageCount: 0 }) });
  state.raceBarrier = 2;
  const [a, b] = await Promise.all([
    place({ items: cart, idempotencyKey: key, coupon: 'SAVE10' }),
    place({ items: cart, idempotencyKey: key, coupon: 'SAVE10' }),
  ]);

  eq([a.status, b.status].sort(), [200, 200], 'both requests return 200');
  eq([a.body.duplicate, b.body.duplicate].filter((v) => v === true).length, 1,
    'exactly one request is marked duplicate');
  eq(state.coupons.get('SAVE10').usageCount, 1, 'the retry did not consume the coupon twice');
  eq(state.products.get(1).stock, 8, 'stock was decremented exactly once');
  eq(state.ordersByKey.size, 1, 'only one order row exists for the key');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
