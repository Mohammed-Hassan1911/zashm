'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  tooMany,
  requirePerm,
  supabaseAdmin,
  ORDER_STATUSES,
  parseOrderRow,
  trackingUrlFor,
} = require('../_lib');

function getId(req, body) {
  const q = (req.query && req.query.id) || (body && body.id) || '';
  return String(q).trim();
}

// Status changes and deletions are performed by ONE database function each
// (supabase/atomic_order_lifecycle.sql). The order row is locked first, the
// stock/coupon reconciliation and the order write happen in the SAME
// transaction, and the caller's expected status is re-checked under that lock.
// JS never coordinates the steps — that is what made SEC-04/SEC-05 possible.

// ─── GET /api/admin/orders — full list for admin dashboard ───────────────────

async function listOrders(req, res) {
  const session = await requirePerm(req, res, 'orders.read');
  if (!session) return;

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('orders').select('*').order('date', { ascending: false });
    if (error) {
      console.error('Orders list failed:', error.message);
      return json(res, 500, { error: 'Could not load orders' });
    }
    const orders = (data || []).map((row) => {
      const order = parseOrderRow(row);
      order.tracking_url = trackingUrlFor(row.id);
      return order;
    });
    return json(res, 200, { orders });
  } catch (err) {
    console.error('Orders list error:', err && err.message);
    return json(res, 500, { error: 'Could not load orders' });
  }
}

// ─── PATCH /api/admin/orders — status change with stock reconciliation ───────

async function updateOrder(req, res) {
  const session = await requirePerm(req, res, 'orders.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminorder:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 16 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const id = getId(req, body);
  const newStatus = String((body && body.status) || '').trim();
  if (!id) return json(res, 400, { error: 'Order id is required' });
  if (!ORDER_STATUSES.includes(newStatus)) return json(res, 422, { error: 'Invalid status' });

  try {
    const sb = supabaseAdmin();
    // Read the current row only to build the timestamp map and to pass the
    // optimistic-concurrency precondition. Stock/coupon are NOT touched here.
    const { data: order, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load order' });
    if (!order) return json(res, 404, { error: 'Order not found' });

    const oldStatus = String(order.status || 'Pending');
    const timestamps = {
      ...(parseOrderRow(order).timestamps || {}),
      [newStatus.toLowerCase()]: new Date().toISOString(),
    };

    // Single atomic call: lock order → verify expected status → reconcile
    // stock + coupon → write the new status. A concurrent request that already
    // moved this order is rejected with `status_changed` (409) and no second
    // stock restore happens.
    const { data, error: rpcErr } = await sb.rpc('atomic_set_order_status', {
      p_id: id,
      p_expected_status: oldStatus,
      p_new_status: newStatus,
      p_timestamps: timestamps,
    });
    if (rpcErr) {
      console.error('Order status RPC failed:', rpcErr.message);
      return json(res, 500, { error: 'Could not update order' });
    }
    const r = Array.isArray(data) ? (data[0] || {}) : (data || {});

    if (r.ok !== true) {
      const reason = r.reason || '';
      if (reason === 'not_found') return json(res, 404, { error: 'Order not found' });
      if (reason === 'status_changed') {
        return json(res, 409, {
          error: 'This order was changed by another operation. Please refresh and try again.',
          status: r.status || null,
        });
      }
      if (reason === 'invalid_status') return json(res, 422, { error: 'Invalid status' });
      if (reason === 'missing_product') {
        console.error('Order status reconcile failed: missing product', r.productId);
        return json(res, 409, { error: 'A product in this order no longer exists. Please review it manually.' });
      }
      if (reason === 'missing_variant') {
        console.error('Order status reconcile failed: missing variant', r.productId, r.variant);
        return json(res, 409, { error: 'A product variation in this order no longer exists. Please review it manually.' });
      }
      if (reason === 'unavailable') {
        return json(res, 409, {
          error: 'There is not enough stock to re-open this cancelled order. Please review it manually.',
        });
      }
      console.error('Order status reconcile failed:', reason || 'unknown');
      return json(res, 500, { error: 'Could not update order' });
    }

    // Cancellation restores stock for every existing line and reports any
    // missing product/variant or deleted coupon instead of hiding it.
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    if (warnings.length) {
      console.warn('Order status changed with reconciliation warnings:', JSON.stringify(warnings));
    }
    return json(res, 200, {
      success: true,
      status: r.status || newStatus,
      changed: r.changed !== false,
      warnings,
    });
  } catch (err) {
    console.error('Order update error:', err && err.message);
    return json(res, 500, { error: 'Could not update order' });
  }
}

// ─── DELETE /api/admin/orders ────────────────────────────────────────────────

async function deleteOrder(req, res) {
  const session = await requirePerm(req, res, 'orders.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminorder:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    /* empty body is fine */
  }

  const id = getId(req, body);
  if (!id) return json(res, 400, { error: 'Order id is required' });

  try {
    const sb = supabaseAdmin();
    // ONE transaction: lock the order row, restore stock/coupon if (and only
    // if) the order was not already cancelled, then delete the row. If the
    // restore raises, the DELETE is rolled back and the order stays intact.
    const { data, error: rpcErr } = await sb.rpc('atomic_delete_order', { p_id: id });
    if (rpcErr) {
      console.error('Order delete RPC failed:', rpcErr.message);
      return json(res, 500, { error: 'Could not delete order' });
    }
    const r = Array.isArray(data) ? (data[0] || {}) : (data || {});

    if (r.ok !== true) {
      if (r.reason === 'not_found') return json(res, 404, { error: 'Order not found' });
      if (r.reason === 'invalid_payload') return json(res, 400, { error: 'Order id is required' });
      console.error('Order delete failed:', r.reason || 'unknown');
      return json(res, 500, { error: 'Could not delete order' });
    }

    // Surface partial-restore warnings instead of hiding them: existing lines
    // are restored, while a permanently deleted product/variant is reported for
    // manual reconciliation. stockRestored is true when anything was restored.
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    if (warnings.length) {
      console.warn('Order deleted with restore warnings:', JSON.stringify(warnings));
    }
    return json(res, 200, {
      success: true,
      stockRestored: r.stockRestored === true,
      wasCancelled: r.wasCancelled === true,
      partial: warnings.length > 0,
      warnings,
    });
  } catch (err) {
    console.error('Order delete error:', err && err.message);
    return json(res, 500, { error: 'Could not delete order' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'GET') return listOrders(req, res);
  if (req.method === 'PATCH') return updateOrder(req, res);
  if (req.method === 'DELETE') return deleteOrder(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
