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
  validateCouponPayload,
} = require('../_lib');

function getId(req, body) {
  const q = (req.query && req.query.id) || (body && body.id) || '';
  return String(q).trim();
}

// Log the error code only. Driver messages can embed coupon data, for example:
// duplicate key value violates unique constraint ... Key (code)=(SAVE10).
function logCouponError(action, err) {
  console.error(action, (err && err.code) || 'unknown');
}

// ─── GET /api/admin/coupons ──────────────────────────────────────────────────
// The only way the console can list coupons. It requires a signed session with
// discounts.read, so the coupon table never has to be readable with the anon key.

async function listCoupons(req, res) {
  const session = await requirePerm(req, res, 'discounts.read');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`admincouponread:${ip}`, 120, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  res.setHeader('Cache-Control', 'no-store');
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('coupons').select('*');
    if (error) throw error;
    return json(res, 200, { discounts: Array.isArray(data) ? data : [] });
  } catch (err) {
    logCouponError('Coupon list failed:', err);
    return json(res, 500, { error: 'Could not load discounts' });
  }
}

// ─── POST /api/admin/coupons ─────────────────────────────────────────────────

async function createCoupon(req, res) {
  const session = await requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 32 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const input = (body && body.coupon) || body || {};
  const c = validateCouponPayload(input);
  if (!c) return json(res, 422, { error: 'Invalid discount data' });

  try {
    const sb = supabaseAdmin();
    const record = {
      id: Number.isFinite(Number(input.id)) && String(input.id).trim() !== '' ? Number(input.id) : Date.now(),
      code: c.code,
      type: c.type,
      // Keep both value columns identical: `value` is canonical, `discountValue`
      // is the legacy name still read by older rows/tools.
      value: c.value,
      discountValue: c.discountValue,
      active: c.active,
      description: c.description || '',
      startDate: c.startDate,
      endDate: c.endDate,
      usageLimit: c.usageLimit,
      usageCount: 0,
      minOrderAmount: c.minOrderAmount,
      maxDiscount: c.maxDiscount,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    const { data, error } = await sb.from('coupons').insert([record]).select().single();
    if (error) throw error;
    return json(res, 200, { success: true, discount: data });
  } catch (err) {
    logCouponError('Coupon create failed:', err);
    const msg = /duplicate|unique/i.test(String(err.message)) ? 'A discount with this code already exists' : 'Could not save discount';
    return json(res, /duplicate|unique/i.test(String(err.message)) ? 409 : 500, { error: msg });
  }
}

// ─── PATCH /api/admin/coupons ────────────────────────────────────────────────

async function updateCoupon(req, res) {
  const session = await requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 32 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const id = getId(req, body);
  let updates = (body && body.updates) || {};
  if (!id) return json(res, 400, { error: 'Discount id is required' });

  // `value` and `discountValue` are the same field under two names. If the
  // console edits the legacy name, promote it to the canonical one so the
  // merge below cannot keep the old value by mistake.
  if (
    Object.prototype.hasOwnProperty.call(updates, 'discountValue') &&
    !Object.prototype.hasOwnProperty.call(updates, 'value')
  ) {
    updates = { ...updates, value: updates.discountValue };
  }

  try {
    const sb = supabaseAdmin();
    const { data: existing, error } = await sb.from('coupons').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load discount' });
    if (!existing) return json(res, 404, { error: 'Discount not found' });

    const merged = { ...existing, ...updates };
    const normalized = validateCouponPayload(merged);
    if (!normalized) return json(res, 422, { error: 'Invalid discount data' });

    const allowedKeys = [
      'code', 'type', 'value', 'discountValue', 'active', 'description',
      'startDate', 'endDate', 'usageLimit', 'minOrderAmount', 'maxDiscount',
    ];
    const write = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(updates, key) && normalized[key] !== undefined) {
        write[key] = normalized[key];
      }
    }
    // Never let the two value columns drift apart.
    if (Object.prototype.hasOwnProperty.call(write, 'value') ||
        Object.prototype.hasOwnProperty.call(write, 'discountValue')) {
      write.value = normalized.value;
      write.discountValue = normalized.value;
    }
    if (Object.keys(write).length === 0) return json(res, 400, { error: 'Nothing to update' });

    const { error: updErr } = await sb.from('coupons').update(write).eq('id', id);
    if (updErr) throw updErr;

    const { data: fresh } = await sb.from('coupons').select('*').eq('id', id).maybeSingle();
    return json(res, 200, { success: true, discount: fresh });
  } catch (err) {
    logCouponError('Coupon update failed:', err);
    return json(res, 500, { error: 'Could not update discount' });
  }
}

// ─── DELETE /api/admin/coupons ───────────────────────────────────────────────

async function deleteCoupon(req, res) {
  const session = await requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    /* tolerated */
  }

  const id = getId(req, body);
  if (!id) return json(res, 400, { error: 'Discount id is required' });

  try {
    const sb = supabaseAdmin();

    // Deleting a coupon that an open order still references makes coupon-usage
    // reconciliation fail during cancellation/deletion. Block it here with a
    // friendly 409; the zshm_guard_coupon_delete trigger enforces the same rule
    // atomically at the database boundary (and catches the check-then-delete
    // race). Cancelled orders no longer count: their usage was already released.
    const { data: coupon, error: findErr } = await sb
      .from('coupons')
      .select('id,code')
      .eq('id', id)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!coupon) return json(res, 404, { error: 'Discount not found' });

    const { data: orders, error: ordersErr } = await sb
      .from('orders')
      .select('id,status')
      .eq('discountCode', coupon.code);
    if (ordersErr) throw ordersErr;

    const openOrders = (orders || []).filter(
      (o) => String(o.status || '').toLowerCase() !== 'cancelled'
    );
    if (openOrders.length > 0) {
      return json(res, 409, {
        error: 'This discount is used by open orders and cannot be deleted. Cancel those orders first.',
        openOrders: openOrders.length,
      });
    }

    const { error } = await sb.from('coupons').delete().eq('id', id);
    if (error) {
      // The database trigger uses SQLSTATE 23503 for the same condition.
      if (error.code === '23503') {
        return json(res, 409, {
          error: 'This discount is used by open orders and cannot be deleted. Cancel those orders first.',
        });
      }
      throw error;
    }
    return json(res, 200, { success: true });
  } catch (err) {
    logCouponError('Coupon delete failed:', err);
    return json(res, 500, { error: 'Could not delete discount' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'GET') return listCoupons(req, res);
  if (req.method === 'POST') return createCoupon(req, res);
  if (req.method === 'PATCH') return updateCoupon(req, res);
  if (req.method === 'DELETE') return deleteCoupon(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
