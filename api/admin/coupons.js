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
  validateCouponPayload,
} = require('../_lib');

function getId(req, body) {
  const q = (req.query && req.query.id) || (body && body.id) || '';
  return String(q).trim();
}

// ─── POST /api/admin/coupons ─────────────────────────────────────────────────

async function createCoupon(req, res) {
  const session = requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
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
      value: c.value,
      active: c.active,
      description: c.description || '',
      startDate: c.startDate,
      endDate: c.endDate,
      usageLimit: c.usageLimit,
      usageCount: Number(input.usageCount || 0),
      createdAt: input.createdAt || new Date().toISOString(),
    };
    const { data, error } = await sb.from('coupons').insert([record]).select().single();
    if (error) throw error;
    return json(res, 200, { success: true, discount: data });
  } catch (err) {
    console.error('Coupon create failed:', err && err.message);
    const msg = /duplicate|unique/i.test(String(err.message)) ? 'A discount with this code already exists' : 'Could not save discount';
    return json(res, 500, { error: msg });
  }
}

// ─── PATCH /api/admin/coupons ────────────────────────────────────────────────

async function updateCoupon(req, res) {
  const session = requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 32 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const id = getId(req, body);
  const updates = (body && body.updates) || {};
  if (!id) return json(res, 400, { error: 'Discount id is required' });

  try {
    const sb = supabaseAdmin();
    const { data: existing, error } = await sb.from('coupons').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load discount' });
    if (!existing) return json(res, 404, { error: 'Discount not found' });

    const merged = { ...existing, ...updates };
    const normalized = validateCouponPayload(merged);
    if (!normalized) return json(res, 422, { error: 'Invalid discount data' });

    const allowedKeys = ['code', 'type', 'value', 'active', 'description', 'startDate', 'endDate', 'usageLimit', 'usageCount'];
    const write = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(updates, key) && normalized[key] !== undefined) {
        write[key] = normalized[key];
      }
    }
    if (Object.keys(write).length === 0) return json(res, 400, { error: 'Nothing to update' });

    const { error: updErr } = await sb.from('coupons').update(write).eq('id', id);
    if (updErr) throw updErr;

    const { data: fresh } = await sb.from('coupons').select('*').eq('id', id).maybeSingle();
    return json(res, 200, { success: true, discount: fresh });
  } catch (err) {
    console.error('Coupon update failed:', err && err.message);
    return json(res, 500, { error: 'Could not update discount' });
  }
}

// ─── DELETE /api/admin/coupons ───────────────────────────────────────────────

async function deleteCoupon(req, res) {
  const session = requirePerm(req, res, 'discounts.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
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
    const { error } = await sb.from('coupons').delete().eq('id', id);
    if (error) throw error;
    return json(res, 200, { success: true });
  } catch (err) {
    console.error('Coupon delete failed:', err && err.message);
    return json(res, 500, { error: 'Could not delete discount' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'POST') return createCoupon(req, res);
  if (req.method === 'PATCH') return updateCoupon(req, res);
  if (req.method === 'DELETE') return deleteCoupon(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
