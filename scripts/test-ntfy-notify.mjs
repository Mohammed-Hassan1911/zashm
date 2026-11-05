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

  await section('[10] non-ASCII titles are downgraded so Node fetch can send them', async () => {
    capture();
    process.env.NTFY_TOPIC = TOPIC;
    process.env.NTFY_TOKEN = TOKEN;
    stubFetch(async () => jsonResponse(200, '{}'));
    await sendNtfyNotification({
      title: 'New order ZSH-TEST — EGP 865',
      message: 'طلب جديد\nJacket x1',
      tags: 'شحن,bell',
      priority: 4,
    });
    const headers = calls[0].init.headers;
    eq(headers.Title, 'New order ZSH-TEST - EGP 865', 'em dash is replaced in the Title');
    eq(headers.Tags, ',bell', 'non-ASCII tag characters are stripped');
    for (const [name, value] of Object.entries(headers)) {
      ok(!/[^\x20-\x7E]/.test(String(value)), `${name} header is printable ASCII`);
    }
    eq(calls[0].init.body, 'طلب جديد\nJacket x1', 'UTF-8 body is preserved');
    ok(logs.length === 0, 'no failure logged for an ASCII-safe title');
  });

  await section('[11] calling Node fetch with a non-ASCII header would throw (root-cause lock)', async () => {
    // Documents the defect fixed in headerSafe: undici rejects code points > 255
    // in header values before the request is sent, so the em dash in
    // "New order ... — EGP ..." made every placement push fail silently.
    let threw = false;
    global.fetch = realFetch;
    try {
      await fetch('http://127.0.0.1:9/never-sent', {
        method: 'POST',
        headers: { Title: 'New order ZSH-TEST \u2014 EGP 865' },
        body: 'x',
      });
    } catch (e) {
      threw = /ByteString/i.test(String(e && e.message));
    }
    ok(threw, 'Node fetch rejects non-ASCII header values');
  });

  await section('[12] ntfy order payloads never contain customer PII', async () => {
    const { buildOrderNtfyPayload } = lib;
    const order = {
      id: 'ZSH-MW2TEST-ABC123',
      total: 1865,
      city: 'Cairo',
      status: 'Pending',
      customer: 'Fatima Secret',
      phone: '01099998888',
      phoneAlt: '01177776666',
      email: 'fatima.secret@example.com',
      address: '12 Hidden Street, Apt 4',
      notes: 'Deliver after 8pm, ask for Fatima',
      items: [{ name: 'Silk Abaya', size: 'M', color: 'Black', qty: 1 }],
    };

    const cases = [
      buildOrderNtfyPayload({ ...order, kind: 'created' }),
      buildOrderNtfyPayload({ ...order, kind: 'status', status: 'Shipped' }),
      buildOrderNtfyPayload({ ...order, kind: 'deleted' }),
    ];

    for (const payload of cases) {
      const text = `${payload.title}\n${payload.message}`;
      for (const [label, value] of [
        ['name', order.customer],
        ['phone', order.phone],
        ['alt phone', order.phoneAlt],
        ['email', order.email],
        ['address', order.address],
        ['notes', order.notes],
        ['item name', order.items[0].name],
      ]) {
        ok(!text.toLowerCase().includes(String(value).toLowerCase()), `${label} is absent`);
      }
      ok(!/@|https?:\/\//.test(text), 'no email address or link');
      ok(!/\d{10,}/.test(text.replace(/ZSH-[A-Z0-9-]+/g, '')), 'no phone-length digit run');
    }

    const created = cases[0];
    eq(created.title, 'New order ZSH-MW2TEST-ABC123 - EGP 1,865', 'created title uses id + total');
    ok(created.message.includes('Total EGP 1,865'), 'total present');
    ok(created.message.includes('City Cairo'), 'city present');
    ok(created.message.includes('Status Pending'), 'status present');

    const deleted = cases[2];
    eq(deleted.title, 'Order ZSH-MW2TEST-ABC123 deleted', 'delete title');
    eq(deleted.message, 'Order ZSH-MW2TEST-ABC123\nStatus Deleted', 'delete body is id + status only');

    const weird = buildOrderNtfyPayload({
      id: 'ZSH-X\nINJECTED',
      total: 10,
      city: 'Cairo\nSecond line',
      status: 'Confirmed',
      kind: 'status',
    });
    ok(!/[\r\n]/.test(weird.title), 'title has no newline (no header injection)');
    ok(weird.message.split('\n').every((line) => line.length > 0), 'message lines are non-empty');
    ok(weird.message.split('\n').length === 4, 'city cannot add extra lines');
  });

  await section('[13] every ntfy call site uses the PII-free builder', async () => {
    const orders = read('api/orders.js');
    const admin = read('api/admin/orders.js');

    ok(orders.includes('buildOrderNtfyPayload({'), 'placement uses the builder');
    ok(orders.includes('buildOrderNtfyPayload,'), 'placement imports the builder');
    ok(!/sendNtfyNotification\(\{[\s\S]{0,200}orderRow\.customer/.test(orders), 'placement does not pass the name');
    ok(!/sendNtfyNotification\(\{[\s\S]{0,200}orderRow\.phone/.test(orders), 'placement does not pass the phone');
    ok(!orders.includes('itemsSummary'), 'item summary was removed from the push');

    const adminStatus = admin.slice(admin.indexOf('ntfy (status) failed'), admin.indexOf('return json(res, 200, {'));
    ok(admin.includes("kind: 'status'"), 'status change uses the builder');
    ok(admin.includes("kind: 'deleted'"), 'delete uses the builder');
    ok(!/order\.(customer|phone|phoneAlt|address|notes)/.test(admin.slice(admin.indexOf('Backup push channel'))),
      'admin pushes never reference customer fields');

    // Telegram keeps the full customer-facing detail.
    ok(orders.includes('buildOrderTelegramMessage('), 'Telegram builder still used on placement');
    ok(read('api/_lib.js').includes('order.customer'), 'Telegram message still renders the customer name');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  · ${f}`);
    process.exit(1);
  }
} finally {
  restore();
}
