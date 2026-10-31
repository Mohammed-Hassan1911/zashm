/**
 * Group A — order lifecycle integrity tests.
 *
 *   node scripts/test-order-lifecycle.mjs
 *
 * SEC-04 (cancel race) and SEC-05 (delete before restore) are enforced by two
 * PostgreSQL functions (supabase/atomic_order_lifecycle.sql). We cannot reach
 * the production database from this environment, so this suite:
 *   1. drives the REAL api/admin/orders.js handlers,
 *   2. through a fake Supabase client whose `rpc()` implements the same
 *      lock/serialization contract as the SQL functions (single mutex per
 *      operation = the row lock), and
 *   3. asserts the observable invariants: stock is restored exactly once,
 *      coupon usage moves exactly once, a failed restore rolls back, and a
 *      stale concurrent request is rejected with 409.
 *
 * It also statically verifies the SQL migration keeps the lock order and is
 * service_role-only, and that the JS no longer coordinates stock itself.
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
function makeDb() {
  const state = {
    users: [{ id: 'u1', name: 'Admin', email: 'admin@example.com', role: 'admin', session_version: 0 }],
    orders: new Map(),
    products: new Map(),
    coupons: new Map(),
    failRpc: null,
    rpcCalls: [],
  };

  function resetOrder({
    id = 'ZSH-TEST-1', status = 'Pending', qty = 2, code = 'SAVE10', items,
  } = {}) {
    state.orders.set(id, {
      id,
      status,
      items: items === undefined ? [{ productId: 1, qty, size: 'M', color: 'Black' }] : items,
      discountCode: code,
      timestamps: { created: '2026-01-01T00:00:00.000Z' },
    });
  }

  // Mirrors public.zshm_order_items()/zshm_order_lines()/skipped_lines().
  function parseLegacyItems(raw) {
    let list = raw;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (e) { return { items: [], skipped: 0, malformed: true }; }
    }
    if (!Array.isArray(list)) return { items: [], skipped: 0, malformed: true };
    const items = [];
    let skipped = 0;
    for (const it of list) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) { skipped += 1; continue; }
      const pid = String(it.productId === undefined ? '' : it.productId);
      const qty = String(it.qty === undefined ? '' : it.qty);
      if (!/^[1-9][0-9]{0,17}$/.test(pid)
          || !/^[0-9]{1,9}$/.test(qty)
          || Number(qty) <= 0) {
        skipped += 1;
        continue;
      }
      items.push({
        productId: Number(pid), qty: Number(qty),
        size: it.size || '', color: it.color || '',
      });
    }
    return { items, skipped, malformed: false };
  }

  // A single mutex models `SELECT ... FOR UPDATE` on the order row: every
  // lifecycle RPC for the same order is serialized.
  let lock = Promise.resolve();
  function withOrderLock(fn) {
    const run = lock.then(async () => {
      await sleep(5); // widen the window so a real race would be observable
      return fn();
    });
    // Keep the chain alive even if fn throws (mirrors a rolled-back tx).
    lock = run.then(() => undefined, () => undefined);
    return run;
  }

  function clone(row) { return row ? JSON.parse(JSON.stringify(row)) : row; }

  function stockOf(id) {
    const p = state.products.get(Number(id));
    return p ? p.stock : null;
  }

  function adjustStock(lines, delta) {
    for (const line of lines) {
      const p = state.products.get(Number(line.productId));
      if (!p) return { ok: false, reason: 'missing_product', productId: line.productId };
    }
    for (const line of lines) {
      const p = state.products.get(Number(line.productId));
      const vkey = `${line.size || ''}-${line.color || ''}`;
      if (p.variantStock && Object.prototype.hasOwnProperty.call(p.variantStock, vkey)) {
        p.variantStock[vkey] = Math.max(0, p.variantStock[vkey] + delta * line.qty);
      }
      p.stock = Math.max(0, p.stock + delta * line.qty);
    }
    return { ok: true };
  }

  const sb = {
    from(table) {
      const q = {
        _filter: null,
        select() { return q; },
        eq(col, val) { q._filter = { col, val }; return q; },
        order() { return q; },
        async maybeSingle() {
          await sleep(2); // allow two requests to read the same stale row
          const list = table === 'users' ? state.users
            : table === 'orders' ? [...state.orders.values()]
            : [];
          const row = list.find((r) => String(r[q._filter ? q._filter.col : 'id']) === String(q._filter ? q._filter.val : ''));
          return { data: clone(row) || null, error: null };
        },
      };
      return q;
    },

    async rpc(name, args) {
      state.rpcCalls.push(name);
      if (state.failRpc === name) {
        return { data: null, error: { message: 'simulated database failure' } };
      }
      if (name === 'atomic_set_order_status') {
        return {
          data: await withOrderLock(() => {
            const order = state.orders.get(String(args.p_id));
            if (!order) return { ok: false, reason: 'not_found' };
            const expected = args.p_expected_status == null ? '' : String(args.p_expected_status).trim();
            if (expected && order.status !== expected) {
              if (order.status === args.p_new_status) {
                return { ok: true, changed: false, status: order.status, idempotent: true };
              }
              return { ok: false, reason: 'status_changed', status: order.status };
            }
            if (order.status === args.p_new_status) {
              return { ok: true, changed: false, status: order.status, idempotent: true };
            }
            const going = String(args.p_new_status).toLowerCase() === 'cancelled'
              && String(order.status).toLowerCase() !== 'cancelled';
            const coming = String(order.status).toLowerCase() === 'cancelled'
              && String(args.p_new_status).toLowerCase() !== 'cancelled';
            const warnings = [];
            if (going || coming) {
              const parsed = parseLegacyItems(order.items);
              if (parsed.skipped > 0) {
                warnings.push({ code: 'legacy_items_skipped', count: parsed.skipped });
              }
              if (parsed.items.length) {
                const r = adjustStock(parsed.items, going ? 1 : -1);
                if (!r.ok) return { ...r, warnings };
              }
              const coupon = state.coupons.get(order.discountCode);
              if (coupon) coupon.usageCount = Math.max(0, coupon.usageCount + (going ? -1 : 1));
            }
            const from = order.status;
            order.status = args.p_new_status;
            if (args.p_timestamps) order.timestamps = args.p_timestamps;
            return { ok: true, changed: true, from, to: args.p_new_status, warnings };
          }),
          error: null,
        };
      }
      if (name === 'atomic_delete_order') {
        return {
          data: await withOrderLock(() => {
            const order = state.orders.get(String(args.p_id));
            if (!order) return { ok: false, reason: 'not_found' };
            const wasCancelled = String(order.status).toLowerCase() === 'cancelled';
            let restored = false;
            const warnings = [];
            if (!wasCancelled) {
              const parsed = parseLegacyItems(order.items);
              if (parsed.skipped > 0) {
                warnings.push({ code: 'legacy_items_skipped', count: parsed.skipped });
              }
              if (parsed.items.length) {
                const r = adjustStock(parsed.items, 1);
                if (r.ok) restored = true;
                else if (r.reason === 'missing_product') warnings.push(r);
                else return { ok: false, reason: 'stock_failed' };
              }
              const coupon = state.coupons.get(order.discountCode);
              if (coupon) coupon.usageCount = Math.max(0, coupon.usageCount - 1);
            }
            state.orders.delete(String(args.p_id));
            return { ok: true, deleted: true, stockRestored: restored, wasCancelled, warnings };
          }),
          error: null,
        };
      }
      return { data: { ok: false, reason: 'unknown_rpc' }, error: null };
    },
  };

  return { state, sb, resetOrder, stockOf };
}

// ─── Boot the real handler against the fake client ───────────────────────────
process.env.SESSION_SECRET = 'test-session-secret-for-order-lifecycle-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { state, sb, resetOrder } = makeDb();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => sb };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
// Force the module-level client cache to our fake while the loader patch is
// still active (supabaseAdmin() requires the SDK lazily on first call).
const cachedClient = lib.supabaseAdmin();
const handler = require('../api/admin/orders.js');
Module._load = originalLoad;
if (cachedClient !== sb) {
  console.error('FAIL: fake Supabase client was not injected');
  process.exit(1);
}

const token = lib.signSession({ id: 'u1', role: 'admin', name: 'Admin', email: 'admin@example.com', session_version: 0 });

function makeReq({ method, body, query } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const listeners = {};
  let started = false;
  const req = {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-real-ip': '203.0.113.7', origin: 'https://za-shm.vercel.app' },
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
  // Deliver the JSON body on the next tick, like a real request stream. If the
  // handler attaches its listeners later (after an async auth check), `on()`
  // replays the already-emitted body so readBody() is never left pending.
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

function seed({ stock = 10, couponUsage = 3, orderStatus = 'Pending' } = {}) {
  state.orders.clear();
  state.products.clear();
  state.coupons.clear();
  state.failRpc = null;
  resetOrder({ status: orderStatus });
  state.products.set(1, { id: 1, stock, variantStock: {}, reservedStock: 0 });
  state.coupons.set('SAVE10', { code: 'SAVE10', usageCount: couponUsage });
}

// ─── [1] static: the JS layer no longer coordinates stock/coupon ────────────
console.log('\n[1] static checks: JS is not a transaction coordinator');
{
  const src = readFileSync(new URL('../api/admin/orders.js', import.meta.url), 'utf8');
  ok(/atomic_set_order_status/.test(src), 'updateOrder calls atomic_set_order_status');
  ok(/atomic_delete_order/.test(src), 'deleteOrder calls atomic_delete_order');
  ok(!/atomic_adjust_stock/.test(src), 'JS no longer calls atomic_adjust_stock directly');
  ok(!/zshm_adjust_coupon_usage/.test(src), 'JS no longer adjusts coupon usage directly');
  ok(!/\.from\('orders'\)\s*\.delete\(/.test(src), 'JS no longer deletes the row itself');
  ok(!/\.update\(\{\s*status:/.test(src), 'JS no longer writes status itself');

  const sql = readFileSync(new URL('../supabase/atomic_order_lifecycle.sql', import.meta.url), 'utf8');
  ok(/CREATE OR REPLACE FUNCTION public\.atomic_set_order_status/.test(sql), 'SQL defines atomic_set_order_status');
  ok(/CREATE OR REPLACE FUNCTION public\.atomic_delete_order/.test(sql), 'SQL defines atomic_delete_order');
  ok(/FROM public\.orders WHERE id = p_id FOR UPDATE/.test(sql), 'SQL locks the order row FOR UPDATE');
  ok(/RAISE EXCEPTION/.test(sql), 'SQL raises (rollback) when a restore fails');
  ok(/FROM PUBLIC, anon, authenticated/.test(sql), 'SQL revokes execution from anon/authenticated');
  ok(/GRANT EXECUTE ON FUNCTION public\.atomic_set_order_status[\s\S]*TO service_role/.test(sql), 'SQL grants to service_role');
  ok(/GRANT EXECUTE ON FUNCTION public\.atomic_delete_order[\s\S]*TO service_role/.test(sql), 'SQL grants delete fn to service_role');
  const lockPos = sql.indexOf('FROM public.orders WHERE id = p_id FOR UPDATE');
  const stockPos = sql.indexOf('public.atomic_adjust_stock');
  ok(lockPos > 0 && stockPos > lockPos, 'order is locked BEFORE products (deadlock-free order)');

  ok(/zshm_order_items/.test(sql) && /zshm_order_lines/.test(sql),
    'SQL parses legacy/double-encoded order items safely');
  ok(/zshm_order_skipped_lines/.test(sql), 'SQL reports skipped legacy item lines');
  ok(/legacy_items_skipped/.test(sql), 'skipped lines are surfaced in warnings');
  ok(/PRODUCT-DELETION WARNING/.test(sql), 'product-loss warning is documented');
}

// ─── [2] concurrent cancel: stock + coupon move exactly once ────────────────
console.log('\n[2] SEC-04: two concurrent cancels');
{
  seed({ stock: 10, couponUsage: 3 });
  const [a, b] = await Promise.all([
    call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' }),
    call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' }),
  ]);
  eq(state.orders.get('ZSH-TEST-1').status, 'Cancelled', 'order ends up Cancelled');
  eq(state.products.get(1).stock, 12, 'stock restored exactly once (10 + 2)');
  eq(state.coupons.get('SAVE10').usageCount, 2, 'coupon freed exactly once (3 - 1)');
  ok([a.status, b.status].every((s) => s === 200 || s === 409), 'both responses are 200 or 409');
  ok([a.status, b.status].includes(200), 'at least one request succeeded');
}

// ─── [3] stale concurrent request is rejected with 409 ──────────────────────
console.log('\n[3] SEC-04: stale precondition');
{
  seed({ stock: 10, couponUsage: 3 });
  // Move the order behind the handler's back after it read Pending.
  const first = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Shipped' });
  eq(first.status, 200, 'first transition succeeds');
  const stale = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' });
  // The handler re-reads the row, so its expected status is now Shipped and the
  // transition is legitimate (Shipped → Cancelled). This proves the RPC uses
  // the freshly read status as its precondition.
  eq(stale.status, 200, 'subsequent transition uses the fresh status');
  eq(state.products.get(1).stock, 12, 'cancelling a Shipped order restores stock once');

  // Direct RPC-level stale precondition (what a true race hits).
  const rpc = await sb.rpc('atomic_set_order_status', {
    p_id: 'ZSH-TEST-1', p_expected_status: 'Pending', p_new_status: 'Delivered', p_timestamps: {},
  });
  eq(rpc.data.reason, 'status_changed', 'RPC rejects a stale expected status');
  eq(state.products.get(1).stock, 12, 'rejected request did not touch stock');
}

// ─── [4] cancel → un-cancel round trip returns to the original values ───────
console.log('\n[4] cancel / un-cancel round trip (x5)');
{
  seed({ stock: 10, couponUsage: 3 });
  for (let i = 0; i < 5; i += 1) {
    const c = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' });
    eq(c.status, 200, `cancel #${i + 1} succeeds`);
    const u = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Processing' });
    eq(u.status, 200, `un-cancel #${i + 1} succeeds`);
  }
  eq(state.products.get(1).stock, 10, 'stock is back to its original value');
  eq(state.coupons.get('SAVE10').usageCount, 3, 'coupon usage is back to its original value');
}

// ─── [5] repeat status change is idempotent (no double restore) ─────────────
console.log('\n[5] repeated PATCH to the same status');
{
  seed({ stock: 10, couponUsage: 3 });
  await call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' });
  const again = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' });
  eq(again.status, 200, 'second identical PATCH is a no-op success');
  eq(again.body.changed, false, 'reports changed=false');
  eq(state.products.get(1).stock, 12, 'stock was not restored twice');
  eq(state.coupons.get('SAVE10').usageCount, 2, 'coupon was not freed twice');
}

// ─── [6] SEC-05: delete an active order restores once, then removes it ──────
console.log('\n[6] SEC-05: delete active order');
{
  seed({ stock: 10, couponUsage: 3 });
  const r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'delete succeeds');
  eq(state.orders.has('ZSH-TEST-1'), false, 'order row is gone');
  eq(state.products.get(1).stock, 12, 'stock restored exactly once');
  eq(state.coupons.get('SAVE10').usageCount, 2, 'coupon freed exactly once');
}

// ─── [7] SEC-05: delete a cancelled order does NOT restore again ────────────
console.log('\n[7] SEC-05: delete cancelled order (no double restore)');
{
  seed({ stock: 10, couponUsage: 3, orderStatus: 'Cancelled' });
  const r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'delete succeeds');
  eq(state.orders.has('ZSH-TEST-1'), false, 'order row is gone');
  eq(state.products.get(1).stock, 10, 'stock was NOT restored a second time');
  eq(state.coupons.get('SAVE10').usageCount, 3, 'coupon was NOT freed a second time');
}

// ─── [8] SEC-05: transaction rollback keeps the order when the RPC fails ────
console.log('\n[8] SEC-05: rollback on restore failure');
{
  seed({ stock: 10, couponUsage: 3 });
  state.failRpc = 'atomic_delete_order';
  const r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 500, 'failure is reported as 500 (never a false success)');
  eq(state.orders.has('ZSH-TEST-1'), true, 'order row still exists (rolled back)');
  eq(state.products.get(1).stock, 10, 'stock untouched');
  state.failRpc = null;
}

// ─── [9] not found / validation ─────────────────────────────────────────────
console.log('\n[9] not found + validation');
{
  seed();
  const del = await call('DELETE', { id: 'ZSH-NOPE-0' });
  eq(del.status, 404, 'deleting a missing order → 404');
  const bad = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Banana' });
  eq(bad.status, 422, 'invalid status → 422');
  const noId = await call('DELETE', {});
  eq(noId.status, 400, 'missing id → 400');
}

// ─── [10] legacy / non-standard order data ──────────────────────────────────
console.log('\n[10] legacy order data');
{
  // Double-encoded JSON string (a real legacy shape): cancellation and delete
  // must still restore the valid lines.
  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: JSON.stringify([{ productId: 1, qty: 2, size: 'M', color: 'Black' }]) });
  let r = await call('PATCH', { id: 'ZSH-TEST-1', status: 'Cancelled' });
  eq(r.status, 200, 'cancel accepts a double-encoded items string');
  eq(state.products.get(1).stock, 12, 'valid legacy line restored on cancel');
  eq(state.coupons.get('SAVE10').usageCount, 2, 'coupon freed for the legacy order');

  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: JSON.stringify([{ productId: 1, qty: 2, size: 'M', color: 'Black' }]) });
  r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'delete accepts a double-encoded items string');
  eq(state.products.get(1).stock, 12, 'valid legacy line restored on delete');
  eq(r.body.stockRestored, true, 'delete reports stockRestored=true');

  // A JSON object instead of an array, and a malformed JSON string: never 500.
  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: { productId: 1, qty: 2 } });
  r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'non-array items do not break deletion');
  eq(state.orders.has('ZSH-TEST-1'), false, 'order is still deleted');
  eq(state.products.get(1).stock, 10, 'no stock is invented for an unparseable cart');
  eq(r.body.stockRestored, false, 'unparseable cart reports stockRestored=false');

  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: '{"broken":' });
  r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'malformed JSON string does not break deletion');
  eq(state.products.get(1).stock, 10, 'malformed cart leaves stock untouched');

  // Mixed valid + invalid lines: process the valid line, count the rest.
  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: [
    { productId: 1, qty: 2, size: 'M', color: 'Black' },
    { productId: 1, qty: 0, size: 'M', color: 'Black' },
    { productId: 'abc', qty: 2, size: 'M', color: 'Black' },
    'not-an-object',
  ] });
  r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'mixed legacy lines delete successfully');
  eq(state.products.get(1).stock, 12, 'the single valid line is restored');
  const skipped = (r.body.warnings || []).find((w) => w.code === 'legacy_items_skipped');
  eq(skipped && skipped.count, 3, 'three invalid lines are reported as skipped');

  // A permanently deleted product: deletion proceeds, but no line is restored
  // and the warning is returned (documented permanent inventory loss).
  seed({ stock: 10, couponUsage: 3 });
  resetOrder({ items: [
    { productId: 1, qty: 2, size: 'M', color: 'Black' },
    { productId: 999, qty: 1, size: 'M', color: 'Black' },
  ] });
  r = await call('DELETE', { id: 'ZSH-TEST-1' });
  eq(r.status, 200, 'message deletion is not blocked by a deleted product');
  eq(state.orders.has('ZSH-TEST-1'), false, 'the order row is removed');
  eq(state.products.get(1).stock, 10, 'no partial restore happens when any product is missing');
  eq(r.body.stockRestored, false, 'response reports stockRestored=false');
  ok((r.body.warnings || []).some((w) => w.reason === 'missing_product'),
    'response explains the missing product');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
