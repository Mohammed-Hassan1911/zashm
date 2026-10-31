/**
 * Group C — sessions, CSRF and admin safety tests.
 *
 *   node scripts/test-sessions-admin.mjs
 *
 * Drives the REAL api/auth.js and api/admin/users.js handlers against a fake
 * Supabase client. Covers:
 *   - HttpOnly / Secure / SameSite=Strict session cookie + 4h TTL
 *   - non-HttpOnly CSRF double-submit cookie
 *   - Origin allow-list and CSRF enforcement on unsafe cookie requests
 *   - legacy Bearer tokens keep working (no CSRF needed)
 *   - logout clears both cookies
 *   - constant-time-ish login with a dummy scrypt hash (no user enumeration)
 *   - 12+ character password policy for new/changed passwords only
 *   - last-admin protection (API pre-check + DB trigger contract)
 *   - Cache-Control: no-store on JSON responses
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import crypto from 'node:crypto';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fake database ───────────────────────────────────────────────────────────
const state = {
  users: [],
  failDeleteWith: null,
  failUpdateWith: null,
  writes: [],
};

function resetUsers(rows) {
  state.users = rows.map((r) => ({ session_version: 0, ...r }));
  state.failDeleteWith = null;
  state.failUpdateWith = null;
  state.writes = [];
}

function matches(row, filters) {
  return filters.every(([col, val, op]) => {
    if (op === 'neq') return String(row[col]) !== String(val);
    return String(row[col]) === String(val);
  });
}

function makeQuery(table) {
  const q = {
    _filters: [],
    _op: 'select',
    _insertRows: null,
    _updateObj: null,
    select() { return q; },
    eq(col, val) { q._filters.push([col, val, 'eq']); return q; },
    neq(col, val) { q._filters.push([col, val, 'neq']); return q; },
    order() { return q; },
    insert(rows) { q._op = 'insert'; q._insertRows = rows; return q; },
    update(obj) { q._op = 'update'; q._updateObj = obj; return q; },
    delete() { q._op = 'delete'; return q; },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(onOk, onErr) { return run().then(onOk, onErr); },
  };

  async function run() {
    await sleep(0);
    const tableRows = table === 'users' ? state.users : [];
    const filtered = tableRows.filter((r) => matches(r, q._filters));

    if (q._op === 'insert') {
      const rows = Array.isArray(q._insertRows) ? q._insertRows : [q._insertRows];
      const inserted = rows.map((r) => {
        const row = { id: state.users.length + 100, ...r };
        state.users.push(row);
        state.writes.push({ op: 'insert', row });
        return { ...row };
      });
      return { data: inserted, error: null };
    }

    if (q._op === 'update') {
      if (state.failUpdateWith) {
        return { data: null, error: new Error(state.failUpdateWith) };
      }
      const updated = [];
      for (const row of filtered) {
        Object.assign(row, q._updateObj);
        state.writes.push({ op: 'update', id: row.id, obj: { ...q._updateObj } });
        updated.push({ ...row });
      }
      return { data: updated, error: null };
    }

    if (q._op === 'delete') {
      if (state.failDeleteWith) {
        return { data: null, error: new Error(state.failDeleteWith) };
      }
      const removed = filtered.map((r) => ({ ...r }));
      state.users = state.users.filter((r) => !filtered.includes(r));
      state.writes.push({ op: 'delete', ids: removed.map((r) => r.id) });
      return { data: removed, error: null };
    }

    return { data: filtered.map((r) => ({ ...r })), error: null };
  }

  return q;
}

const sb = {
  from(table) { return makeQuery(table); },
};

// ─── Boot the real handlers ──────────────────────────────────────────────────
process.env.SESSION_SECRET = 'test-session-secret-for-sessions-admin-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.ALLOWED_ORIGINS;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => sb };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
lib.supabaseAdmin();
const authHandler = require('../api/auth.js');
const usersHandler = require('../api/admin/users.js');
Module._load = originalLoad;

const SESSION_SECRET = process.env.SESSION_SECRET;
const ALLOWED_ORIGIN = 'https://za-shm.vercel.app';
const { SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL_MS } = lib;

// ─── HTTP fakes ──────────────────────────────────────────────────────────────
let ipCounter = 1;
function makeReq({ method = 'GET', body, headers = {}, ip } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const listeners = {};
  const req = {
    method,
    headers: {
      'x-real-ip': ip || `203.0.113.${(ipCounter++ % 250) + 1}`,
      ...headers,
    },
    query: {},
    socket: { remoteAddress: '203.0.113.1' },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      // Replay the body as soon as the handler subscribes. Listening late is
      // normal here: requirePerm awaits the DB before readBody() attaches.
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
    cookies: [],
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    appendHeader(k, v) {
      if (String(k).toLowerCase() === 'set-cookie') this.cookies.push(v);
      else this.headers[String(k).toLowerCase()] = v;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
      this.done = true;
    },
  };
}

async function call(handler, opts = {}) {
  const req = makeReq(opts);
  const res = makeRes();
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 3000); });
  const outcome = await Promise.race([handler(req, res).then(() => 'done'), timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    console.log(`  (timeout in ${opts.method || 'GET'} handler; body=${JSON.stringify(opts.body || null)})`);
  }
  return {
    status: res.statusCode,
    body: res.body,
    headers: res.headers,
    cookies: res.cookies,
    setCookie: res.cookies.join('\n'),
  };
}

function cookiePair(token, csrf) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`];
  if (csrf !== undefined) parts.push(`${CSRF_COOKIE}=${encodeURIComponent(csrf)}`);
  return parts.join('; ');
}

const login = (email, password, headers = {}) =>
  call(authHandler, {
    method: 'POST',
    body: { action: 'login', email, password },
    headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json', ...headers },
  });

const admin = (method, { token, csrf, csrfHeader, headers = {}, body } = {}) =>
  call(usersHandler, {
    method,
    body,
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      cookie: cookiePair(token, csrf),
      // `csrfHeader` defaults to the cookie value (valid double-submit); pass
      // null to omit the header, or a different value to test a mismatch.
      ...(csrfHeader === null ? {} : { 'x-csrf-token': csrfHeader === undefined ? csrf : csrfHeader }),
      ...headers,
    },
  });

// ─── Static contract ────────────────────────────────────────────────────────
console.log('\n[1] static checks');
{
  const libSrc = readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8');
  ok(/const SESSION_TTL_MS = 4 \* 60 \* 60 \* 1000/.test(libSrc), 'server session TTL is 4 hours');
  ok(/HttpOnly/.test(libSrc) && /SameSite=Strict/.test(libSrc) && /Secure/.test(libSrc),
    'session cookie is HttpOnly + Secure + SameSite=Strict');
  ok(/MIN_PASSWORD = 12/.test(libSrc), 'server password policy is 12+');
  ok(/csrfHeaderValid/.test(libSrc) && /requestOriginAllowed/.test(libSrc),
    'requirePerm enforces CSRF + Origin for cookie requests');

  const authSrc = readFileSync(new URL('../api/auth.js', import.meta.url), 'utf8');
  ok(/DUMMY_PASSWORD_HASH/.test(authSrc), 'login uses a dummy scrypt hash for unknown emails');
  ok(!/\n\s+token,\s*\n/.test(authSrc), 'login response no longer exposes the session token');
  ok(/action === 'logout'/.test(authSrc), 'logout is handled server-side');
  ok(/setSessionCookie/.test(authSrc) && /setCsrfCookie/.test(authSrc), 'login sets both cookies');
  ok(/clearSessionCookie/.test(authSrc) && /clearCsrfCookie/.test(authSrc), 'logout clears both cookies');

  const apiSrc = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  ok(/credentials: 'same-origin'/.test(apiSrc), 'client sends cookies same-origin only');
  ok(/X-CSRF-Token/.test(apiSrc), 'client echoes the CSRF header');

  const securitySrc = readFileSync(new URL('../src/lib/security.js', import.meta.url), 'utf8');
  ok(/SESSION_DURATION = 4 \* 60 \* 60 \* 1000/.test(securitySrc), 'client session TTL matches 4h');
  ok(!/token: serverToken \|\| generateToken\(\)/.test(securitySrc), 'client never fabricates a token');

  const panelSrc = readFileSync(new URL('../src/components/admin/UsersPanel.js', import.meta.url), 'utf8');
  ok(/form\.password\.length < 12/.test(panelSrc), 'UsersPanel enforces 12+ for changed passwords');

  const sql = readFileSync(new URL('../supabase/admin_protection.sql', import.meta.url), 'utf8');
  ok(/zshm_protect_last_admin/.test(sql), 'DB trigger protects the last admin');
  ok(/pg_advisory_xact_lock/.test(sql), 'trigger serializes concurrent demotions');
  ok(/BEFORE UPDATE OR DELETE ON public\.users/.test(sql), 'trigger covers update and delete');
}

// ─── Login cookies ──────────────────────────────────────────────────────────
console.log('\n[2] login issues secure cookies');
const ADMIN_PASSWORD = 'CorrectHorseBattery12';
const adminHash = await lib.hashPassword(ADMIN_PASSWORD);
resetUsers([
  { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
  { id: 2, name: 'Staff', email: 'staff@example.com', role: 'support', passwordhash: adminHash },
]);

let loginRes = await login('owner@example.com', ADMIN_PASSWORD);
let sessionCookieLine = loginRes.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || '';
let csrfCookieLine = loginRes.cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) || '';
{
  eq(loginRes.status, 200, 'valid credentials accepted');
  ok(sessionCookieLine.includes('HttpOnly'), 'session cookie is HttpOnly');
  ok(sessionCookieLine.includes('Secure'), 'session cookie is Secure');
  ok(sessionCookieLine.includes('SameSite=Strict'), 'session cookie is SameSite=Strict');
  ok(csrfCookieLine.length > 0 && !csrfCookieLine.includes('HttpOnly'), 'CSRF cookie is JS-readable');
  ok(sessionCookieLine.includes(`Max-Age=${SESSION_TTL_MS / 1000}`), 'session cookie Max-Age = 14400s');
  ok(loginRes.headers['cache-control'] === 'no-store', 'login response is not cacheable');
  eq(loginRes.body.token, undefined, 'response has no bearer token');
  ok(typeof loginRes.body.csrfToken === 'string' && loginRes.body.csrfToken.length >= 32,
    'response carries a fresh CSRF token');
  ok(Math.abs(loginRes.body.expiresAt - (Date.now() + SESSION_TTL_MS)) < 5000, 'expiresAt is now + 4h');
  ok(!JSON.stringify(loginRes.body).includes('passwordhash'), 'no password hash is returned');
}

const sessionToken = decodeURIComponent(sessionCookieLine.split(';')[0].slice(SESSION_COOKIE.length + 1));
const csrfToken = loginRes.body.csrfToken;

// ─── TTL / token verification ───────────────────────────────────────────────
console.log('\n[3] session token TTL');
{
  const payload = lib.verifySession(sessionToken);
  ok(payload !== null, 'issued token verifies');
  eq(payload.exp - payload.iat, SESSION_TTL_MS, 'token lifetime is exactly 4h');
  eq(payload.sub, '1', 'token subject is the user id');

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const expired = b64({ sub: '1', role: 'admin', sv: 0, iat: Date.now() - 20000, exp: Date.now() - 1000 });
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(expired).digest('hex');
  eq(lib.verifySession(`${expired}.${sig}`), null, 'expired token rejected');

  const tampered = sessionToken.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  eq(lib.verifySession(tampered), null, 'tampered signature rejected');
}

// ─── Origin allow-list ──────────────────────────────────────────────────────
console.log('\n[4] Origin allow-list');
{
  const evil = await login('owner@example.com', ADMIN_PASSWORD, { origin: 'https://evil.example' });
  eq(evil.status, 403, 'login from a disallowed origin → 403');
  ok(evil.cookies.length === 0, 'no cookie is issued to a disallowed origin');

  const evilAdmin = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    headers: { origin: 'https://evil.example' },
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(evilAdmin.status, 403, 'admin write from a disallowed origin → 403');
  eq(evilAdmin.body.error, 'Request origin is not allowed', 'clear origin error');
}

// ─── CSRF ───────────────────────────────────────────────────────────────────
console.log('\n[5] CSRF double-submit');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
    { id: 2, name: 'Staff', email: 'staff@example.com', role: 'support', passwordhash: adminHash },
  ]);

  const safe = await admin('GET', { token: sessionToken });
  eq(safe.status, 200, 'GET works with the session cookie (no CSRF needed)');
  ok(Array.isArray(safe.body.users), 'GET returns the user list');
  ok(!JSON.stringify(safe.body).includes('passwordhash'), 'GET never returns password hashes');

  const noHeader = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken, csrfHeader: null,
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(noHeader.status, 403, 'unsafe cookie request without X-CSRF-Token → 403');
  eq(noHeader.body.error, 'CSRF validation failed', 'clear CSRF error');

  const wrong = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken, csrfHeader: 'f'.repeat(64),
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(wrong.status, 403, 'mismatched CSRF token → 403');

  const noCookieToken = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` },
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(noCookieToken.status, 403, 'missing CSRF cookie → 403');

  const good = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(good.status, 200, 'valid CSRF + Origin → write succeeds');
  eq(good.body.user.role, 'manager', 'role actually changed');
}

// ─── Legacy Bearer tokens ───────────────────────────────────────────────────
console.log('\n[6] legacy Bearer token');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
    { id: 2, name: 'Staff', email: 'staff@example.com', role: 'support', passwordhash: adminHash },
  ]);
  const bearer = await call(usersHandler, {
    method: 'PATCH',
    body: { id: 2, updates: { role: 'manager' } },
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
    },
  });
  eq(bearer.status, 200, 'Bearer requests still work without CSRF (not cookie-attached)');

  const noAuth = await call(usersHandler, { method: 'GET', headers: { origin: ALLOWED_ORIGIN } });
  eq(noAuth.status, 401, 'no credential → 401');
}

// ─── Logout ─────────────────────────────────────────────────────────────────
console.log('\n[7] logout');
{
  const r = await call(authHandler, {
    method: 'POST',
    body: { action: 'logout' },
    headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json', cookie: cookiePair(sessionToken, csrfToken) },
  });
  eq(r.status, 200, 'logout succeeds');
  const sess = r.cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) || '';
  const csrf = r.cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) || '';
  ok(sess.includes('Max-Age=0') && sess.includes('HttpOnly'), 'session cookie is expired');
  ok(csrf.includes('Max-Age=0'), 'CSRF cookie is expired');
}

// ─── Unknown user / dummy hash ──────────────────────────────────────────────
console.log('\n[8] no user enumeration');
{
  resetUsers([{ id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash }]);
  const unknown = await login('nobody@example.com', ADMIN_PASSWORD);
  const wrong = await login('owner@example.com', 'WrongPassword12');
  eq(unknown.status, 401, 'unknown email → 401');
  eq(wrong.status, 401, 'wrong password → 401');
  eq(unknown.body.error, wrong.body.error, 'identical error message (no enumeration)');

  const dummy = lib.verifyPassword
    ? await lib.verifyPassword('WrongPassword12',
      'scrypt$16384$8$1$9235e98da7b9db0c3908d02f9877f404$44031c67af6a4173a996c8a200fefd4358a05a676110367be48b9e20970e5bb1')
    : null;
  eq(dummy && dummy.valid, false, 'dummy hash never matches');
  eq(dummy && dummy.needsRehash, false, 'dummy hash is already a current scrypt hash');
}

// ─── Password policy ────────────────────────────────────────────────────────
console.log('\n[9] 12+ password policy (new/changed only)');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
    { id: 2, name: 'Staff', email: 'staff@example.com', role: 'support', passwordhash: adminHash },
  ]);

  const shortCreate = await admin('POST', {
    token: sessionToken, csrf: csrfToken,
    body: { user: { name: 'New Person', email: 'new@example.com', role: 'support', password: 'short1' } },
  });
  eq(shortCreate.status, 422, 'create with a 6-char password → 422');

  const longCreate = await admin('POST', {
    token: sessionToken, csrf: csrfToken,
    body: { user: { name: 'New Person', email: 'new@example.com', role: 'support', password: 'TwelveChars!!' } },
  });
  eq(longCreate.status, 200, 'create with a 12-char password → 200');

  const shortUpdate = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2, updates: { password: 'short1' } },
  });
  eq(shortUpdate.status, 422, 'changing to a 6-char password → 422');

  const keepPassword = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2, updates: { name: 'Staff Renamed' } },
  });
  eq(keepPassword.status, 200, 'editing without a password does not require one');

  const longUpdate = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2, updates: { password: 'AnotherGoodOne12' } },
  });
  eq(longUpdate.status, 200, 'changing to a 12-char password → 200');
}

// ─── Last admin ─────────────────────────────────────────────────────────────
console.log('\n[10] last-admin protection');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
  ]);
  const demote = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 1, updates: { role: 'support' } },
  });
  eq(demote.status, 409, 'demoting the only admin → 409');
  eq(state.users[0].role, 'admin', 'the admin role is unchanged');
  ok(/last admin/i.test(demote.body.error), 'clear last-admin message');

  const selfDelete = await admin('DELETE', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 1 },
  });
  eq(selfDelete.status, 400, 'deleting your own account → 400');

  // Two admins: promotion/demotion of the second one is allowed.
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
    { id: 2, name: 'Second', email: 'second@example.com', role: 'admin', passwordhash: adminHash },
  ]);
  const demoteSecond = await admin('PATCH', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2, updates: { role: 'manager' } },
  });
  eq(demoteSecond.status, 200, 'demoting a second admin is allowed');
  eq(state.users[1].role, 'manager', 'second admin was demoted');

  // DB trigger is the authoritative guard; simulate its rejection.
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
    { id: 2, name: 'Second', email: 'second@example.com', role: 'admin', passwordhash: adminHash },
  ]);
  state.failDeleteWith = 'last_admin: cannot delete or demote the last admin';
  const blockedByDb = await admin('DELETE', {
    token: sessionToken, csrf: csrfToken,
    body: { id: 2 },
  });
  eq(blockedByDb.status, 409, 'DB trigger rejection maps to 409');
  state.failDeleteWith = null;
}

// ─── Session revocation (role change) ───────────────────────────────────────
console.log('\n[11] session re-check / revocation');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'manager', passwordhash: adminHash, session_version: 0 },
    { id: 2, name: 'Staff', email: 'staff@example.com', role: 'support', passwordhash: adminHash },
  ]);
  // Token says admin, DB says manager → permission is derived from the DB row.
  const stale = await admin('GET', { token: sessionToken });
  eq(stale.status, 403, 'role baked into an old token is ignored');

  // Bump session_version → the token is rejected outright.
  state.users[0].role = 'admin';
  state.users[0].session_version = 1;
  const revoked = await admin('GET', { token: sessionToken });
  eq(revoked.status, 401, 'session_version bump revokes the token');
}

// ─── no-store on errors/data ────────────────────────────────────────────────
console.log('\n[12] no-store');
{
  resetUsers([
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', passwordhash: adminHash },
  ]);
  const unauthorized = await call(usersHandler, { method: 'GET', headers: { origin: ALLOWED_ORIGIN } });
  eq(unauthorized.status, 401, 'unauthenticated request → 401');
  eq(unauthorized.headers['cache-control'], 'no-store', 'error responses are not cacheable');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
