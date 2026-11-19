/**
 * Bulk-PII admin GET routes must be throttled like their sibling list routes.
 *
 *   node scripts/test-admin-pii-limits.mjs
 *
 * Drives the REAL GET handlers for /api/admin/orders and /api/admin/users with
 * a fake service-role client. The shared limiter falls back to its in-memory
 * bucket because no Upstash/DB RPC is configured in this harness, which is
 * enough to prove the routes call it before touching customer data.
 *
 * Nothing here touches Supabase or production.
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

const state = {
  users: [
    { id: 1, name: 'Owner', email: 'owner@example.com', role: 'admin', session_version: 0, createdate: '2026-01-01' },
  ],
  orders: [{ id: 'ZSH-TEST-0001', customer: 'Test', phone: '01000000000', items: '[]', timestamps: '{}' }],
  orderReads: 0,
  userListReads: 0,
};

function makeQuery(table) {
  const q = {
    _filters: [],
    _order: null,
    select() { return q; },
    eq(col, val) { q._filters.push([col, val]); return q; },
    order(col, opts) { q._order = { col, ascending: !(opts && opts.ascending === false) }; return q; },
    maybeSingle() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    single() { return run().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(onOk, onErr) { return run().then(onOk, onErr); },
  };

  async function run() {
    if (table === 'users') {
      if (q._filters.length === 0) state.userListReads += 1;
      const rows = state.users.filter((row) =>
        q._filters.every(([col, val]) => String(row[col]) === String(val))
      ).map((row) => ({ ...row }));
      return { data: rows, error: null };
    }
    if (table === 'orders') {
      state.orderReads += 1;
      return { data: state.orders.map((row) => ({ ...row })), error: null };
    }
    return { data: [], error: null };
  }

  return q;
}

const sb = { from(table) { return makeQuery(table); } };

process.env.SESSION_SECRET = 'test-session-secret-for-admin-pii-limit-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.ALLOWED_ORIGINS;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => sb };
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
lib.supabaseAdmin();
const ordersHandler = require('../api/admin/orders.js');
const usersHandler = require('../api/admin/users.js');
Module._load = originalLoad;

const token = lib.signSession({
  id: state.users[0].id,
  role: state.users[0].role,
  name: state.users[0].name,
  email: state.users[0].email,
  session_version: state.users[0].session_version,
});

function makeReq() {
  return {
    method: 'GET',
    headers: {
      'x-real-ip': '203.0.113.77',
      authorization: `Bearer ${token}`,
    },
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
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    end(text) { this.body = text ? JSON.parse(text) : null; this.done = true; },
  };
}

async function call(handler) {
  const req = makeReq();
  const res = makeRes();
  await handler(req, res);
  return res;
}

console.log('\n[1] order list is throttled after 120 reads from one IP');
{
  for (let i = 0; i < 120; i += 1) {
    const res = await call(ordersHandler);
    eq(res.statusCode, 200, `order read ${i + 1} is allowed`);
  }
  state.orderReads = 0;
  const blocked = await call(ordersHandler);
  eq(blocked.statusCode, 429, 'the 121st order read is rate limited');
  eq(blocked.body.rateLimited, true, 'the 429 carries the rateLimited flag');
  ok(Number(blocked.getHeader('Retry-After')) >= 1, 'the 429 advertises Retry-After');
  eq(state.orderReads, 0, 'a blocked order read never touches the orders table');
}

console.log('\n[2] user list is throttled after 120 reads from one IP');
{
  for (let i = 0; i < 120; i += 1) {
    const res = await call(usersHandler);
    eq(res.statusCode, 200, `user read ${i + 1} is allowed`);
  }
  state.userListReads = 0;
  const blocked = await call(usersHandler);
  eq(blocked.statusCode, 429, 'the 121st user read is rate limited');
  eq(blocked.body.rateLimited, true, 'the 429 carries the rateLimited flag');
  ok(Number(blocked.getHeader('Retry-After')) >= 1, 'the 429 advertises Retry-After');
  eq(state.userListReads, 0, 'a blocked user read never queries the users list');
}

console.log('\n[3] dedicated keys, shared budget shape');
{
  const srcOrders = readFileSync(new URL('../api/admin/orders.js', import.meta.url), 'utf8');
  const srcUsers = readFileSync(new URL('../api/admin/users.js', import.meta.url), 'utf8');
  ok(/async function listOrders[\s\S]{0,400}?adminorderread:\$\{ip\}/.test(srcOrders),
    'the order list uses its own adminorderread rate-limit key');
  ok(/async function listUsers[\s\S]{0,400}?adminuserread:\$\{ip\}/.test(srcUsers),
    'the user list uses its own adminuserread rate-limit key');
  ok(!/function listOrders[\s\S]{0,400}?\brateLimit\(/.test(srcOrders.replace(/rateLimitShared\(/g, '')),
    'the order list does not use the synchronous per-instance limiter');
  ok(!/function listUsers[\s\S]{0,400}?\brateLimit\(/.test(srcUsers.replace(/rateLimitShared\(/g, '')),
    'the user list does not use the synchronous per-instance limiter');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
