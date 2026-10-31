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
  eq(r, { valid: true, discount: { code: 'SAVE10', type: 'percentage', value: 10 } }, 'percentage coupon valid');
  eq(Object.keys(r.discount).sort(), ['code', 'type', 'value'], 'response contains only code/type/value');

  const fixed = evaluateCoupon(coupon({ type: 'fixed', value: 250 }), TODAY, 'SAVE10');
  eq(fixed, { valid: true, discount: { code: 'SAVE10', type: 'fixed', value: 250 } }, 'fixed coupon valid');

  const unknownType = evaluateCoupon(coupon({ type: 'weird' }), TODAY, 'SAVE10');
  eq(unknownType.discount.type, 'fixed', 'unknown type matches api/orders.js (fixed fallback)');
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

  const endpointSrc = readFileSync(`${root}/api/coupons/validate.js`, 'utf8');
  ok(!/\.select\(\s*['"]\*['"]\s*\)/.test(endpointSrc), 'public endpoint selects explicit columns only');
  ok(/Cache-Control', 'no-store'/.test(endpointSrc), 'public endpoint responses are not cacheable');

  const adminCoupons = readFileSync(`${root}/api/admin/coupons.js`, 'utf8');
  ok(/requirePerm\(req, res, 'discounts\.read'\)/.test(adminCoupons), 'admin coupon list requires discounts.read');

  const orders = readFileSync(`${root}/api/orders.js`, 'utf8');
  ok(/\.from\('coupons'\)/.test(orders), 'api/orders.js still validates coupons server-side');
  ok(/usageCount\s*\|\|\s*0\)\s*<\s*Number\(c\.usageLimit/.test(orders), 'api/orders.js keeps the usage limit check');
  ok(/c\.startDate/.test(orders) && /c\.endDate/.test(orders), 'api/orders.js keeps the date window check');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
