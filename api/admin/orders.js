'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
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

// Adjust a coupon's usageCount by a signed delta, clamped at zero. Best-effort:
// failures are logged but never block the order operation (usageCount is
// advisory and the coupon may have been deleted already).
async function adjustCouponUsage(sb, code, delta) {
  const code_ = String(code || '').trim();
  if (!code_) return;
  try {
    const { data: coupon } = await sb.from('coupons').select('id, usageCount').eq('code', code_).maybeSingle();
    if (!coupon) return;
    const next = Math.max(0, Number(coupon.usageCount || 0) + delta);
    await sb.from('coupons').update({ usageCount: next }).eq('id', coupon.id);
  } catch (e) {
    console.error('Coupon usage adjust failed:', e && e.message);
  }
}

// ─── GET /api/admin/orders — full list for admin dashboard ───────────────────

async function listOrders(req, res) {
  const session = requirePerm(req, res, 'orders.read');
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
  const session = requirePerm(req, res, 'orders.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminorder:${ip}`, 60, 60 * 1000);
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
    const { data: order, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load order' });
    if (!order) return json(res, 404, { error: 'Order not found' });

    const oldStatus = String(order.status || 'Pending');
    const timestamps = {
      ...(parseOrderRow(order).timestamps || {}),
      [newStatus.toLowerCase()]: new Date().toISOString(),
    };

    const items = parseOrderRow(order).items || [];
    const goingToCancelled = newStatus.toLowerCase() === 'cancelled' && oldStatus.toLowerCase() !== 'cancelled';
    const comingFromCancelled = oldStatus.toLowerCase() === 'cancelled' && newStatus.toLowerCase() !== 'cancelled';

    if (goingToCancelled || comingFromCancelled) {
      const lines = items
        .map((i) => ({
          productId: Number(i.productId),
          qty: Number(i.qty || 0),
          size: i.size || '',
          color: i.color || '',
        }))
        .filter((l) => l.productId && l.qty > 0);
      if (lines.length) {
        // Atomic, row-locked stock restore/deduction (supabase/atomic_place_order.sql
        // step 4). Serializes against concurrent order placement and aggregates
        // multiple lines of the same product correctly.
        const { data, error: rpcErr } = await sb.rpc('atomic_adjust_stock', {
          p_lines: lines,
          p_delta: goingToCancelled ? 1 : -1,
        });
        const r = Array.isArray(data) ? (data[0] || {}) : (data || {});
        if (rpcErr || r.ok !== true) {
          console.error('Stock reconcile (atomic) failed:', rpcErr ? rpcErr.message : (r && r.reason));
          return json(res, 500, { error: 'Could not reconcile stock. Please try again.' });
        }
      }

      // Keep coupon usage in sync with the order lifecycle: cancelling frees the
      // coupon (usage -1), un-cancelling consumes it again (usage +1). Mirrors
      // the placement increment in api/orders.js and the delete decrement below.
      await adjustCouponUsage(sb, order.discountCode, goingToCancelled ? -1 : 1);
    }

    const { error: updErr } = await sb
      .from('orders')
      .update({ status: newStatus, timestamps: JSON.stringify(timestamps) })
      .eq('id', id);
    if (updErr) {
      console.error('Order status update failed:', updErr.message);
      return json(res, 500, { error: 'Could not update order' });
    }

    return json(res, 200, { success: true });
  } catch (err) {
    console.error('Order update error:', err && err.message);
    return json(res, 500, { error: 'Could not update order' });
  }
}

// ─── DELETE /api/admin/orders ────────────────────────────────────────────────

async function deleteOrder(req, res) {
  const session = requirePerm(req, res, 'orders.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminorder:${ip}`, 60, 60 * 1000);
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
    const { data: order, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load order' });
    if (!order) return json(res, 404, { error: 'Order not found' });

    const { error: delErr } = await sb.from('orders').delete().eq('id', id);
    if (delErr) {
      console.error('Order delete failed:', delErr.message);
      return json(res, 500, { error: 'Could not delete order' });
    }

    // Restore stock and coupon usage after the row deletion (source of truth
    // first — if the delete failed nothing was touched). A Cancelled order
    // already had its stock restored and coupon freed by updateOrder, so we
    // must NOT restore them again here (double restore → oversell).
    const wasCancelled = String(order.status || '').toLowerCase() === 'cancelled';
    const items = parseOrderRow(order).items || [];
    const lines = items
      .map((i) => ({
        productId: Number(i.productId),
        qty: Number(i.qty || 0),
        size: i.size || '',
        color: i.color || '',
      }))
      .filter((l) => l.productId && l.qty > 0);
    if (!wasCancelled && lines.length) {
      try {
        // Atomic, row-locked restore (supabase/atomic_place_order.sql step 4).
        const { data, error: rpcErr } = await sb.rpc('atomic_adjust_stock', {
          p_lines: lines,
          p_delta: 1,
        });
        const r = Array.isArray(data) ? (data[0] || {}) : (data || {});
        if (rpcErr || r.ok !== true) {
          console.error('Order delete stock restore (atomic) failed:', rpcErr ? rpcErr.message : (r && r.reason));
        }
      } catch (e) {
        console.error('Order delete stock restore (atomic) failed:', e.message);
      }
    }
    if (!wasCancelled && order.discountCode) {
      await adjustCouponUsage(sb, order.discountCode, -1);
    }

    return json(res, 200, { success: true });
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
