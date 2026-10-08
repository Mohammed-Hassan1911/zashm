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
      const ids = [...new Set(items.map((i) => Number(i.productId)).filter(Boolean))];
      const { data: products } = await sb.from('products').select('id, stock, variantStock').in('id', ids);
      const productMap = new Map((products || []).map((p) => [Number(p.id), p]));

      for (const item of items) {
        const p = productMap.get(Number(item.productId));
        if (!p) continue;
        const qty = Number(item.qty || 0);
        if (!qty) continue;
        const variantKey = `${item.size}-${item.color}`;
        const variantStock = { ...(p.variantStock || {}) };
        const hasVariant = variantStock[variantKey] !== undefined;
        let nextStock;
        let nextVariant = variantStock;
        if (goingToCancelled) {
          nextStock = Number(p.stock || 0) + qty;
          if (hasVariant) variantStock[variantKey] = Number(variantStock[variantKey]) + qty;
        } else {
          nextStock = Math.max(0, Number(p.stock || 0) - qty);
          if (hasVariant) variantStock[variantKey] = Math.max(0, Number(variantStock[variantKey]) - qty);
        }
        try {
          await sb.from('products').update({ stock: nextStock, variantStock: nextVariant }).eq('id', p.id);
        } catch (e) {
          console.error('Stock reconcile failed:', e.message);
        }
      }
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
    const { error } = await sb.from('orders').delete().eq('id', id);
    if (error) {
      console.error('Order delete failed:', error.message);
      return json(res, 500, { error: 'Could not delete order' });
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
