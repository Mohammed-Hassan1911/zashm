'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
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
  couponIsRedeemable,
  computeCouponDiscount,
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
  const check = await rateLimitShared(`placeorder:${ip}`, 10, 60 * 60 * 1000);
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
  if (idempotencyKey === null || !/^[A-Za-z0-9._-]{8,64}$/.test(idempotencyKey)) {
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

    // 2. Aggregate demand BEFORE the availability check. A cart that splits the
    //    same product/variant across several lines must not collectively exceed
    //    what is in stock. Variant products are compared per variant; products
    //    WITHOUT variants all share one global stock value, so their lines are
    //    summed per product. The RPC mirrors this exactly.
    const demandByVariant = new Map();
    const demandByProduct = new Map();
    for (const item of items) {
      const requestedQty = Number(item.qty);
      demandByProduct.set(
        item.productId,
        (demandByProduct.get(item.productId) || 0) + requestedQty
      );
      const key = `${item.productId}::${item.size}-${item.color}`;
      demandByVariant.set(key, (demandByVariant.get(key) || 0) + requestedQty);
    }

    // 2b. Rebuild line items from DB prices + validate stock availability.
    const orderItems = [];
    const stockErrors = [];
    // Structured issues so the client can auto-correct the cart quantities.
    const stockIssues = [];
    for (const item of items) {
      const p = productMap.get(item.productId);
      // SEC-11: a product the admin deactivated must never be sellable, even if
      // it is still in a shopper's saved cart. Treat it exactly like a product
      // that disappeared so the client removes it.
      if (!p || p.active === false) {
        stockErrors.push('A product in your cart is no longer available.');
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
      // DECISION (2026-11-01): reservedStock is intentionally NOT part of
      // availability. Nothing writes it and nothing expires it, so subtracting
      // it would permanently hide sellable stock. The column is kept for schema
      // compatibility; PostgreSQL only sees it in admin service-role rows.
      // The authoritative check still runs inside atomic_place_order.
      const available = Math.max(0, stockAmount);
      // Variant products compare the aggregate for this exact variant; products
      // without variants compare the aggregate for the whole product, because
      // size/color do not select a separate stock pool there.
      const requested = hasVariantStock
        ? (demandByVariant.get(`${item.productId}::${variantKey}`) ?? item.qty)
        : (demandByProduct.get(item.productId) ?? item.qty);
      if (requested > available) {
        const variationSuffix = hasVariantStock ? ` (${item.size} - ${item.color})` : '';
        const msg = available === 0
          ? `Sorry, this piece is out of stock${hasVariantStock ? ' for this variation' : ''}${variationSuffix}.`
          : `Only ${available} piece(s) remaining in stock${hasVariantStock ? ' for this variation' : ''}${variationSuffix}.`;
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
    let discount = 0;
    const couponCode = body.couponCode ? String(body.couponCode).trim().toUpperCase() : '';
    if (couponCode) {
      const today = cairoDateString();
      const { data: c, error: couponErr } = await sb
        .from('coupons')
        .select('code, type, value, discountValue, minOrderAmount, maxDiscount, active, startDate, endDate, usageLimit, usageCount')
        .eq('code', couponCode)
        .maybeSingle();
      if (couponErr) {
        console.error('Order coupon lookup failed:', couponErr.code || 'unknown');
        return json(res, 500, { success: false, error: 'Could not validate the discount code. Please try again.' });
      }
      // The customer asked for a discount, so never silently charge full price.
      // If the code stopped being usable between validation and checkout, the
      // whole order is rejected and the bag asks them to remove it.
      if (!couponIsRedeemable(c, today)) {
        const msg = 'This discount code is no longer available. Please remove it and try again.';
        return json(res, 422, { success: false, error: msg, errors: [msg] });
      }
      const priced = computeCouponDiscount(c, subtotal);
      if (!priced.ok) {
        const msg = 'This discount code is not valid for this order. Please remove it and try again.';
        return json(res, 422, { success: false, error: msg, errors: [msg], reason: priced.reason });
      }
      couponRow = c;
      discount = priced.discount;
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
            ? `Sorry, this piece is out of stock for this variation (${variation}).`
            : 'Sorry, this piece is out of stock.'
          : variation
            ? `Only ${available} piece(s) remaining in stock for this variation (${variation}).`
            : `Only ${available} piece(s) remaining in stock.`;
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
        const missingMsg = 'A product in your cart is no longer available.';
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
      if (reason === 'inactive_product') {
        const inactiveMsg = 'A product in your cart is no longer available.';
        return json(res, 422, {
          success: false,
          error: inactiveMsg,
          errors: [inactiveMsg],
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
      if (reason === 'coupon_changed') {
        const msg = 'The discount conditions changed. Please review your bag and try again.';
        return json(res, 409, { success: false, error: msg, errors: [msg] });
      }
      if (reason === 'idempotency_conflict') {
        return json(res, 409, { success: false, error: 'Could not place the order. Please refresh your bag and try again.' });
      }
      if (reason === 'coupon_unavailable') {
        const msg = 'This discount code is no longer available. Please remove it and try again.';
        return json(res, 422, { success: false, error: msg, errors: [msg] });
      }
      return json(res, 422, { success: false, error: 'Could not place the order. Please review your bag and try again.' });
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
  const check = await rateLimitShared(`track:${ip}`, 30, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  const trackId = String((req.query && req.query.track) || '').trim();
  const token = String((req.query && req.query.tk) || '').trim();

  // SEC-16: an order id alone is NOT a credential. The tracking token is an
  // HMAC of the id with SESSION_SECRET and is only shared through the secure
  // link. Without a valid token we return exactly the same response as an
  // unknown id — before any database query, so ids cannot be probed at all.
  if (!trackId || !ORDER_ID_RE.test(trackId) || !token || !verifyTrackToken(trackId, token)) {
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
