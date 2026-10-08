'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
  tooMany,
  supabaseAdmin,
  validateOrderPayload,
  getShippingCost,
  generateOrderId,
  parseOrderRow,
  maskOrderForLimitedAccess,
  sendTelegramNotification,
  buildOrderTelegramMessage,
  trackingUrlFor,
  verifyTrackToken,
  EGYPT_PHONE_RE,
} = require('./_lib');

const ORDER_ID_RE = /^ZSH-[A-Za-z0-9]{1,20}-[A-Za-z0-9]{1,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localOrderDate() {
  const tzOffset = new Date().getTimezoneOffset() * 60000;
  return new Date(Date.now() - tzOffset).toISOString().split('T')[0];
}

function clampClientDate(value) {
  // order.date only affects display/analytics grouping; accept the browser's local
  // date (preserves current behaviour) but reject anything far from server time.
  const candidate = typeof value === 'string' && DATE_RE.test(value) ? value : null;
  if (!candidate) return localOrderDate();
  const diff = Math.abs(new Date(candidate + 'T00:00:00Z') - new Date(localOrderDate() + 'T00:00:00Z'));
  if (diff > 2 * 24 * 60 * 60 * 1000) return localOrderDate();
  return candidate;
}

// ─── POST /api/orders — place order (all money/stock logic server-side) ─────

async function placeOrder(req, res) {
  const ip = clientIp(req);
  const check = rateLimit(`placeorder:${ip}`, 10, 60 * 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 64 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { success: false, error: e.message });
  }

  const payload = validateOrderPayload(body);
  if (!payload) {
    return json(res, 422, { success: false, error: 'Invalid order data', errors: ['Please review your order details.'] });
  }

  const { items, customer } = payload;
  const sb = supabaseAdmin();

  try {
    // 1. Load authoritative product data (prices, stock) from the database.
    const ids = [...new Set(items.map((i) => i.productId))];
    const { data: products, error: prodErr } = await sb.from('products').select('*').in('id', ids);
    if (prodErr) {
      console.error('Order product lookup failed:', prodErr.message);
      return json(res, 500, { success: false, error: 'Could not load products' });
    }
    const productMap = new Map((products || []).map((p) => [Number(p.id), p]));

    // 2. Rebuild line items from DB prices + validate stock availability.
    const orderItems = [];
    const stockErrors = [];
    for (const item of items) {
      const p = productMap.get(item.productId);
      if (!p) {
        stockErrors.push('A product in your cart is no longer available.');
        continue;
      }
      const unitPrice = Number(p.salePrice) || Number(p.price) || 0;
      const variantKey = `${item.size}-${item.color}`;
      let stockAmount = 99;
      if (p.variantStock && p.variantStock[variantKey] !== undefined) {
        stockAmount = Number(p.variantStock[variantKey]);
      } else if (p.stock !== undefined && p.stock !== null) {
        stockAmount = Number(p.stock);
      }
      const reserved = Number(p.reservedStock || 0);
      const available = Math.max(0, stockAmount - reserved);
      if (item.qty > available) {
        stockErrors.push(
          available === 0
            ? `Sorry, this piece is out of stock in this variation (${item.size} - ${item.color}).`
            : `Sorry, only ${available} more piece(s) are remaining in stock for this variation (${item.size} - ${item.color}).`
        );
        continue;
      }
      orderItems.push({
        productId: p.id,
        name: p.name || 'Unknown Product',
        category: (p.category || '').trim() || 'General',
        size: item.size,
        color: item.color,
        qty: item.qty,
        unitPrice,
        price: unitPrice * item.qty,
        image: (Array.isArray(p.images) && p.images[0]) || p.image || '',
      });
    }
    if (stockErrors.length || orderItems.length !== items.length) {
      return json(res, 422, {
        success: false,
        error: 'Some items could not be ordered',
        errors: stockErrors.length ? stockErrors : ['Some items could not be ordered.'],
      });
    }

    // 3. Server-side totals: DB prices + quantities + coupon + shipping.
    const subtotal = orderItems.reduce((s, i) => s + i.price, 0);

    let couponRow = null;
    const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : '';
    if (couponCode) {
      const today = new Date().toISOString().split('T')[0];
      const { data: c } = await sb.from('coupons').select('*').eq('code', couponCode).maybeSingle();
      if (
        c &&
        c.active &&
        String(c.startDate || '') <= today &&
        String(c.endDate || '') >= today &&
        Number(c.usageCount || 0) < Number(c.usageLimit || 0)
      ) {
        couponRow = c;
      }
    }

    let discount = 0;
    if (couponRow) {
      discount =
        couponRow.type === 'percentage'
          ? Math.min(subtotal, Math.round(subtotal * (Number(couponRow.value) || 0) / 100))
          : Math.min(subtotal, Number(couponRow.value) || 0);
    }

    const shippingCost = getShippingCost(customer.city);
    const total = Math.max(0, subtotal + shippingCost - discount);

    // 4. Create the order row.
    const orderId = generateOrderId();
    const trackingUrl = trackingUrlFor(orderId);
    const orderDate = clampClientDate(body.customer && body.customer.date);
    const timestamps = { created: new Date().toISOString() };

    const orderRow = {
      id: orderId,
      subtotal,
      discount,
      total,
      discountCode: couponRow ? couponRow.code : null,
      status: 'Pending',
      date: orderDate,
      customer: customer.name,
      phone: customer.phone,
      phoneAlt: customer.phoneAlt || '',
      email: customer.email || '',
      address: customer.address,
      city: customer.city,
      notes: customer.notes || '',
      items: JSON.stringify(orderItems),
      timestamps: JSON.stringify(timestamps),
      tracking_url: trackingUrl,
    };

    const { error: insertErr } = await sb.from('orders').insert([orderRow]);
    if (insertErr) {
      console.error('Order insert failed:', insertErr.message);
      return json(res, 500, { success: false, error: 'Could not save the order. Please try again.' });
    }

    // 5. Decrement stock (guarded updates; roll back on concurrent-change failure).
    const applied = [];
    let stockFailure = null;
    for (const item of orderItems) {
      const p = productMap.get(Number(item.productId));
      if (!p) continue;
      const variantKey = `${item.size}-${item.color}`;
      const prevStock = Number(p.stock || 0);
      const prevVariant = { ...(p.variantStock || {}) };
      const nextVariant = { ...(p.variantStock || {}) };
      const newStock = Math.max(0, prevStock - item.qty);
      if (nextVariant[variantKey] !== undefined) {
        nextVariant[variantKey] = Math.max(0, Number(nextVariant[variantKey]) - item.qty);
      }
      try {
        const { data: updated, error: updErr } = await sb
          .from('products')
          .update({ stock: newStock, variantStock: nextVariant })
          .eq('id', p.id)
          .gte('stock', item.qty)
          .select('id');
        if (updErr) throw updErr;
        if (!updated || updated.length === 0) {
          stockFailure = `Sorry, "${p.name}" just sold out. Please review your bag.`;
          break;
        }
        applied.push({ id: p.id, prevStock, prevVariant });
      } catch (e) {
        console.error('Stock update failed:', e.message);
        stockFailure = 'Could not reserve stock. Please try again.';
        break;
      }
    }

    if (stockFailure) {
      for (const a of applied) {
        try {
          await sb.from('products').update({ stock: a.prevStock, variantStock: a.prevVariant }).eq('id', a.id);
        } catch (e) {
          console.error('Stock rollback failed:', e.message);
        }
      }
      await sb.from('orders').delete().eq('id', orderId);
      return json(res, 422, { success: false, error: stockFailure, errors: [stockFailure] });
    }

    // 6. Coupon usage counter (server-side only).
    if (couponRow) {
      try {
        await sb
          .from('coupons')
          .update({ usageCount: Number(couponRow.usageCount || 0) + 1 })
          .eq('id', couponRow.id);
      } catch (e) {
        console.error('Coupon usage update failed:', e.message);
      }
    }

    // 7. Telegram notification (server secret; failure never blocks the order).
    try {
      const message = buildOrderTelegramMessage(
        { ...orderRow, items: orderItems, shippingCost },
        trackingUrl
      );
      await sendTelegramNotification(message);
    } catch (e) {
      console.error('Telegram notification failed:', e.message);
    }

    const order = parseOrderRow({ ...orderRow, items: orderItems, timestamps });
    order.tracking_url = trackingUrl;
    order.shippingCost = shippingCost;

    return json(res, 200, { success: true, order });
  } catch (err) {
    console.error('Place order error:', err && err.message);
    return json(res, 500, { success: false, error: 'Order failed. Please try again.' });
  }
}

