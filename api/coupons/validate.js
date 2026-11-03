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
  rateLimitShared,
  rateLimitPeekShared,
  resetRateLimitShared,
  tooMany,
  supabaseAdmin,
  cairoDateString,
  COUPON_CODE_RE,
  couponDiscountValue,
  couponMinOrderAmount,
  couponMaxDiscount,
  couponIsRedeemable,
} = require('../_lib');

// A shopper normally validates once when applying a code and once more when
// the cart/checkout page re-opens. 10 per minute still leaves room for retries
// while making code guessing harder. Uses the shared limiter (Upstash when
// configured, per-instance fallback otherwise).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;

// Per-IP, per-code lockout. Only FAILED guesses count, and the counter is keyed
// by the attempted code so a shopper retrying their own valid code is never
// blocked. This slows down guessing a specific code without letting an
// attacker lock a coupon out for everybody (the key includes the IP).
const CODE_LOCK_ATTEMPTS = 5;
const CODE_LOCK_WINDOW_MS = 15 * 60 * 1000;

const INVALID_MESSAGE =
  'Invalid or expired discount code';

function readCouponCode(body) {
  const raw = body && body.code;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'A discount code is required.' };
  }
  const code = raw.trim().toUpperCase();
  if (!COUPON_CODE_RE.test(code)) {
    return { ok: false, error: 'Invalid discount code format.' };
  }
  return { ok: true, code };
}

// The cart subtotal is advisory (the order endpoint recomputes it from DB
// prices), but it lets the storefront show whether a minimum-order coupon is
// applicable. Bounded so it can never be used to smuggle huge numbers.
function readSubtotal(body) {
  const raw = body && body.subtotal;
  if (raw === undefined || raw === null || raw === '') return { ok: true, subtotal: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100000000) {
    return { ok: false, error: 'Invalid cart total.' };
  }
  return { ok: true, subtotal: n };
}

/**
 * Applies the same rules api/orders.js uses: active + Cairo date window +
 * remaining uses + optional minimum order amount. Returns a fixed generic
 * message for every failure so the caller cannot tell "not found" from
 * "expired" or "exhausted".
 *
 * The response keeps `value` (the bag needs it) and adds `maxDiscount` /
 * `minOrderAmount` so the client can display exactly what the server will
 * charge. `value` is NOT secret to a shopper who already holds the code.
 */
function evaluateCoupon(row, today, requestedCode, subtotal) {
  if (!row) return { valid: false, error: INVALID_MESSAGE };

  const code = String(row.code || '').trim().toUpperCase();
  if (!code || (requestedCode && code !== requestedCode)) {
    return { valid: false, error: INVALID_MESSAGE };
  }
  if (!couponIsRedeemable(row, today)) {
    return { valid: false, error: INVALID_MESSAGE };
  }

  const value = couponDiscountValue(row);
  const minOrderAmount = couponMinOrderAmount(row);
  const maxDiscount = couponMaxDiscount(row);

  // Enforce the minimum only when the caller supplied a subtotal.
  if (Number.isFinite(subtotal) && subtotal > 0 && minOrderAmount > 0 && subtotal < minOrderAmount) {
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
      maxDiscount,
      minOrderAmount,
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

  const check = await rateLimitShared(`couponvalidate:${clientIp(req)}`, RATE_MAX_ATTEMPTS, RATE_WINDOW_MS);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 4 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { valid: false, error: 'Invalid request body' });
  }

  const input = readCouponCode(body);
  if (!input.ok) return json(res, 400, { valid: false, error: input.error });

  const subtotalInput = readSubtotal(body);
  if (!subtotalInput.ok) return json(res, 400, { valid: false, error: subtotalInput.error });

  const ip = clientIp(req);
  const lockKey = `couponfail:${ip}:${input.code}`;

  // The lockout peek and the coupon lookup are independent read-only calls, so
  // they run together: a normal apply now costs one shared round-trip instead
  // of two. The lock is still checked before any result is returned, so an
  // exhausted lockout always wins. The lookup wrapper never rejects, which
  // keeps the early 429 path free of unhandled rejections.
  const lockPromise = rateLimitPeekShared(lockKey);
  const couponPromise = (async () => {
    try {
      const sb = supabaseAdmin();
      return await sb
        .from('coupons')
        .select('code, type, value, discountValue, minOrderAmount, maxDiscount, active, startDate, endDate, usageLimit, usageCount')
        .eq('code', input.code)
        .maybeSingle();
    } catch (err) {
      return { data: null, error: { code: (err && err.name) || 'unknown' } };
    }
  })();

  const lock = await lockPromise;
  if (lock.count >= CODE_LOCK_ATTEMPTS) {
    // The read has no side effects; it is discarded with the request.
    void couponPromise.catch(() => {});
    return tooMany(res, lock.resetIn || CODE_LOCK_WINDOW_MS / 1000, {
      valid: false,
      error: INVALID_MESSAGE,
    });
  }

  try {
    const { data, error } = await couponPromise;

    if (error) {
      // Never log the attempted code or any row contents.
      console.error('Coupon validation query failed:', error.code || 'unknown');
      return json(res, 500, {
        valid: false,
        error: 'Could not validate the discount code. Please try again.',
      });
    }

    const result = evaluateCoupon(data, cairoDateString(), input.code, subtotalInput.subtotal);
    if (!result.valid) {
      await rateLimitShared(lockKey, CODE_LOCK_ATTEMPTS, CODE_LOCK_WINDOW_MS);
    } else if (lock.count > 0) {
      // Nothing was recorded for this IP+code, so clearing it would only add a
      // write to the happy path. Clear it when failures are still on record.
      await resetRateLimitShared(lockKey);
    }
    return json(res, 200, result);
  } catch (err) {
    console.error('Coupon validation failed:', (err && err.name) || 'unknown');
    return json(res, 500, {
      valid: false,
      error: 'Could not validate the discount code. Please try again.',
    });
  }
}

module.exports = handler;
module.exports._test = {
  readCouponCode,
  readSubtotal,
  evaluateCoupon,
  INVALID_MESSAGE,
  RATE_MAX_ATTEMPTS,
  RATE_WINDOW_MS,
  CODE_LOCK_ATTEMPTS,
  CODE_LOCK_WINDOW_MS,
};
