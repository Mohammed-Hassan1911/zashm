// Regression coverage for the optional ntfy.sh backup push channel.
// Proves: 2xx succeeds silently, non-2xx is logged with status + sanitized body,
// network failures never throw, and no topic/token/customer text is ever logged.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFileSync(path.join(root, file), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(value, label) {
  if (!value) throw new Error(label);
}
async function section(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error && error.message ? error.message : error}`);
    console.log(`  FAIL ${name} — ${error && error.message ? error.message : error}`);
  }
}

// ─── load the real module (no network) ──────────────────────────────────────
const lib = require('../api/_lib.js');
const { sendNtfyNotification } = lib;

const TOPIC = 'zashm-test-topic-SECRET-1234567890';
const TOKEN = 'tk_test_SECRET_abcdefghijklmnop';
const CUSTOMER_TEXT = 'Fatima Test · 01000000000 · 12 Test Street';

const realFetch = global.fetch;
const realError = console.error;
const realWarn = console.warn;
let logs = [];
let warnings = [];
let calls = [];

function stubFetch(impl) {
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
}
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}
function capture() {
  logs = [];
  warnings = [];
  calls = [];
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
}
function restore() {
  global.fetch = realFetch;
  console.error = realError;
  console.warn = realWarn;
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_SERVER;
  delete process.env.NTFY_TOKEN;
}

const sample = {
  title: 'New order ZSH-TEST',
  message: CUSTOMER_TEXT,
  tags: 'shopping_cart,bell',
  priority: 4,
};

try {
  console.log('ntfy notification channel');

  await section('[1] HTTP 200 succeeds silently and builds the documented request', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    process.env.NTFY_SERVER = 'https://ntfy.sh/';
    stubFetch(async () => jsonResponse(200, '{"id":"abc"}'));
    const result = await sendNtfyNotification(sample);
    eq(result, true, 'returns true on 2xx');
    eq(logs.length, 0, 'no error log on success');
    eq(warnings.length, 0, 'no warning on success');
    eq(calls.length, 1, 'one HTTP call');
    eq(calls[0].url, `https://ntfy.sh/${encodeURIComponent(TOPIC)}`, 'topic is encoded into the URL');
    eq(calls[0].init.method, 'POST', 'POST method');
    eq(calls[0].init.headers.Title, 'New order ZSH-TEST', 'Title header');
    eq(calls[0].init.headers.Priority, '4', 'Priority header');
    eq(calls[0].init.headers.Tags, 'shopping_cart,bell', 'Tags header');
    eq(calls[0].init.headers['Content-Type'], 'text/plain; charset=utf-8', 'plain text body');
    eq('Authorization' in calls[0].init.headers, false, 'no Authorization when NTFY_TOKEN is unset');
    eq(calls[0].init.body, CUSTOMER_TEXT, 'body sent as-is');
  });

  await section('[2] HTTP 401 is logged with status and sanitized body', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    process.env.NTFY_TOKEN = TOKEN;
    stubFetch(async () => jsonResponse(401, `{"error":"unauthorized","topic":"${TOPIC}","token":"${TOKEN}"}`));
    const result = await sendNtfyNotification(sample);
    eq(result, false, 'returns false on 401');
    eq(logs.length, 1, 'exactly one error log');
    ok(logs[0].includes('HTTP 401'), `status is logged (${logs[0]})`);
    ok(!logs[0].includes(TOPIC), 'topic is redacted from the log');
    ok(!logs[0].includes(TOKEN), 'token is redacted from the log');
    ok(!logs[0].includes('01000000000'), 'customer data is never logged');
    eq(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`, 'token is sent as a bearer header');
  });

  await section('[3] HTTP 404 is logged with status', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    stubFetch(async () => jsonResponse(404, '{"error":"not found"}'));
    const result = await sendNtfyNotification(sample);
    eq(result, false, 'returns false on 404');
    eq(logs.length, 1, 'exactly one error log');
    ok(logs[0].includes('HTTP 404'), `status 404 logged (${logs[0]})`);
    ok(!logs[0].includes(TOPIC), 'no topic in the log');
  });

  await section('[4] HTTP 429 body is truncated to 200 characters', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    stubFetch(async () => jsonResponse(429, 'x'.repeat(5000)));
    const result = await sendNtfyNotification(sample);
    eq(result, false, 'returns false on 429');
    ok(logs[0].includes('HTTP 429'), 'status 429 logged');
    const bodyPart = logs[0].replace('ntfy notification failed: HTTP 429 ', '');
    ok(bodyPart.length <= 200, `body is capped (${bodyPart.length} chars)`);
  });

  await section('[5] network failure never throws and is logged without URLs', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    global.fetch = async () => {
      const err = new TypeError('fetch failed');
      err.name = 'TypeError';
      throw err;
    };
    const result = await sendNtfyNotification(sample);
    eq(result, false, 'returns false instead of throwing');
    eq(logs.length, 1, 'one error log');
    ok(logs[0].includes('network'), `network failure labelled (${logs[0]})`);
    ok(logs[0].includes('TypeError'), 'error name preserved');
    ok(!logs[0].includes(TOPIC), 'no topic leaked by the error');
    ok(!logs[0].includes('01000000000'), 'no customer data leaked');
  });

  await section('[6] missing NTFY_TOPIC skips cleanly and warns (no fetch)', async () => {
    capture();
    delete process.env.NTFY_TOPIC;
    stubFetch(async () => jsonResponse(200, '{}'));
    const result = await sendNtfyNotification(sample);
    eq(result, false, 'returns false when unconfigured');
    eq(calls.length, 0, 'no HTTP call is attempted');
    eq(warnings.length, 1, 'one warning so the missing env var is visible');
    ok(warnings[0].includes('NTFY_TOPIC'), 'warning names the env var');
    ok(!warnings[0].includes(TOPIC), 'warning never prints a value');
  });

  await section('[7] NTFY_SERVER defaults to https://ntfy.sh', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    delete process.env.NTFY_SERVER;
    stubFetch(async () => jsonResponse(200, '{}'));
    await sendNtfyNotification(sample);
    eq(calls[0].url, `https://ntfy.sh/${encodeURIComponent(TOPIC)}`, 'default server used');
  });

  await section('[8] order paths call ntfy inside their own try/catch (source lock)', async () => {
    const orders = read('api/orders.js');
    const admin = read('api/admin/orders.js');
    const libSrc = read('api/_lib.js');

    ok(orders.includes('await sendNtfyNotification('), 'order placement awaits ntfy');
    ok(/catch \(e\) \{\s*\n\s*console\.error\('ntfy notification failed:/.test(orders) ||
      orders.includes("console.error('ntfy notification failed:'"), 'placement failure is contained');
    // The Telegram call must still be present (never replaced by ntfy).
    ok(orders.includes('await sendTelegramNotification(message)'), 'Telegram still sent on placement');
    ok(admin.includes('await sendNtfyNotification('), 'admin status/delete paths await ntfy');
    ok(admin.split('await sendNtfyNotification(').length - 1 >= 2, 'status change and delete both notify');
    ok(admin.includes('atomic_set_order_status'), 'status path uses the atomic RPC');
    ok(admin.includes('atomic_delete_order'), 'delete path uses the atomic RPC');
    ok(libSrc.includes('sendNtfyNotification,'), 'helper is exported');
    const ntfyBlock = libSrc.slice(
      libSrc.indexOf('async function sendNtfyNotification'),
      libSrc.indexOf('function buildOrderTelegramMessage')
    );
    ok(!/console\.(log|error|warn)\([^)]*\btoken\b/i.test(ntfyBlock), 'no log statement prints the token');
  });

  await section('[9] source never logs the topic or authorization header', async () => {
    const libSrc = read('api/_lib.js');
    const block = libSrc.slice(
      libSrc.indexOf('async function sendNtfyNotification'),
      libSrc.indexOf('function buildOrderTelegramMessage')
    );
    ok(block.includes('HTTP ${resp.status}'), 'status is part of the failure log');
    ok(block.includes('.split(topic).join(\'[topic]\')'), 'topic is redacted');
    ok(block.includes('.split(token).join(\'[token]\')'), 'token is redacted');
    ok(!block.includes("console.log(`https://"), 'never logs the request URL');
    ok(block.includes('.slice(0, 200)'), 'response body is truncated');
  });

  await section('[10] outcome capture reports configured/status/network without values', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    delete process.env.NTFY_TOKEN;
    stubFetch(async () => jsonResponse(200, '{}'));
    let outcome = {};
    eq(await sendNtfyNotification({ ...sample, result: outcome }), true, '2xx returns true');
    eq(outcome.configured, true, 'configured flag');
    eq(outcome.status, 200, 'status captured');

    outcome = {};
    stubFetch(async () => jsonResponse(401, 'unauthorized'));
    eq(await sendNtfyNotification({ ...sample, result: outcome }), false, '401 returns false');
    eq(outcome.status, 401, 'failure status captured');

    outcome = {};
    global.fetch = async () => {
      const err = new TypeError('fetch failed');
      throw err;
    };
    eq(await sendNtfyNotification({ ...sample, result: outcome }), false, 'network returns false');
    eq(outcome.network, true, 'network flag captured');
    eq(outcome.error, 'TypeError', 'error name captured');

    outcome = {};
    delete process.env.NTFY_TOPIC;
    eq(await sendNtfyNotification({ ...sample, result: outcome }), false, 'unconfigured returns false');
    eq(outcome.configured, false, 'configured=false captured');
  });

  await section('[11] /api/admin/notify-test is admin-only and value-free', async () => {
    const routePath = require.resolve('../api/admin/notify-test.js');
    const libPath = require.resolve('../api/_lib.js');
    const realLib = require('../api/_lib.js');
    const seen = { status: null, body: null, urls: [] };
    let authorized = true;
    let sent = 0;
    let optionsHandled = 0;

    delete require.cache[routePath];
    Object.assign(require.cache[libPath], {
      id: libPath,
      filename: libPath,
      loaded: true,
      exports: {
        ...realLib,
        json: (_res, status, body) => { seen.status = status; seen.body = body; },
        applyCors: () => {},
        handleOptions: () => { optionsHandled += 1; },
        clientIp: () => '203.0.113.9',
        rateLimitShared: async () => ({ allowed: true }),
        tooMany: () => { seen.status = 429; },
        requirePerm: async () => (authorized ? { name: 'Admin', role: 'admin' } : null),
        sendNtfyNotification: async ({ result } = {}) => {
          sent += 1;
          if (result) Object.assign(result, { configured: true, status: 200 });
          return true;
        },
        ntfyConfigSummary: () => ({
          configured: true,
          serverHost: 'ntfy.sh',
          serverIsDefault: true,
          tokenConfigured: false,
        }),
      },
    });

    const handler = require(routePath);
    const res = { setHeader() {}, end() {} };

    await handler({ method: 'POST', headers: {}, query: {} }, res);
    eq(seen.status, 200, 'authorized self-test returns 200');
    eq(sent, 1, 'exactly one notification sent');
    eq(seen.body.ntfy.delivered, true, 'delivered flag surfaced');
    eq(seen.body.ntfy.httpStatus, 200, 'HTTP status surfaced');
    eq(seen.body.ntfy.tokenConfigured, false, 'tokenConfigured is a boolean');
    eq(seen.body.telegram.configured, false, 'telegram config is boolean-only');
    const serialized = JSON.stringify(seen.body);
    ok(!serialized.includes(TOPIC), 'response never contains the topic');
    ok(!serialized.includes(TOKEN), 'response never contains the token');
    ok(!/[0-9a-f]{32,}/i.test(serialized), 'response contains no secret-looking value');

    authorized = false;
    seen.status = null;
    seen.body = null;
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    eq(seen.status, null, 'unauthenticated request writes no body (401 handled by requirePerm)');
    eq(sent, 1, 'no notification sent without a session');

    authorized = true;
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    eq(seen.status, 405, 'GET is rejected');
    eq(sent, 1, 'method guard runs before the send');

    seen.status = null;
    await handler({ method: 'OPTIONS', headers: {}, query: {} }, res);
    eq(optionsHandled, 1, 'OPTIONS is delegated to handleOptions');
    eq(seen.status, null, 'OPTIONS writes no JSON body');
    eq(sent, 1, 'OPTIONS never sends a notification');

    const routeSrc = read('api/admin/notify-test.js');
    ok(routeSrc.includes("requirePerm(req, res, 'orders.read')"), 'requires orders.read');
    ok(routeSrc.includes('rateLimitShared'), 'rate limited');
    ok(!/process\.env\.NTFY_TOPIC/.test(routeSrc), 'route never touches the topic value directly');
    ok(!routeSrc.includes('Authorization'), 'route never handles tokens');

    delete require.cache[routePath];
    require.cache[libPath].exports = realLib;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
} finally {
  restore();
}
