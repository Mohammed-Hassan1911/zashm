'use strict';

/**
 * POST /api/coupons/validate
 *
 * Public coupon check for the storefront. The browser sends only the code the
 * customer typed; the coupon table is read server-side with the service role
 * and never exposed. The response deliberately contains only what the bag
 * needs to show a discount (code, type, value) — no ids, usage counters,
 * descriptions, date windows or other coupons.
 *
 * This endpoint is advisory. api/orders.js re-validates the coupon and the
 * atomic_place_order() RPC increments its usage counter inside the same
 * transaction as the order, so a forged browser response cannot grant a
 * discount.
 */

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
  tooMany,
  supabaseAdmin,
  cairoDateString,
  COUPON_CODE_RE,
} = require('../_lib');

// A shopper normally validates once when applying a code and once more when
// the cart/checkout page re-opens. 15 per minute leaves room for retries while
// still making code guessing impractical. Vercel may run several warm
// instances, so this is a per-instance limiter (same model as the other API
// routes); it is not a replacement for a shared durable limiter.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_ATTEMPTS = 15;

const INVALID_MESSAGE =
  'Invalid or expired discount code / كود خصم غير صالح أو منتهي الصلاحية';

function readCouponCode(body) {
  const raw = body && body.code;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'A discount code is required / يرجى إدخال كود الخصم' };
  }
  const code = raw.trim().toUpperCase();
  if (!COUPON_CODE_RE.test(code)) {
    return { ok: false, error: 'Invalid discount code format / صيغة كود الخصم غير صحيحة' };
  }
  return { ok: true, code };
}

/**
 * Applies the same rules api/orders.js uses: active + Cairo date window +
 * remaining uses. Returns a fixed generic message for every failure so the
 * caller cannot tell "not found" from "expired" or "exhausted".
 */
function evaluateCoupon(row, today, requestedCode) {
  if (!row) return { valid: false, error: INVALID_MESSAGE };

  const code = String(row.code || '').trim().toUpperCase();
  if (!code || (requestedCode && code !== requestedCode)) {
    return { valid: false, error: INVALID_MESSAGE };
  }
  if (row.active !== true) return { valid: false, error: INVALID_MESSAGE };

  const start = String(row.startDate || '');
  const end = String(row.endDate || '');
  if (!(start <= today && end >= today)) {
    return { valid: false, error: INVALID_MESSAGE };
  }

  const used = Number(row.usageCount || 0);
  const limit = Number(row.usageLimit || 0);
  if (!(used < limit)) return { valid: false, error: INVALID_MESSAGE };

  const value = Number(row.value);
  if (!Number.isFinite(value) || value < 0) {
    return { valid: false, error: INVALID_MESSAGE };
  }

  return {
    valid: true,
    discount: {
      code,
      // Mirror api/orders.js exactly: only the literal 'percentage' gets a
      // percentage discount; every other value is charged as a fixed amount.
      type: row.type === 'percentage' ? 'percentage' : 'fixed',
      value,
    },
  };
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);

  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return json(res, 405, { error: 'Method not allowed' });
  }

  const check = rateLimit(`couponvalidate:${clientIp(req)}`, RATE_MAX_ATTEMPTS, RATE_WINDOW_MS);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 4 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { valid: false, error: 'Invalid request body' });
  }

  const input = readCouponCode(body);
  if (!input.ok) return json(res, 400, { valid: false, error: input.error });

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from('coupons')
      .select('code, type, value, active, startDate, endDate, usageLimit, usageCount')
      .eq('code', input.code)
      .maybeSingle();

    if (error) {
      // Never log the attempted code or any row contents.
      console.error('Coupon validation query failed:', error.code || 'unknown');
      return json(res, 500, {
        valid: false,
        error: 'Could not validate the discount code. Please try again. / تعذر التحقق من كود الخصم، يرجى المحاولة مرة أخرى.',
      });
    }

    const result = evaluateCoupon(data, cairoDateString(), input.code);
    return json(res, 200, result);
  } catch (err) {
    console.error('Coupon validation failed:', (err && err.name) || 'unknown');
    return json(res, 500, {
      valid: false,
      error: 'Could not validate the discount code. Please try again. / تعذر التحقق من كود الخصم، يرجى المحاولة مرة أخرى.',
    });
  }
}

module.exports = handler;
module.exports._test = {
  readCouponCode,
  evaluateCoupon,
  INVALID_MESSAGE,
  RATE_MAX_ATTEMPTS,
  RATE_WINDOW_MS,
};
