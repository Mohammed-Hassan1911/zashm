/**
 * Group D — edge/transport tests.
 *
 *   node scripts/test-edge-transport.mjs
 *
 * Covers:
 *   - vercel.json: X-Robots-Tag on private paths, hardened CSP, COOP
 *   - vercel.json: explicit SPA rewrites (unknown paths become a real 404)
 *   - storage_hardening.sql: bucket size/MIME limits + no browser write policy
 *   - shared rate limiter (Upstash REST when configured, in-memory fallback)
 *   - /api/coupons/validate per-IP + per-code lockout (handler level)
 *   - Cache-Control: no-store on coupon responses
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Module from 'node:module';

const require = createRequire(import.meta.url);

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
function ok(value, label) { eq(Boolean(value), true, label); }

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

// ─── Fake database (coupons only) ───────────────────────────────────────────
const state = { coupons: new Map(), failQuery: false, rateLimitRpc: false };
const rateCounters = new Map();

function couponRow(over = {}) {
  return {
    code: 'SAVE10',
    type: 'percentage',
    value: 10,
    discountValue: 10,
    minOrderAmount: null,
    maxDiscount: null,
    active: true,
    startDate: '2020-01-01',
    endDate: '2099-12-31',
    usageLimit: 100,
    usageCount: 0,
    ...over,
  };
}

const sb = {
  async rpc(name, args) {
    if (name !== 'zshm_rate_limit' || !state.rateLimitRpc) {
      return { data: null, error: { code: 'RPC_UNAVAILABLE' } };
    }
    const now = Date.now();
    let counter = rateCounters.get(args.p_key);
    if (args.p_action === 'reset') {
      rateCounters.delete(args.p_key);
      return { data: { allowed: true, count: 0, remaining: args.p_max_attempts, resetIn: 0 }, error: null };
    }
    if (args.p_action === 'peek') {
      if (!counter || counter.resetAt <= now) {
        return { data: { allowed: true, count: 0, remaining: args.p_max_attempts, resetIn: 0 }, error: null };
      }
      return {
        data: {
          allowed: counter.count <= args.p_max_attempts,
          count: counter.count,
          remaining: Math.max(0, args.p_max_attempts - counter.count),
          resetIn: Math.ceil((counter.resetAt - now) / 1000),
        },
        error: null,
      };
    }
    if (!counter || counter.resetAt <= now) {
      counter = { count: 0, resetAt: now + args.p_window_seconds * 1000 };
    }
    counter.count += 1;
    rateCounters.set(args.p_key, counter);
    return {
      data: {
        allowed: counter.count <= args.p_max_attempts,
        count: counter.count,
        remaining: Math.max(0, args.p_max_attempts - counter.count),
        resetIn: Math.ceil((counter.resetAt - now) / 1000),
      },
      error: null,
    };
  },
  from(table) {
    const q = {
      _code: null,
      select() { return q; },
      eq(col, val) { if (col === 'code') q._code = val; return q; },
      async maybeSingle() {
        await new Promise((r) => setTimeout(r, 0));
        if (state.failQuery) return { data: null, error: { code: 'TEST' } };
        if (table !== 'coupons') return { data: null, error: null };
        return { data: state.coupons.get(q._code) || null, error: null };
      },
    };
    return q;
  },
};

process.env.SESSION_SECRET = 'test-session-secret-for-edge-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => sb };
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
lib.supabaseAdmin();
const couponHandler = require('../api/coupons/validate.js');
Module._load = originalLoad;

// ─── HTTP fakes ─────────────────────────────────────────────────────────────
let ipCounter = 1;
function makeReq({ method = 'POST', body, headers = {}, ip } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip || `198.51.100.${(ipCounter++ % 250) + 1}`,
      ...headers,
    },
    query: {},
    socket: { remoteAddress: '198.51.100.1' },
    on(event, cb) {
      if (event === 'data' && text) setImmediate(() => cb(Buffer.from(text)));
      if (event === 'end') setImmediate(() => cb());
      return req;
    },
    destroy() {},
  };
  return req;
}
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(text) { this.body = text ? JSON.parse(text) : null; this.done = true; },
  };
}
async function validate(body, ip = '198.51.100.200') {
  const req = makeReq({ body, ip });
  const res = makeRes();
  await couponHandler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

// ─── [1] vercel.json ────────────────────────────────────────────────────────
console.log('\n[1] transport headers + rewrites');
{
  const cfg = JSON.parse(read('vercel.json'));
  const all = cfg.headers || [];
  const headerFor = (source, key) => {
    const entry = all.find((h) => h.source === source);
    if (!entry) return null;
    const found = entry.headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
    return found ? found.value : null;
  };

  const globalEntry = all.find((h) => h.source === '/(.*)');
  const csp = globalEntry.headers.find((h) => h.key === 'Content-Security-Policy').value;
  ok(/script-src-attr 'none'/.test(csp), "CSP forbids inline event-handler attributes");
  ok(/object-src 'none'/.test(csp), 'CSP forbids plugins');
  ok(/frame-ancestors 'none'/.test(csp), 'CSP forbids framing');
  ok(/base-uri 'self'/.test(csp), 'CSP pins base-uri');
  eq(headerFor('/(.*)', 'Cross-Origin-Opener-Policy'), 'same-origin', 'COOP is set');

  for (const source of ['/admin(.*)', '/checkout(.*)', '/cart(.*)', '/wishlist(.*)', '/track(.*)', '/api/(.*)']) {
    ok((headerFor(source, 'X-Robots-Tag') || '').includes('noindex'), `${source} is noindex`);
  }

  const rewrites = cfg.rewrites || [];
  const sources = rewrites.map((r) => r.source);
  for (const path of ['/shop', '/cart', '/checkout', '/wishlist', '/track', '/admin', '/product/:path*']) {
    ok(sources.includes(path), `rewrite exists for ${path}`);
  }
  ok(!sources.some((s) => s === '/(.*)' || s === '/:path*'), 'no catch-all rewrite (unknown paths 404)');
  eq(cfg.trailingSlash, false, 'trailing slashes are normalised');

  // The Vercel project was created with the "Create React App" preset, which
  // appends its own `/(.*) -> /index.html` route at build time. That route is
  // invisible in vercel.json and made every unknown path return HTTP 200.
  // Pinning the preset to "Other" keeps Vercel's real 404 route
  // (`status: 404` -> /404.html) in the build output.
  eq(cfg.framework, null, 'framework preset is overridden so Vercel keeps the real 404 route');

  const notFoundPage = read('public/404.html');
  ok(/<meta name="robots" content="noindex, nofollow"/.test(notFoundPage),
    'the static 404 page is noindex');
  ok(/Return Home/.test(notFoundPage) && /الصفحة غير موجودة/.test(notFoundPage),
    'the static 404 page is bilingual');
  ok(/href="\/"/.test(notFoundPage) && /href="\/shop"/.test(notFoundPage),
    'the static 404 page links back to the store');
}

// ─── [2] storage migration ──────────────────────────────────────────────────
console.log('\n[2] storage hardening migration');
{
  const sql = read('supabase/storage_hardening.sql');
  ok(/UPDATE storage\.buckets/.test(sql), 'bucket settings are updated');
  ok(/file_size_limit = 5242880/.test(sql), '5 MB file size limit');
  ok(/allowed_mime_types = ARRAY\[/.test(sql), 'MIME allow-list is set');
  ok(/image\/avif/.test(sql) && /image\/jpeg/.test(sql) && /image\/webp/.test(sql), 'expected image types allowed');
  ok(/ALTER TABLE storage\.objects ENABLE ROW LEVEL SECURITY/.test(sql), 'RLS enable is present and ownership-guarded');
  ok(/pg_has_role\(c\.relowner, 'USAGE'\)/.test(sql), 'storage.objects ownership is checked before DDL');
  ok(/RAISE EXCEPTION 'storage\.objects RLS is disabled/.test(sql),
    'RLS is never left disabled without a hard stop');
  ok(/DROP POLICY IF EXISTS/.test(sql), 'products-scoped policies can be removed');
  ok(/IF v_can_manage THEN[\s\S]{0,400}DROP POLICY/.test(sql),
    'DROP POLICY only runs with storage.objects ownership');
  ok(/MANUAL ACTION REQUIRED/.test(sql), 'products-only policies are reported for Dashboard removal');
  ok(/service role/i.test(sql), 'service-role-only writes are documented');
  ok(!/CREATE POLICY[\s\S]{0,80}FOR (INSERT|UPDATE|DELETE|ALL)/i.test(sql), 'no browser write policy is created');

  // REVISION 3: conservative deletion + verbatim backup/restore.
  ok(/CREATE TABLE IF NOT EXISTS public\.zshm_storage_policy_backup/.test(sql),
    'removed policies are backed up verbatim');
  ok(/CREATE OR REPLACE FUNCTION public\.zshm_restore_storage_policies/.test(sql),
    'a restore function is provided');
  ok(/CREATE POLICY zshm_products_no_public_listing[\s\S]{0,300}AS RESTRICTIVE[\s\S]{0,250}USING \(bucket_id <> 'products'\)/.test(sql),
    'restrictive policy denies browser listing of product objects without affecting public downloads');
  const rateLimitSql = read('supabase/rate_limit_storage.sql');
  ok(/CREATE OR REPLACE FUNCTION public\.zshm_rate_limit/.test(rateLimitSql),
    'shared database rate-limit RPC migration is present');
  ok(/REVOKE ALL ON FUNCTION public\.zshm_rate_limit[\s\S]*GRANT EXECUTE ON FUNCTION public\.zshm_rate_limit[\s\S]*TO service_role/.test(rateLimitSql),
    'shared rate-limit RPC is restricted to service_role');
  const libSource = read('api/_lib.js');
  ok(/databaseRateLimit\(key, maxAttempts, windowSec, 'consume'\)/.test(libSource),
    'database rate limiter is used when Upstash is missing or fails');
  ok(/zshm_storage_policy_scope_is_products/.test(sql),
    'only provably products-only expressions qualify');
  ok(/IF v_required\s+AND v_scope_ok[\s\S]{0,3000}DROP POLICY/.test(sql),
    'DROP is guarded by command applicability + products-only scope');
  ok(/KEPT storage\.objects policy/.test(sql),
    'blanket/other-bucket policies are kept for manual review');
  ok(/blanket policy applies to every bucket/.test(sql),
    'blanket policies are explicitly documented as kept');
  ok(/Back up BEFORE any removal/.test(sql), 'backup is written before the DROP');
  ok(/IF v_backup_id IS NULL THEN[\s\S]{0,500}INSERT INTO public\.zshm_storage_policy_backup/.test(sql),
    'manual-removal policies are backed up before Dashboard removal');
  ok(/REVOKE ALL ON public\.zshm_storage_policy_backup FROM PUBLIC, anon, authenticated/.test(sql),
    'the backup table is not browser-readable');
}

// ─── [3] shared rate limiter ────────────────────────────────────────────────
console.log('\n[3] durable rate limiter');
const realFetch = globalThis.fetch;
{
  // Fallback path (no Upstash env).
  const key = `edge-test:${Date.now()}`;
  let last;
  for (let i = 0; i < 3; i += 1) last = await lib.rateLimitShared(key, 3, 60000);
  eq(last.allowed, true, 'fallback allows up to the limit');
  const blocked = await lib.rateLimitShared(key, 3, 60000);
  eq(blocked.allowed, false, 'fallback blocks over the limit');
  ok(blocked.resetIn > 0, 'fallback reports a reset window');

  // The SQL RPC is the shared fallback when Upstash is missing or unavailable.
  state.rateLimitRpc = true;
  const dbKey = `database-fallback:${Date.now()}`;
  const dbFirst = await lib.rateLimitShared(dbKey, 2, 60000);
  const dbSecond = await lib.rateLimitShared(dbKey, 2, 60000);
  const dbBlocked = await lib.rateLimitShared(dbKey, 2, 60000);
  eq([dbFirst.allowed, dbSecond.allowed, dbBlocked.allowed], [true, true, false],
    'database RPC enforces a shared limit when Upstash is absent');
  eq((await lib.rateLimitPeekShared(dbKey)).count, 3, 'database RPC peek does not increment the counter');
  await lib.resetRateLimitShared(dbKey);
  eq((await lib.rateLimitPeekShared(dbKey)).count, 0, 'database RPC reset clears the shared counter');

  // Upstash path.
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example/';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ([{ result: 4 }, { result: 'OK' }, { result: 42 }]) };
  };
  const r = await lib.rateLimitShared('shared:key', 5, 60000);
  eq(r, { allowed: true, remaining: 1, resetIn: 42 }, 'Upstash result is mapped');
  eq(calls[0].url, 'https://redis.example/pipeline', 'calls the Upstash pipeline endpoint');
  eq(calls[0].opts.headers.Authorization, 'Bearer test-token', 'sends the REST token');
  const cmds = JSON.parse(calls[0].opts.body);
  eq(cmds[0][0], 'INCR', 'increments the counter');
  eq(cmds[1][0], 'EXPIRE', 'sets the TTL only when missing');
  eq(cmds[1][2], '60', 'TTL matches the window');

  globalThis.fetch = async () => ({ ok: true, json: async () => ([{ result: 1 }, { result: 'OK' }, { result: -1 }]) });
  const noTtl = await lib.rateLimitShared('shared:not tl', 5, 90000);
  eq(noTtl.resetIn, 90, 'missing Redis TTL falls back to the window');

  globalThis.fetch = async () => ({ ok: true, json: async () => ([{ result: '7' }, { result: -1 }]) });
  const peek = await lib.rateLimitPeekShared('shared:peek');
  eq(peek.count, 7, 'peek reads without incrementing');
  eq(peek.resetIn, 0, 'peek reports an unknown TTL as 0');

  globalThis.fetch = async () => { throw new Error('redis down'); };
  const redisDownKey = `redis-down:${Date.now()}`;
  const fellBack = await lib.rateLimitShared(redisDownKey, 1, 60000);
  eq(fellBack.allowed, true, 'Redis outage falls back to the shared database limiter');
  const fellBackAgain = await lib.rateLimitShared(redisDownKey, 1, 60000);
  eq(fellBackAgain.allowed, false, 'database fallback retains the limit during a Redis outage');

  // A pipeline can return 200 with an error attached to one command (bad auth,
  // wrong type, ...). That must be treated as an outage, not as "no counter".
  globalThis.fetch = async () => ({ ok: true, json: async () => ([{ error: 'WRONGTYPE' }, { result: 'OK' }, { result: 42 }]) });
  const commandError = await lib.rateLimitShared(`redis-cmd-error:${Date.now()}`, 1, 60000);
  eq(commandError.allowed, true, 'per-command Redis error falls back instead of failing open silently');
  ok(commandError.resetIn > 0, 'fallback after a command error still has a window');

  // An HTTP timeout/abort is also a fallback, not a crash.
  globalThis.fetch = async (url, opts) => {
    ok(Boolean(opts && opts.signal), 'Upstash fetch receives an AbortSignal');
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const httpError = await lib.rateLimitShared(`redis-http-error:${Date.now()}`, 2, 60000);
  eq(httpError.allowed, true, 'Upstash HTTP error falls back to the in-memory limiter');

  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  state.rateLimitRpc = false;
  globalThis.fetch = realFetch;
}

// ─── [4] coupon lockout (handler level) ─────────────────────────────────────
console.log('\n[4] coupon per-code lockout');
{
  state.coupons.clear();
  state.failQuery = false;
  state.coupons.set('SAVE10', couponRow());

  const ip = '198.51.100.77';

  // Valid code always works and clears any failures.
  let r = await validate({ code: 'SAVE10' }, ip);
  eq(r.status, 200, 'valid code accepted');
  eq(r.body.valid, true, 'valid flag is true');
  eq(r.headers['cache-control'], 'no-store', 'coupon response is not cacheable');

  // Five failures on a specific code → 429 on the next attempt.
  for (let i = 0; i < 5; i += 1) {
    r = await validate({ code: 'NOPE123' }, ip);
    eq(r.status, 200, `failed attempt ${i + 1} returns 200 with a generic message`);
    eq(r.body.valid, false, `failed attempt ${i + 1} is invalid`);
  }
  r = await validate({ code: 'NOPE123' }, ip);
  eq(r.status, 429, 'sixth failure on the same code → 429');
  eq(r.body.rateLimited, true, 'lockout is flagged');
  ok(Number(r.headers['retry-after']) > 0, 'Retry-After is present');

  // A different IP is unaffected (the lock is per IP + code, not global).
  r = await validate({ code: 'SAVE10' }, '198.51.100.78');
  eq(r.status, 200, 'another IP can still validate a code');
  eq(r.body.valid, true, 'the valid code is not globally locked');

  // A different code from the same IP is unaffected.
  r = await validate({ code: 'OTHER1' }, ip);
  eq(r.status, 200, 'a different code from the same IP is not blocked');
}

// ─── [5] source scan ────────────────────────────────────────────────────────
console.log('\n[5] every API handler uses the shared limiter');
{
  const files = [
    'api/orders.js', 'api/auth.js', 'api/admin/orders.js', 'api/admin/products.js',
    'api/admin/users.js', 'api/admin/upload.js', 'api/admin/coupons.js',
    'api/coupons/validate.js',
  ];
  for (const file of files) {
    const src = read(file);
    ok(/await rateLimitShared\(/.test(src), `${file} awaits rateLimitShared`);
    ok(!/[^t]rateLimit\(/.test(src.replace(/rateLimitShared\(/g, '')), `${file} has no synchronous limiter call`);
  }
  const libSrc = read('api/_lib.js');
  ok(/UPSTASH_REDIS_REST_URL/.test(libSrc) && /UPSTASH_REDIS_REST_TOKEN/.test(libSrc),
    'Upstash is env-gated');
  ok(/using per-instance fallback/.test(libSrc), 'Redis failure logs a fallback');
  ok(/RATE_BUCKET_MAX/.test(libSrc), 'the in-memory fallback map is bounded');
  ok(/AbortSignal|AbortController/.test(libSrc), 'Upstash calls are time-bounded');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
