/**
 * Coupon security + validation tests (no network, no Supabase calls).
 *
 *   node scripts/test-coupons.mjs
 *
 * Covers the cases required by the P0-1 fix: valid, expired, missing,
 * exhausted and malformed input — plus a source scan proving the storefront
 * no longer reads the coupons table with the anon key.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const endpoint = require('../api/coupons/validate.js');
const { readCouponCode, evaluateCoupon, INVALID_MESSAGE, RATE_MAX_ATTEMPTS } = endpoint._test ?? {};
const lib = require('../api/_lib.js');

if (typeof readCouponCode !== 'function' || typeof evaluateCoupon !== 'function') {
  console.error('FAIL: api/coupons/validate.js does not expose its pure helpers for testing');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) {
  eq(Boolean(value), true, label);
}

const TODAY = '2026-10-31';

const coupon = (over = {}) => ({
  code: 'SAVE10',
  type: 'percentage',
  value: 10,
  active: true,
  startDate: '2026-10-01',
  endDate: '2026-11-30',
  usageLimit: 100,
  usageCount: 0,
  ...over,
});

console.log('\n[1] input normalization / malformed input');
{
  eq(readCouponCode({ code: ' save10 ' }), { ok: true, code: 'SAVE10' }, 'trims + uppercases a valid code');
  eq(readCouponCode({ code: 'VIP_2026-1' }), { ok: true, code: 'VIP_2026-1' }, 'allows letters, digits, _ and -');
  eq(readCouponCode(null).ok, false, 'missing body rejected');
  eq(readCouponCode({}).ok, false, 'missing code rejected');
  eq(readCouponCode({ code: 123 }).ok, false, 'non-string code rejected');
  eq(readCouponCode({ code: '   ' }).ok, false, 'blank code rejected');
  eq(readCouponCode({ code: 'ab' }).ok, false, 'too short rejected');
  eq(readCouponCode({ code: 'x'.repeat(31) }).ok, false, 'too long rejected');
  eq(readCouponCode({ code: 'abc def' }).ok, false, 'spaces inside rejected');
  eq(readCouponCode({ code: '<script>' }).ok, false, 'markup rejected');
  eq(readCouponCode({ code: 'كود' }).ok, false, 'non-ascii rejected');
}

console.log('\n[2] correct / active coupon');
{
  const r = evaluateCoupon(coupon(), TODAY, 'SAVE10');
  eq(r.valid, true, 'percentage coupon valid');
  eq(r.discount, {
    code: 'SAVE10', type: 'percentage', value: 10, maxDiscount: null, minOrderAmount: 0,
  }, 'percentage coupon returns code/type/value + constraints');
  eq(Object.keys(r.discount).sort(), ['code', 'maxDiscount', 'minOrderAmount', 'type', 'value'],
    'response contains only the fields the bag needs');

  const fixed = evaluateCoupon(coupon({ type: 'fixed', value: 250 }), TODAY, 'SAVE10');
  eq(fixed.discount, {
    code: 'SAVE10', type: 'fixed', value: 250, maxDiscount: null, minOrderAmount: 0,
  }, 'fixed coupon valid');

  const unknownType = evaluateCoupon(coupon({ type: 'weird' }), TODAY, 'SAVE10');
  eq(unknownType.discount.type, 'fixed', 'unknown type matches api/orders.js (fixed fallback)');

  // SEC-06: discountValue is the legacy alias for value.
  const legacy = evaluateCoupon(coupon({ value: null, discountValue: 15 }), TODAY, 'SAVE10');
  eq(legacy.valid, true, 'discountValue-only row is accepted');
  eq(legacy.discount.value, 15, 'discountValue is used when value is missing');

  // Constraint metadata reaches the bag.
  const constrained = evaluateCoupon(
    coupon({ value: 20, maxDiscount: 100, minOrderAmount: 500 }), TODAY, 'SAVE10', 1000
  );
  eq(constrained.discount, {
    code: 'SAVE10', type: 'percentage', value: 20, maxDiscount: 100, minOrderAmount: 500,
  }, 'maxDiscount / minOrderAmount are returned to the client');

  // SEC-06: minimum order amount is enforced when a subtotal is supplied...
  const belowMin = evaluateCoupon(
    coupon({ minOrderAmount: 500 }), TODAY, 'SAVE10', 499
  );
  eq(belowMin, { valid: false, error: INVALID_MESSAGE }, 'subtotal below minOrderAmount rejected');
  // ...but the advisory endpoint stays usable when no subtotal is sent.
  eq(evaluateCoupon(coupon({ minOrderAmount: 500 }), TODAY, 'SAVE10').valid, true,
    'no subtotal ⇒ minimum is enforced at order time only');
}

console.log('\n[3] expired coupon (the real P0-1 row)');
{
  const expired = evaluateCoupon(
    coupon({ startDate: '2026-10-29', endDate: '2026-10-30' }),
    TODAY,
    'SAVE10'
  );
  eq(expired, { valid: false, error: INVALID_MESSAGE }, 'endDate before today is rejected');

  const notStarted = evaluateCoupon(coupon({ startDate: '2026-11-01' }), TODAY, 'SAVE10');
  eq(notStarted.valid, false, 'future startDate is rejected');
  eq(notStarted.error, INVALID_MESSAGE, 'same generic message (no window leak)');
}

console.log('\n[4] missing / inactive coupon');
{
  eq(evaluateCoupon(null, TODAY, 'SAVE10'), { valid: false, error: INVALID_MESSAGE }, 'not found is rejected generically');
  eq(evaluateCoupon(undefined, TODAY), { valid: false, error: INVALID_MESSAGE }, 'undefined row is rejected');
  eq(evaluateCoupon(coupon({ active: false }), TODAY, 'SAVE10').valid, false, 'inactive coupon rejected');
  eq(evaluateCoupon(coupon({ code: 'OTHER' }), TODAY, 'SAVE10').valid, false, 'row/code mismatch rejected');
}

console.log('\n[5] usage limit');
{
  eq(evaluateCoupon(coupon({ usageCount: 100, usageLimit: 100 }), TODAY, 'SAVE10').valid, false, 'exhausted coupon rejected');
  eq(evaluateCoupon(coupon({ usageCount: 101, usageLimit: 100 }), TODAY, 'SAVE10').valid, false, 'over-limit coupon rejected');
  eq(evaluateCoupon(coupon({ usageCount: 99, usageLimit: 100 }), TODAY, 'SAVE10').valid, true, 'last remaining use accepted');
  eq(evaluateCoupon(coupon({ usageCount: 0, usageLimit: 0 }), TODAY, 'SAVE10').valid, false, 'zero limit means no uses (unchanged semantics)');
  eq(evaluateCoupon(coupon({ value: 'not-a-number' }), TODAY, 'SAVE10').valid, false, 'corrupt value rejected');
}

console.log('\n[6] rate limiter');
{
  const key = `coupon-test:${Date.now()}`;
  let last = null;
  for (let i = 0; i < RATE_MAX_ATTEMPTS; i += 1) last = lib.rateLimit(key, RATE_MAX_ATTEMPTS, 60000);
  eq(last.allowed, true, `attempt ${RATE_MAX_ATTEMPTS} still allowed`);
  const blocked = lib.rateLimit(key, RATE_MAX_ATTEMPTS, 60000);
  eq(blocked.allowed, false, 'next attempt blocked');
  ok(blocked.resetIn > 0, 'Retry-After window is positive');
}

console.log('\n[6b] SEC-06 pricing matrix (api + SQL share one rule)');
{
  const { computeCouponDiscount, couponIsRedeemable, validateCouponPayload } = lib;
  const price = (over, subtotal) => {
    const r = computeCouponDiscount(coupon(over), subtotal);
    return r.ok ? r.discount : `!${r.reason}`;
  };

  eq(price({ type: 'percentage', value: 10 }, 1000), 100, '10% of 1000 = 100');
  eq(price({ type: 'percentage', value: 10 }, 999), 100, 'percentage rounds half-up (99.9 → 100)');
  eq(price({ type: 'fixed', value: 250 }, 1000), 250, 'fixed 250 on 1000 = 250');
  eq(price({ type: 'fixed', value: 5000 }, 1000), 1000, 'fixed discount never exceeds the cart');
  eq(price({ type: 'percentage', value: 10, maxDiscount: 50 }, 1000), 50, 'maxDiscount caps a percentage');
  eq(price({ type: 'fixed', value: 250, maxDiscount: 100 }, 1000), 100, 'maxDiscount caps a fixed coupon');
  eq(price({ type: 'percentage', value: 10, maxDiscount: 0 }, 1000), 100, 'maxDiscount 0 = no cap');
  eq(price({ type: 'percentage', value: 150 }, 100), 100, 'a corrupt >100% value cannot exceed the cart');
  eq(price({ value: null, discountValue: 15, type: 'fixed' }, 1000), 15, 'discountValue fallback prices correctly');
  eq(price({ value: '15', type: 'fixed' }, 1000), 15, 'numeric strings are accepted');
  eq(price({ value: 'bad' }, 1000), '!invalid_value', 'corrupt value rejected');
  eq(price({ value: 10, minOrderAmount: 500 }, 499), '!min_order_amount', 'below minimum rejected');
  eq(price({ value: 10, minOrderAmount: 500 }, 500), 50, 'exactly at the minimum accepted');
  eq(price({ value: 10 }, 0), '!invalid_subtotal', 'zero subtotal rejected');

  eq(couponIsRedeemable(coupon(), TODAY), true, 'redeemable baseline');
  eq(couponIsRedeemable(coupon({ active: false }), TODAY), false, 'inactive not redeemable');
  eq(couponIsRedeemable(coupon({ usageCount: 100 }), TODAY), false, 'exhausted not redeemable');
  eq(couponIsRedeemable(coupon({ value: null, discountValue: null }), TODAY), false, 'no value not redeemable');
  eq(couponIsRedeemable(coupon({ value: null, discountValue: 5 }), TODAY), true, 'legacy value is redeemable');

  const okPayload = validateCouponPayload(coupon({
    value: 20, minOrderAmount: 500, maxDiscount: 150, usageLimit: 10,
  }));
  eq(okPayload.value, 20, 'validate: value kept');
  eq(okPayload.discountValue, 20, 'validate: value mirrored into discountValue');
  eq(okPayload.minOrderAmount, 500, 'validate: minOrderAmount kept');
  eq(okPayload.maxDiscount, 150, 'validate: maxDiscount kept');

  const legacyPayload = validateCouponPayload(coupon({
    value: undefined, discountValue: 30, minOrderAmount: '', maxDiscount: '',
  }));
  eq(legacyPayload && legacyPayload.value, 30, 'validate: discountValue promoted to value');
  eq(legacyPayload.minOrderAmount, 0, 'validate: empty minimum becomes 0');
  eq(legacyPayload.maxDiscount, null, 'validate: empty cap becomes null');

  eq(validateCouponPayload(coupon({ type: 'percentage', value: 101 })), null, 'validate: >100% rejected');
  eq(validateCouponPayload(coupon({ value: 0 })), null, 'validate: zero value rejected');
  eq(validateCouponPayload(coupon({ minOrderAmount: -1 })), null, 'validate: negative minimum rejected');
  eq(validateCouponPayload(coupon({ maxDiscount: -1 })), null, 'validate: negative cap rejected');
  eq(validateCouponPayload(coupon({ endDate: '2026-01-01', startDate: '2026-02-01' })), null,
    'validate: end before start rejected');
}

console.log('\n[7] source scan: no storefront coupon reads');
{
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs)$/.test(name)) files.push(full);
    }
  };
  walk(`${root}/src`);

  const offenders = files.filter((file) => {
    const src = readFileSync(file, 'utf8');
    return /\.from\(\s*['"]coupons['"]\s*\)/.test(src) || /\/rest\/v1\/coupons/.test(src);
  });
  eq(offenders.map((f) => f.replace(root, '')), [], 'no src file queries the coupons table');

  const security = readFileSync(`${root}/src/lib/security.js`, 'utf8');
  ok(/localStorage\.removeItem\('zashm_db_coupons'\)/.test(security), 'legacy coupon cache is purged');
  ok(!/for \(const store of \['products', 'coupons'\]\)/.test(security), 'syncFromServer no longer iterates coupons');

  const store = readFileSync(`${root}/src/store.js`, 'utf8');
  ok(/api\.post\('\/coupons\/validate'/.test(store), 'store uses the validation endpoint');
  ok(!/db\.setAll\('discounts'/.test(store), 'coupon list is never persisted locally');

  const adminCouponsSrc = readFileSync(`${root}/api/admin/coupons.js`, 'utf8');
  ok(/usageCount:\s*0/.test(adminCouponsSrc), 'coupon creation never accepts a caller-controlled usage count');
  const updateKeys = adminCouponsSrc.match(/const allowedKeys = \[([\s\S]*?)\];/)?.[1] || '';
  ok(!/\busageCount\b/.test(updateKeys), 'coupon updates cannot overwrite the server-maintained usage count');

  const endpointSrc = readFileSync(`${root}/api/coupons/validate.js`, 'utf8');
  ok(!/\.select\(\s*['"]\*['"]\s*\)/.test(endpointSrc), 'public endpoint selects explicit columns only');
  ok(/Cache-Control', 'no-store'/.test(endpointSrc), 'public endpoint responses are not cacheable');
  ok(/const lockPromise = rateLimitPeekShared\(lockKey\)/.test(endpointSrc) &&
     /const couponPromise = \(async \(\) =>/.test(endpointSrc),
    'coupon lock peek and coupon lookup run in parallel');
  ok(/const lock = await lockPromise;[\s\S]*?lock\.count >= CODE_LOCK_ATTEMPTS/.test(endpointSrc),
    'an exhausted IP+code lockout still wins before any result is returned');
  ok(/else if \(lock\.count > 0\)[\s\S]*?resetRateLimitShared\(lockKey\)/.test(endpointSrc),
    'successful validation clears the failure counter only when one was recorded');

  const cartPage = readFileSync(`${root}/src/pages/CartPage.js`, 'utf8');
  ok(/function warmCouponEndpoint/.test(cartPage) &&
     /method: 'OPTIONS'/.test(cartPage) &&
     /onFocus=\{warmCouponEndpoint\}/.test(cartPage) &&
     /React\.useEffect\(\(\) => \{ warmCouponEndpoint\(\); \}, \[\]\)/.test(cartPage),
    'the bag/checkout page and the coupon field warm the endpoint before apply');
  ok((cartPage.match(/\{couponApplying \? 'Checking…' : 'Apply'\}/g) || []).length === 2 &&
     /minWidth: 96/.test(cartPage),
    'both apply buttons show a stable-width Checking state while validating');

  const adminCoupons = adminCouponsSrc;
  ok(/requirePerm\(req, res, 'discounts\.read'\)/.test(adminCoupons), 'admin coupon list requires discounts.read');
  ok(/requirePerm\(req, res, 'discounts\.write'\)/.test(adminCoupons), 'admin coupon delete requires discounts.write');
  ok(/from\('orders'\)/.test(adminCoupons) && /openOrders/.test(adminCoupons),
    'coupon delete refuses coupons referenced by open orders');
  ok(/23503/.test(adminCoupons), 'the database delete-guard error is mapped to a safe conflict');

  const lifecycle = readFileSync(`${root}/supabase/atomic_order_lifecycle.sql`, 'utf8');
  ok(/zshm_guard_coupon_delete/.test(lifecycle), 'the lifecycle migration defines the coupon delete guard');
  ok(/coupon_not_found/.test(lifecycle), 'a deleted coupon no longer blocks cancel/delete');
  ok(/PARTIAL RESTORE/.test(lifecycle), 'partial stock restore is documented in the lifecycle migration');

  const orders = readFileSync(`${root}/api/orders.js`, 'utf8');
  ok(/\.from\('coupons'\)/.test(orders), 'api/orders.js still validates coupons server-side');
  ok(/couponIsRedeemable\(c, today\)/.test(orders), 'api/orders.js uses the shared redeemability rule');
  ok(/computeCouponDiscount\(c, subtotal\)/.test(orders), 'api/orders.js uses the shared pricing rule');
  ok(!/\.select\('\*'\)[\s\S]{0,80}\.eq\('code'/.test(orders), 'order coupon lookup selects explicit columns');
  ok(/c\.startDate/.test(orders) === false, 'order coupon lookup no longer hand-rolls the date window');

  const placeSql = readFileSync(`${root}/supabase/atomic_place_order.sql`, 'utf8');
  ok(/FOR UPDATE/.test(placeSql) && /coupon_changed/.test(placeSql), 'RPC recomputes and locks the coupon');
  ok(/"minOrderAmount"/.test(placeSql) && /"maxDiscount"/.test(placeSql) && /"discountValue"/.test(placeSql),
    'RPC applies minOrderAmount / maxDiscount / discountValue');
  ok(/inactive_product/.test(placeSql), 'RPC rejects inactive products');
  ok(!/- COALESCE\(v_prod\."reservedStock", 0\)/.test(placeSql),
    'availability math no longer subtracts reservedStock');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
