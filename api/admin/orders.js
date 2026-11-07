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
  validateOrderEditPayload,
  getShippingCost,
  cairoDateString,
  couponIsRedeemable,
  computeCouponDiscount,
  sendTelegramNotification,
  buildOrderStatusMessage,
  buildOrderEditMessage,
  buildOrderTelegramActions,
} = require('../_lib');

function getId(req, body) {
  const q = (req.query && req.query.id) || (body && body.id) || '';
  return String(q).trim();
}

function isEditRequest(body) {
  return !!body && (body.action === 'edit' || body.edit === true);
}

function orderRev(order) {
  const raw = order && order.timestamps && order.timestamps.rev;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Rebuild edited lines from authoritative database prices. This mirrors the
 * sellable rules of api/orders.js (active, valid price, declared size/colour,
 * existing variant key) but deliberately does NOT check availability: the
 * order already holds its old units, and atomic_edit_order compares the NET
 * difference under row locks. Stock is therefore checked exactly once, where it
 * cannot race.
 */
function buildEditedOrderItems(products, items) {
  const productMap = new Map((products || []).map((p) => [Number(p.id), p]));
  const built = [];
  const errors = [];

  for (const item of items) {
    const p = productMap.get(Number(item.productId));
    if (!p || p.active !== true) {
      errors.push('A selected product is no longer available.');
      continue;
    }

    const priceNum = Number(p.price);
    const saleNum = Number(p.salePrice);
    const hasSale = p.salePrice !== null && p.salePrice !== undefined && p.salePrice !== ''
      && Number.isFinite(saleNum) && saleNum > 0
      && Number.isFinite(priceNum) && saleNum < priceNum;
    const unitPrice = hasSale ? saleNum : priceNum;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      errors.push(`The price of "${p.name || 'a product'}" is invalid.`);
      continue;
    }

    const pv = p.variantStock;
    const hasVariantStock = !!(pv && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length > 0);
    const declaredSizes = Array.isArray(p.sizes) ? p.sizes : [];
    const declaredColors = Array.isArray(p.colors) ? p.colors : [];
    const hasSizesOrColors = declaredSizes.length > 0 || declaredColors.length > 0;

    if (hasSizesOrColors && !hasVariantStock) {
      errors.push(`"${p.name || 'A product'}" is not available to order — its size and color options are not set up.`);
      continue;
    }
    if (hasVariantStock && (declaredSizes.length === 0 || declaredColors.length === 0)) {
      errors.push(`"${p.name || 'A product'}" is not available to order — its size and color options are not set up.`);
      continue;
    }
    if (hasVariantStock) {
      const variantKey = `${item.size}-${item.color}`;
      if (!declaredSizes.includes(item.size) || !declaredColors.includes(item.color)) {
        errors.push(`"${p.name || 'A product'}" is no longer available in the selected size or color.`);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(pv, variantKey)) {
        errors.push(`"${p.name || 'A product'}" is no longer available in the selected size or color.`);
        continue;
      }
    }

    built.push({
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

  if (errors.length) return { ok: false, errors };
  return { ok: true, items: built };
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
    body = await readBody(req, 32 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  // The same endpoint handles a full edit. The explicit flag keeps the legacy
  // status-only PATCH contract unchanged for every existing caller.
  if (isEditRequest(body)) return applyOrderEdit(req, res, body);

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

    // Status change alert (Telegram). This is the SHORT internal line, never the
    // customer confirmation text: a "تم الشحن" update must not be pasted into a
    // customer chat as if it were the order confirmation. `changed === false`
    // means an idempotent retry for a transition that already happened, so no
    // second message is sent.
    if (r.changed !== false) {
      try {
        const full = parseOrderRow(order) || order;
        const statusOrder = {
          ...full,
          id: full.id || id,
          tracking_url: full.tracking_url || trackingUrlFor(full.id || id),
        };
        await sendTelegramNotification(buildOrderStatusMessage(statusOrder, newStatus), {
          parseMode: null,
          replyMarkup: buildOrderTelegramActions(statusOrder, statusOrder.tracking_url, {
            includeWhatsApp: false,
          }),
        });
      } catch (e) {
        console.error('Telegram (status) failed:', e.message);
      }
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

// ─── PATCH /api/admin/orders (action: edit) — customer + item correction ─────
//
// Money stays server-authoritative: the API reprices every edited line from the
// database, re-validates the coupon against the NEW subtotal, and recomputes
// shipping/total. The single atomic_edit_order RPC then locks the order,
// re-checks the optimistic revision, reconciles stock by net difference and
// writes everything in one transaction.
async function applyOrderEdit(req, res, body) {
  const id = getId(req, body);
  if (!id) return json(res, 400, { error: 'Order id is required' });

  const expectedRev = Number(body && body.expectedRev);
  if (!Number.isInteger(expectedRev) || expectedRev < 0) {
    return json(res, 400, {
      error: 'A current order revision is required. Please refresh and try again.',
    });
  }

  const validated = validateOrderEditPayload(body);
  if (!validated.ok) {
    return json(res, 422, { error: 'Invalid order data', errors: validated.errors });
  }

  try {
    const sb = supabaseAdmin();
    const { data: row, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle();
    if (error) {
      console.error('Order edit read failed:', error.message);
      return json(res, 500, { error: 'Could not load order' });
    }
    if (!row) return json(res, 404, { error: 'Order not found' });

    const order = parseOrderRow(row);
    if (orderRev(order) !== expectedRev) {
      return json(res, 409, {
        error: 'This order was changed by another operation. Please refresh and try again.',
        rev: orderRev(order),
        code: 'rev_conflict',
      });
    }

    const status = String(order.status || 'Pending');
    if (validated.items && !['Pending', 'Confirmed'].includes(status)) {
      return json(res, 422, {
        error: 'Items can only be edited while the order is Pending or Confirmed. Customer details can still be updated.',
        code: 'items_locked',
        status,
      });
    }

    // Rebuild edited lines from DB prices (never from the request body).
    let pricedItems = null;
    if (validated.items) {
      const ids = [...new Set(validated.items.map((i) => i.productId))];
      const { data: products, error: prodErr } = await sb.from('products').select('*').in('id', ids);
      if (prodErr) {
        console.error('Order edit product lookup failed:', prodErr.message);
        return json(res, 500, { error: 'Could not load products' });
      }
      const built = buildEditedOrderItems(products || [], validated.items);
      if (!built.ok) {
        return json(res, 422, {
          error: 'Some items cannot be used in this order',
          errors: built.errors,
        });
      }
      pricedItems = built.items;
    }

    const subtotal = pricedItems
      ? pricedItems.reduce((sum, item) => sum + item.price, 0)
      : Number(order.subtotal || 0);

    const currentCode = order.discountCode
      ? String(order.discountCode).trim().toUpperCase()
      : null;
    const nextCode = validated.couponProvided
      ? (validated.couponCode || null)
      : currentCode;

    let discount = Number(order.discount || 0);
    const totalsAffected = Boolean(pricedItems) || validated.couponProvided;
    if (totalsAffected) {
      discount = 0;
      if (nextCode) {
        const { data: coupon, error: couponErr } = await sb
          .from('coupons')
          .select('code, type, value, discountValue, minOrderAmount, maxDiscount, active, startDate, endDate, usageLimit, usageCount')
          .eq('code', nextCode)
          .maybeSingle();
        if (couponErr) {
          console.error('Order edit coupon lookup failed:', couponErr.code || 'unknown');
          return json(res, 500, { error: 'Could not validate the discount code. Please try again.' });
        }

        const sameCode = currentCode === nextCode;
        if (!couponIsRedeemable(coupon, cairoDateString(), { allowExhausted: sameCode })) {
          return json(res, 422, {
            error: 'This discount code is no longer available for this order. Remove it or choose another one.',
            code: 'coupon_unavailable',
          });
        }
        const priced = computeCouponDiscount(coupon, subtotal);
        if (!priced.ok) {
          return json(res, 422, {
            error: 'This discount code is not valid for the edited items. Remove it or choose another one.',
            code: 'coupon_changed',
            reason: priced.reason,
          });
        }
        discount = priced.discount;
      }
    }

    const shippingCost = getShippingCost(validated.customer.city);
    const total = Math.max(0, subtotal + shippingCost - discount);

    const patch = {
      customer: validated.customer.name,
      phone: validated.customer.phone,
      phoneAlt: validated.customer.phoneAlt || '',
      email: validated.customer.email || '',
      address: validated.customer.address,
      city: validated.customer.city,
      notes: validated.customer.notes || '',
      subtotal,
      discount,
      total,
      discountCode: nextCode || '',
      ...(pricedItems ? { items: pricedItems } : {}),
    };

    const { data, error: rpcErr } = await sb.rpc('atomic_edit_order', {
      p_id: id,
      p_expected_rev: expectedRev,
      p_patch: patch,
    });
    if (rpcErr) {
      console.error('Order edit RPC failed:', rpcErr.message);
      return json(res, 500, { error: 'Could not update order' });
    }
    const r = Array.isArray(data) ? (data[0] || {}) : (data || {});

    if (r.ok !== true) {
      const reason = r.reason || '';
      if (reason === 'not_found') return json(res, 404, { error: 'Order not found' });
      if (reason === 'invalid_payload') return json(res, 400, { error: 'Invalid order data' });
      if (reason === 'rev_conflict') {
        return json(res, 409, {
          error: 'This order was changed by another operation. Please refresh and try again.',
          rev: Number(r.rev) || 0,
          code: 'rev_conflict',
        });
      }
      if (reason === 'items_locked') {
        return json(res, 422, {
          error: 'Items can only be edited while the order is Pending or Confirmed. Customer details can still be updated.',
          code: 'items_locked',
          status: r.status || null,
        });
      }
      if (reason === 'coupon_unavailable') {
        return json(res, 422, {
          error: 'This discount code is no longer available for this order. Remove it or choose another one.',
          code: 'coupon_unavailable',
        });
      }
      if (reason === 'coupon_changed') {
        return json(res, 422, {
          error: 'The discount changed while saving. Please review the discount code and try again.',
          code: 'coupon_changed',
        });
      }
      if (reason === 'missing_product') {
        return json(res, 409, { error: 'A selected product no longer exists. Please refresh the products list.' });
      }
      if (reason === 'missing_variant') {
        return json(res, 409, { error: 'A selected product variation no longer exists. Please choose another size or color.' });
      }
      if (reason === 'unavailable') {
        const available = Number(r.available || 0);
        return json(res, 409, {
          error: available > 0
            ? `Only ${available} piece(s) remain in stock for one of the edited items.`
            : 'One of the edited items is out of stock.',
          available,
          code: 'unavailable',
        });
      }
      console.error('Order edit failed:', reason || 'unknown');
      return json(res, 500, { error: 'Could not update order' });
    }

    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    if (warnings.length) {
      console.warn('Order edit completed with reconciliation warnings:', JSON.stringify(warnings));
    }

    const updated = {
      ...order,
      ...patch,
      discountCode: nextCode,
      items: pricedItems || order.items,
      subtotal,
      discount,
      total,
      timestamps: {
        ...(order.timestamps && typeof order.timestamps === 'object' ? order.timestamps : {}),
        edited: new Date().toISOString(),
        rev: Number(r.rev) || expectedRev + 1,
      },
      tracking_url: order.tracking_url || trackingUrlFor(id),
    };

    // Internal edit alert, never the customer confirmation text.
    try {
      await sendTelegramNotification(buildOrderEditMessage(order, updated), {
        parseMode: null,
        replyMarkup: buildOrderTelegramActions(updated, updated.tracking_url, {
          includeWhatsApp: false,
        }),
      });
    } catch (e) {
      console.error('Telegram (edit) failed:', e.message);
    }

    return json(res, 200, {
      success: true,
      order: updated,
      rev: Number(r.rev) || expectedRev + 1,
      warnings,
    });
  } catch (err) {
    console.error('Order edit error:', err && err.message);
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
    // Read the row BEFORE the atomic delete so the replacement notification can
    // still show the full order. This read is notification-only: the delete
    // itself stays a single atomic RPC, and a failed read never blocks it.
    let existing = null;
    try {
      const { data: row, error: readErr } = await sb
        .from('orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!readErr && row) existing = parseOrderRow(row);
    } catch (e) {
      console.warn('Order delete: could not read order for notification');
    }

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

    // Deletion alert (Telegram). The row was read before the atomic delete, so
    // the message can still show the order id and the customer.
    try {
      const full = existing || {};
      const deletedOrder = {
        ...full,
        id: full.id || id,
        tracking_url: full.tracking_url || trackingUrlFor(full.id || id),
      };
      await sendTelegramNotification(buildOrderStatusMessage(deletedOrder, 'Deleted'), {
        parseMode: null,
        replyMarkup: buildOrderTelegramActions(deletedOrder, deletedOrder.tracking_url, {
          includeWhatsApp: false,
        }),
      });
    } catch (e) {
      console.error('Telegram (delete) failed:', e.message);
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
