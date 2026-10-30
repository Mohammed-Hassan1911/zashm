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
  sendTelegramNotification,
  buildOrderTelegramMessage,
  trackingUrlFor,
  verifyTrackToken,
  EGYPT_PHONE_RE,
  cairoDateString,
} = require('./_lib');

const ORDER_ID_RE = /^ZSH-[A-Za-z0-9]{1,20}-[A-Za-z0-9]{1,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localOrderDate() {
  return cairoDateString();
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

  const validated = validateOrderPayload(body);
  if (!validated.ok) {
    return json(res, 422, { success: false, error: 'Invalid order data', errors: validated.errors });
  }

  const rawKey = body && body.idempotencyKey;
  const idempotencyKey = typeof rawKey === 'string' && rawKey.trim() !== '' ? rawKey.trim() : null;
  if (idempotencyKey !== null && !/^[A-Za-z0-9._-]{8,64}$/.test(idempotencyKey)) {
    return json(res, 422, { success: false, error: 'Invalid order data', errors: ['Your checkout session expired. Please refresh the page and try again.'] });
  }

  const { items, customer } = validated;
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

    // 2. Aggregate demand per (product, size, color) BEFORE the availability
    //    check. A cart that splits the same variation across several lines must
    //    not collectively exceed what is in stock — otherwise each line passes
    //    the per-line check and the variant is oversold. The RPC mirrors this.
    const demand = new Map();
    for (const item of items) {
      const key = `${item.productId}::${item.size}-${item.color}`;
      demand.set(key, (demand.get(key) || 0) + Number(item.qty));
    }

    // 2b. Rebuild line items from DB prices + validate stock availability.
    const orderItems = [];
    const stockErrors = [];
    // Structured issues so the client can auto-correct the cart quantities.
    const stockIssues = [];
    for (const item of items) {
      const p = productMap.get(item.productId);
      if (!p) {
        stockErrors.push('A product in your cart is no longer available / أحد المنتجات في سلة التسوق لم يعد متوفرًا.');
        stockIssues.push({
          productId: item.productId,
          size: item.size || '',
          color: item.color || '',
          requested: Number(item.qty || 0),
          available: 0,
          missing: true,
        });
        continue;
      }
      const unitPrice = Number(p.salePrice) || Number(p.price) || 0;
      const variantKey = `${item.size}-${item.color}`;
      let stockAmount = 99;
      const pv = p.variantStock;
      const hasVariantStock = !!(pv && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length > 0);
      if (hasVariantStock) {
        // Variant products: an undefined key means zero available. Falling back to
        // the global stock (the sum of all variants) would wrongly allow orders.
        stockAmount = Number(pv[variantKey]) || 0;
      } else if (p.stock !== undefined && p.stock !== null) {
        stockAmount = Number(p.stock);
      }
      const reserved = Number(p.reservedStock || 0);
      const available = Math.max(0, stockAmount - reserved);
      const requested = demand.get(`${item.productId}::${variantKey}`) || item.qty;
      if (requested > available) {
        const msg = available === 0
          ? `Sorry, this piece is out of stock for this variation / هذا المنتج غير متوفر بهذا الاختلاف (${item.size} - ${item.color}).`
          : `Only ${available} piece(s) remaining in stock for this variation / متبقى ${available} قطعة فقط من هذا المنتج (${item.size} - ${item.color}).`;
        if (!stockErrors.includes(msg)) stockErrors.push(msg);
        const existing = stockIssues.find(
          (si) => si.productId === item.productId && si.size === (item.size || '') && si.color === (item.color || '')
        );
        if (existing) {
          existing.requested = Math.max(existing.requested, requested);
          existing.available = Math.min(existing.available, available);
        } else {
          stockIssues.push({
            productId: item.productId,
            size: item.size || '',
            color: item.color || '',
            requested,
            available,
            missing: false,
          });
        }
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
        stockIssues,
      });
    }

    // 3. Server-side totals: DB prices + quantities + coupon + shipping.
    const subtotal = orderItems.reduce((s, i) => s + i.price, 0);

    let couponRow = null;
    const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : '';
    if (couponCode) {
      const today = cairoDateString();
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

    // 4. Create the order row (items/timestamps as jsonb for the atomic RPC).
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
      items: orderItems,
      timestamps,
      tracking_url: trackingUrl,
    };

    // 4b. Atomic place: order INSERT + stock decrement in ONE database
    //     transaction, serialized by product row locks — the stock invariant
    //     is enforced inside PostgreSQL, never in JS.
    //     See supabase/atomic_place_order.sql (apply steps 1-5 there first).
    const { data: rpcData, error: rpcErr } = await sb.rpc('atomic_place_order', {
      p_order: orderRow,
      p_idempotency_key: idempotencyKey,
    });
    if (rpcErr) {
      console.error('atomic_place_order failed:', rpcErr.message);
      return json(res, 500, { success: false, error: 'Could not save the order. Please try again.' });
    }
    const r = Array.isArray(rpcData) ? (rpcData[0] || {}) : (rpcData || {});

    if (r.ok !== true) {
      const reason = r.reason || '';
      if (reason === 'unavailable') {
        const available = Number(r.available || 0);
        const variation = `${r.size || ''} - ${r.color || ''}`.trim();
        const msg = available === 0
          ? variation
            ? `Sorry, this piece is out of stock for this variation / هذا المنتج غير متوفر بهذا الاختلاف (${variation}).`
            : 'Sorry, this piece is out of stock / هذا المنتج غير متوفر'
          : variation
            ? `Only ${available} piece(s) remaining in stock for this variation / متبقى ${available} قطعة فقط من هذا المنتج (${variation}).`
            : `Only ${available} piece(s) remaining in stock / متبقى ${available} قطعة فقط.`;
        return json(res, 422, {
          success: false,
          error: msg,
          errors: [msg],
          stockIssues: [{
            productId: Number(r.productId) || 0,
            size: r.size || '',
            color: r.color || '',
            requested: null,
            available,
            missing: false,
          }],
        });
      }
      if (reason === 'missing_product') {
        const missingMsg = 'A product in your cart is no longer available / أحد المنتجات في سلة التسوق لم يعد متوفرًا.';
        return json(res, 422, {
          success: false,
          error: missingMsg,
          errors: [missingMsg],
          stockIssues: [{
            productId: Number(r.productId) || 0,
            size: '',
            color: '',
            requested: null,
            available: 0,
            missing: true,
          }],
        });
      }
      if (reason === 'idempotency_conflict') {
        return json(res, 409, { success: false, error: 'Could not place the order. Please refresh your bag and try again. / تعذر إتمام الطلب. يرجى تحديث سلة التسوق والمحاولة مرة أخرى.' });
      }
      if (reason === 'coupon_unavailable') {
        const msg = 'This discount code is no longer available / كود الخصم لم يعد متاحًا. يرجى إزالته والمحاولة مرة أخرى.';
        return json(res, 422, { success: false, error: msg, errors: [msg] });
      }
      return json(res, 422, { success: false, error: 'Could not place the order. Please review your bag and try again. / تعذر إتمام الطلب. يرجى مراجعة سلة التسوق والمحاولة مرة أخرى.' });
    }

    // 4c. Idempotent retry: this checkout already committed. Return the stored
    //     order as success — Telegram/coupon were already sent on the FIRST
    //     success and are deliberately skipped here.
    if (r.duplicate === true) {
      const { data: existing, error: dupErr } = await sb
        .from('orders')
        .select('*')
        .eq('id', r.orderId || orderId)
        .maybeSingle();
      if (dupErr || !existing) {
        return json(res, 500, { success: false, error: 'Order already exists but could not be loaded.' });
      }
      const dupOrder = parseOrderRow(existing);
      dupOrder.shippingCost = getShippingCost(dupOrder.city);
      return json(res, 200, { success: true, duplicate: true, order: dupOrder });
    }

    // 5. Coupon usage counters are incremented atomically INSIDE
    //    atomic_place_order (same transaction as the INSERT/stock decrement), so
    //    there is no separate read-modify-write here to race or lose updates.

    // 6. Telegram notification (server secret; failure never blocks the order).
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
  const token = String((req.query && req.query.tk) || '').trim();

  if (!trackId || !ORDER_ID_RE.test(trackId)) {
    return json(res, 200, { found: false });
  }

  try {
    const hasFullAccess = verifyTrackToken(trackId, token);
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('orders').select('*').eq('id', trackId).maybeSingle();
    if (error) {
      console.error('Track lookup failed:', error.message);
      return json(res, 500, { found: false, error: 'Tracking is temporarily unavailable' });
    }
    if (!data) return json(res, 200, { found: false });

    if (!hasFullAccess) {
      return json(res, 200, {
        found: true,
        access: 'status',
        order: {
          id: String(data.id),
          status: String(data.status || 'Pending'),
          date: String(data.date || ''),
        },
      });
    }

    const order = parseOrderRow(data);
    order.tracking_url = trackingUrlFor(trackId);
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
