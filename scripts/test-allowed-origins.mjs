/**
 * ALLOWED_ORIGINS fail-closed tests.
 *
 *   node scripts/test-allowed-origins.mjs
 *
 * Two layers are proven with no network and no live credentials:
 *   1. src/lib/production-env.mjs rejects missing, empty, malformed and
 *      retired/loopback/Staging origins before a Production Worker serves;
 *   2. api/_lib.js refuses CORS grants and unsafe methods in Production when
 *      the binding is missing or unsafe, while Development, Testing and
 *      Staging keep their historical fallback unchanged.
 *
 * Admin, checkout and CSRF impact is exercised through the real requirePerm()
 * and enforceMutationOrigin() helpers with a fake Supabase client.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import {
  PRODUCTION_ENV_FLAG,
  STAGING_SUPABASE_REF,
  STAGING_WORKER_HOST,
  TEMP_WORKERS_DEV_FLAG,
  TEMP_WORKERS_DEV_ORIGIN,
  allowedOriginsFromEnv,
  productionConfigProblems,
} from '../src/lib/production-env.mjs';

let passed = 0;
let failed = 0;

function report(condition, message, detail) {
  if (condition) {
    passed += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${message}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${message}${detail ? `\n       ${detail}` : ''}`);
  }
}

function ok(value, message) {
  report(Boolean(value), message, `got ${String(value)}`);
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  report(a === e, message, `expected ${e}, got ${a}`);
}

function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const require = createRequire(import.meta.url);
const OLD_VERCEL = 'https://za-shm.vercel.app';
const LOCALHOST = 'http://localhost:3000';
const EVIL = 'https://evil.example';

const ENV_KEYS = [
  PRODUCTION_ENV_FLAG,
  'ALLOWED_ORIGINS',
  'PUBLIC_BASE_URL',
  TEMP_WORKERS_DEV_FLAG,
  'SESSION_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'REACT_APP_SUPABASE_URL',
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function productionEnv(overrides = {}) {
  return {
    [PRODUCTION_ENV_FLAG]: 'production',
    VITE_SUPABASE_URL: 'https://ptegprcbtfylqhbnbkih.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SESSION_SECRET: 'test-session-secret-for-allowed-origin-tests',
    PUBLIC_BASE_URL: TEMP_WORKERS_DEV_ORIGIN,
    ALLOWED_ORIGINS: TEMP_WORKERS_DEV_ORIGIN,
    [TEMP_WORKERS_DEV_FLAG]: '1',
    ...overrides,
  };
}

function hasProblem(env, text) {
  return productionConfigProblems(env).some((line) => line.includes(text));
}

function applyEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = String(value);
  }
  // The fake Supabase client is installed below; these values are local only.
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
}

section(1, 'runtime contract');
const libSrc = readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8');
const prodEnvSrc = readFileSync(new URL('../src/lib/production-env.mjs', import.meta.url), 'utf8');
const prodConfig = readFileSync(new URL('../wrangler.production.toml', import.meta.url), 'utf8');
const stagingConfig = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
ok(libSrc.includes("const PRODUCTION_ENV_FLAG = 'ZASHM_ENVIRONMENT'"), 'the API recognises the Production flag');
ok(libSrc.includes("if (isProductionRuntime()) return productionAllowedOrigins();"), 'the API uses the Production-only allow-list');
for (const value of [TEMP_WORKERS_DEV_ORIGIN, STAGING_WORKER_HOST, STAGING_SUPABASE_REF]) {
  ok(libSrc.includes(value) && prodEnvSrc.includes(value), `the two layers agree on ${value}`);
}
ok(prodConfig.includes(`ALLOWED_ORIGINS = "${TEMP_WORKERS_DEV_ORIGIN}"`), 'Production binds only the current Cloudflare origin');
ok(!stagingConfig.includes('ZASHM_ENVIRONMENT'), 'Staging has no Production flag');
for (const file of ['api/orders.js', 'api/coupons/validate.js', 'api/reviews.js', 'api/_errors.js']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  ok(/enforceMutationOrigin\(req, res\)/.test(src), `${file} uses the shared origin gate for public mutations`);
}

section(2, 'Production guard accepts only explicit, production-safe origins');
eq(productionConfigProblems(productionEnv()), [], 'the current Cloudflare Production binding passes');
eq(productionConfigProblems(productionEnv({
  PUBLIC_BASE_URL: 'https://zashm.example',
  ALLOWED_ORIGINS: 'https://zashm.example',
})), [], 'a future paid domain passes when both canonical bindings change together');
eq(allowedOriginsFromEnv(productionEnv()), [TEMP_WORKERS_DEV_ORIGIN], 'the guard exposes only the exact Production allow-list');
eq(allowedOriginsFromEnv(productionEnv({ ALLOWED_ORIGINS: `${TEMP_WORKERS_DEV_ORIGIN}, ${OLD_VERCEL}` })), [],
  'an unsafe list is never exposed as a valid Production allow-list');
eq(allowedOriginsFromEnv({ ...productionEnv(), [PRODUCTION_ENV_FLAG]: undefined }), [],
  'a non-Production runtime has no Production allow-list');
eq(productionConfigProblems({
  ...productionEnv(),
  [PRODUCTION_ENV_FLAG]: 'staging',
  ALLOWED_ORIGINS: OLD_VERCEL,
}), [], 'non-Production runtimes are not subject to the Production allow-list guard');

const missingCases = [
  ['missing', undefined, 'ALLOWED_ORIGINS is missing'],
  ['empty', '', 'ALLOWED_ORIGINS is missing'],
  ['whitespace only', '   ', 'ALLOWED_ORIGINS is missing'],
  ['preparation placeholder', 'PREP_ALLOWED_ORIGIN', 'placeholder'],
];
for (const [label, value, expected] of missingCases) {
  ok(hasProblem(productionEnv({ ALLOWED_ORIGINS: value }), expected), `${label} ALLOWED_ORIGINS is rejected`);
}

const badOrigins = [
  ['retired Vercel origin', OLD_VERCEL, 'retired Vercel'],
  ['uppercase Vercel origin', 'https://ZA-SHm.VERCEL.app', 'retired Vercel'],
  ['mixed Cloudflare and Vercel', `${TEMP_WORKERS_DEV_ORIGIN}, ${OLD_VERCEL}`, 'retired Vercel'],
  ['bare wildcard', '*', 'wildcards'],
  ['wildcard https origin', 'https://*', 'wildcards'],
  ['localhost', LOCALHOST, 'localhost'],
  ['loopback IP', 'http://127.0.0.1:3000', 'localhost'],
  ['https localhost', 'https://localhost', 'localhost'],
  ['Staging Supabase ref', `https://${STAGING_SUPABASE_REF}.example`, 'Staging origin'],
  ['Staging Worker host', `https://${STAGING_WORKER_HOST}`, 'Staging origin'],
  ['unapproved workers.dev', 'https://other.za-shm.workers.dev', 'workers.dev'],
  ['canonical workers.dev without opt-in', TEMP_WORKERS_DEV_ORIGIN, 'opt-in'],
  ['non-default port', 'https://zashm.example:8443', 'HTTPS port'],
  ['path', 'https://zashm.example/shop', 'https origins'],
  ['query', 'https://zashm.example?x=1', 'https origins'],
  ['fragment', 'https://zashm.example/#x', 'https origins'],
  ['credentials', 'https://user:pass@zashm.example', 'https origins'],
  ['empty CSV entry', `${TEMP_WORKERS_DEV_ORIGIN},`, 'empty entry'],
  ['padded opt-in flag', TEMP_WORKERS_DEV_ORIGIN, 'opt-in'],
  ['trailing-dot Vercel beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://za-shm.vercel.app./`, 'trailing-dot'],
  ['trailing-dot workers.dev beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://other.za-shm.workers.dev./`, 'trailing-dot'],
  ['127/8 loopback beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://127.0.0.2/`, 'localhost'],
  ['mapped IPv6 loopback beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://[::ffff:127.0.0.1]/`, 'localhost'],
];
for (const [label, value, expected] of badOrigins) {
  const env = productionEnv({
    ALLOWED_ORIGINS: value,
    ...(label === 'canonical workers.dev without opt-in' ? { [TEMP_WORKERS_DEV_FLAG]: undefined } : {}),
    ...(label === 'padded opt-in flag' ? { [TEMP_WORKERS_DEV_FLAG]: ' 1 ' } : {}),
  });
  ok(hasProblem(env, expected), `${label} is rejected by the Production guard`);
}
ok(hasProblem(productionEnv({ ALLOWED_ORIGINS: 'https://zashm.example' }), 'must include PUBLIC_BASE_URL'),
  'the canonical PUBLIC_BASE_URL must be inside the allow-list');

section(3, 'API layer fails closed in Production only');
// Fake database: enough for requirePerm()'s mandatory user re-check. No real
// Supabase connection, customer row, order or cookie is used.
const dbUser = {
  id: 'u1',
  role: 'admin',
  name: 'Test Admin',
  email: 'admin@example.invalid',
  session_version: 0,
};
const fakeSupabase = {
  from(table) {
    const query = {
      select() { return query; },
      eq() { return query; },
      maybeSingle() {
        return Promise.resolve({ data: table === 'users' ? { ...dbUser } : null, error: null });
      },
    };
    return query;
  },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => fakeSupabase };
  return originalLoad.call(this, request, parent, isMain);
};

function makeReq({ method = 'GET', origin, cookie, csrf, authorization } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (cookie !== undefined) headers.cookie = cookie;
  if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  if (authorization !== undefined) headers.authorization = authorization;
  return {
    method,
    headers,
    query: {},
    socket: { remoteAddress: '203.0.113.1' },
    on() { return this; },
    destroy() {},
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    getHeader(key) { return this.headers[String(key).toLowerCase()]; },
    appendHeader(key, value) { this.setHeader(key, value); },
    end(text) { this.done = true; this.body = text ? JSON.parse(text) : null; },
  };
}

try {
  applyEnv(productionEnv());
  const lib = require('../api/_lib.js');
  lib.supabaseAdmin();

  function preflight(origin, env) {
    applyEnv(env);
    const res = makeRes();
    lib.handleOptions(makeReq({ method: 'OPTIONS', origin }), res);
    return res;
  }

  function mutationAllowed(origin, env) {
    applyEnv(env);
    return lib.requestOriginAllowed(makeReq({ method: 'POST', origin }));
  }

  const cfPreflight = preflight(TEMP_WORKERS_DEV_ORIGIN, productionEnv());
  eq(cfPreflight.statusCode, 204, 'Cloudflare OPTIONS preflight is answered');
  eq(cfPreflight.headers['access-control-allow-origin'], TEMP_WORKERS_DEV_ORIGIN, 'the current Cloudflare Origin gets an exact CORS grant');
  eq(cfPreflight.headers['access-control-allow-credentials'], 'true', 'the exact Cloudflare grant keeps credentials');
  eq(cfPreflight.headers.vary, 'Origin', 'the Cloudflare CORS response varies by Origin');
  eq(preflight(OLD_VERCEL, productionEnv()).headers['access-control-allow-origin'], undefined, 'the old Vercel Origin gets no CORS grant');
  eq(preflight(LOCALHOST, productionEnv()).headers['access-control-allow-origin'], undefined, 'localhost gets no CORS grant');
  eq(preflight(EVIL, productionEnv()).headers['access-control-allow-origin'], undefined, 'an unknown Origin gets no CORS grant');

  ok(mutationAllowed(TEMP_WORKERS_DEV_ORIGIN, productionEnv()), 'Cloudflare POST passes the Production origin gate');
  ok(!mutationAllowed(OLD_VERCEL, productionEnv()), 'old Vercel POST is denied in Production');
  ok(!mutationAllowed(LOCALHOST, productionEnv()), 'localhost POST is denied in Production');
  ok(!mutationAllowed(EVIL, productionEnv()), 'unknown Origin POST is denied in Production');

  const noBinding = productionEnv({ ALLOWED_ORIGINS: undefined });
  for (const [label, origin] of [['Cloudflare', TEMP_WORKERS_DEV_ORIGIN], ['old Vercel', OLD_VERCEL], ['localhost', LOCALHOST], ['unknown', EVIL]]) {
    eq(preflight(origin, noBinding).headers['access-control-allow-origin'], undefined, `${label} gets no CORS grant when ALLOWED_ORIGINS is missing`);
    ok(!mutationAllowed(origin, noBinding), `${label} unsafe request is denied when ALLOWED_ORIGINS is missing`);
  }

  for (const [label, value, overrides] of [
    ['retired Vercel binding', OLD_VERCEL, {}],
    ['localhost binding', LOCALHOST, {}],
    ['wildcard binding', '*', {}],
    ['malformed binding', 'https://zashm.example/shop', {}],
    ['trailing-dot Vercel beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://za-shm.vercel.app./`, {}],
    ['trailing-dot workers.dev beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://other.za-shm.workers.dev./`, {}],
    ['127/8 loopback beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://127.0.0.2/`, {}],
    ['mapped IPv6 loopback beside Cloudflare', `${TEMP_WORKERS_DEV_ORIGIN}, https://[::ffff:127.0.0.1]/`, {}],
    ['padded opt-in flag', TEMP_WORKERS_DEV_ORIGIN, { [TEMP_WORKERS_DEV_FLAG]: ' 1 ' }],
  ]) {
    const unsafeEnv = productionEnv({ ALLOWED_ORIGINS: value, ...overrides });
    eq(preflight(TEMP_WORKERS_DEV_ORIGIN, unsafeEnv).headers['access-control-allow-origin'], undefined, `${label} grants nothing to Cloudflare`);
    eq(preflight(OLD_VERCEL, unsafeEnv).headers['access-control-allow-origin'], undefined, `${label} grants nothing to old Vercel`);
    ok(!mutationAllowed(TEMP_WORKERS_DEV_ORIGIN, unsafeEnv), `${label} denies unsafe Production requests`);
  }

  for (const [label, origin, value] of [
    ['trailing-dot Vercel', 'https://za-shm.vercel.app.', `${TEMP_WORKERS_DEV_ORIGIN}, https://za-shm.vercel.app./`],
    ['trailing-dot workers.dev', 'https://other.za-shm.workers.dev.', `${TEMP_WORKERS_DEV_ORIGIN}, https://other.za-shm.workers.dev./`],
    ['127/8 loopback', 'https://127.0.0.2', `${TEMP_WORKERS_DEV_ORIGIN}, https://127.0.0.2/`],
    ['mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]', `${TEMP_WORKERS_DEV_ORIGIN}, https://[::ffff:127.0.0.1]/`],
  ]) {
    const unsafeEnv = productionEnv({ ALLOWED_ORIGINS: value });
    eq(preflight(origin, unsafeEnv).headers['access-control-allow-origin'], undefined, `${label} gets no CORS grant for its own Origin`);
    ok(!mutationAllowed(origin, unsafeEnv), `${label} unsafe request is denied for its own Origin`);
  }

  section(4, 'admin, CSRF and checkout impact');
  applyEnv(productionEnv());
  const token = lib.signSession(dbUser);
  const csrf = 'csrf-token-for-allowed-origin-tests';
  const cookie = `zashm_session=${encodeURIComponent(token)}; zashm_csrf=${csrf}`;

  async function callRequirePerm(req) {
    const res = makeRes();
    const session = await lib.requirePerm(req, res, 'orders.write');
    return { session, status: res.statusCode, body: res.body };
  }

  const adminOk = await callRequirePerm(makeReq({
    method: 'POST', origin: TEMP_WORKERS_DEV_ORIGIN, cookie, csrf,
  }));
  ok(adminOk.session && adminOk.session.role === 'admin', 'a valid admin cookie + CSRF still passes from Cloudflare');
  eq(adminOk.status, 200, 'the successful admin gate does not write an error response');

  const adminOldOrigin = await callRequirePerm(makeReq({
    method: 'POST', origin: OLD_VERCEL, cookie, csrf,
  }));
  eq(adminOldOrigin.session, null, 'the old Vercel Origin cannot authorise an admin mutation even with a valid session');
  eq(adminOldOrigin.status, 403, 'old Vercel admin mutation returns 403');
  eq(adminOldOrigin.body && adminOldOrigin.body.error, 'Request origin is not allowed', 'the old Vercel rejection uses the stable Origin error');

  const adminNoCsrf = await callRequirePerm(makeReq({
    method: 'POST', origin: TEMP_WORKERS_DEV_ORIGIN, cookie,
  }));
  eq(adminNoCsrf.status, 403, 'a missing CSRF header is still rejected from Cloudflare');
  eq(adminNoCsrf.body && adminNoCsrf.body.error, 'CSRF validation failed', 'double-submit CSRF is unchanged');

  const bearerOk = await callRequirePerm(makeReq({
    method: 'POST', origin: TEMP_WORKERS_DEV_ORIGIN, authorization: `Bearer ${token}`,
  }));
  ok(bearerOk.session && bearerOk.session.role === 'admin', 'a Bearer admin call still passes from Cloudflare');

  function enforce(origin, env) {
    applyEnv(env);
    const res = makeRes();
    const allowed = lib.enforceMutationOrigin(makeReq({ method: 'POST', origin }), res);
    return { allowed, status: res.statusCode, body: res.body };
  }

  const checkoutOk = enforce(TEMP_WORKERS_DEV_ORIGIN, productionEnv());
  ok(checkoutOk.allowed, 'guest checkout / public POST from Cloudflare still passes the shared gate');
  eq(checkoutOk.status, 200, 'the passing public gate writes no error response');
  const checkoutOld = enforce(OLD_VERCEL, productionEnv());
  ok(!checkoutOld.allowed, 'guest checkout / public POST from old Vercel is denied');
  eq(checkoutOld.status, 403, 'the denied public mutation returns 403');
  eq(checkoutOld.body && checkoutOld.body.error, 'Request origin is not allowed', 'the public mutation error stays generic');

  section(5, 'Development, Testing and Staging are unchanged');
  const devEnv = { [PRODUCTION_ENV_FLAG]: undefined, ALLOWED_ORIGINS: undefined };
  applyEnv(devEnv);
  for (const origin of [OLD_VERCEL, LOCALHOST]) {
    const res = preflight(origin, devEnv);
    eq(res.headers['access-control-allow-origin'], origin, `legacy fallback still allows ${origin} outside Production`);
    ok(mutationAllowed(origin, devEnv), `legacy fallback still allows unsafe ${origin} outside Production`);
  }
  eq(preflight(TEMP_WORKERS_DEV_ORIGIN, devEnv).headers['access-control-allow-origin'], undefined,
    'legacy fallback did not previously grant the Cloudflare Origin');

  const stagingEnv = {
    [PRODUCTION_ENV_FLAG]: undefined,
    ALLOWED_ORIGINS: `https://${STAGING_WORKER_HOST}`,
  };
  eq(preflight(`https://${STAGING_WORKER_HOST}`, stagingEnv).headers['access-control-allow-origin'],
    `https://${STAGING_WORKER_HOST}`, 'the Staging Worker origin still works when configured');
  ok(mutationAllowed(`https://${STAGING_WORKER_HOST}`, stagingEnv), 'Staging unsafe requests still use its configured allow-list');
} finally {
  Module._load = originalLoad;
  restoreEnv();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