// ─── GET /api/orders?track=<id>&tk=<token> — public tracking ────────────────

async function trackOrder(req, res) {
  const ip = clientIp(req);
  const check = rateLimit(`track:${ip}`, 30, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  const trackId = String((req.query && req.query.track) || '').trim();
  const tk = String((req.query && req.query.tk) || '').trim();

  if (!trackId || !ORDER_ID_RE.test(trackId)) {
    return json(res, 200, { found: false });
  }

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('orders').select('*').eq('id', trackId).maybeSingle();
    if (error) {
      console.error('Track lookup failed:', error.message);
      return json(res, 500, { found: false, error: 'Tracking is temporarily unavailable' });
    }
    if (!data) return json(res, 200, { found: false });

    const full = verifyTrackToken(trackId, tk);
    const order = parseOrderRow(data);
    order.tracking_url = full ? trackingUrlFor(trackId) : '';

    if (!full) {
      // Knowing the order ID alone must not reveal customer PII.
      return json(res, 200, { found: true, access: 'limited', order: maskOrderForLimitedAccess(order) });
    }
    return json(res, 200, { found: true, access: 'full', order });
  } catch (err) {
    console.error('Track error:', err && err.message);
    return json(res, 500, { found: false, error: 'Tracking is temporarily unavailable' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'POST') return placeOrder(req, res);
  if (req.method === 'GET') return trackOrder(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
