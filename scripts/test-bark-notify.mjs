// Regression coverage for the Bark (iOS) push channel.
//
// Locks the release-blocking contract:
//   * POST https://api.day.app/push with a JSON body, key only in the body;
//   * one stable notification id per order for every lifecycle event, so Bark
//     replaces the notification instead of stacking a new one;
//   * the professional title/body design and the `zashm-orders` group;
//   * no customer PII ever leaves the server;
//   * Bark failures never throw and never leak the device key;
//   * ntfy is gone from the codebase and Telegram is untouched.
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
const { sendBarkNotification, buildOrderBarkNotification, barkOrderNotificationId } = lib;

const DEVICE_KEY = 'bark_DEVICEKEY_SECRET_0123456789abcdef';
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
function barkResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
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
  delete process.env.BARK_DEVICE_KEY;
}
const sentBody = () => JSON.parse(calls[0].init.body);

const ORDER = {
  id: 'ZSH-MW30TEST-ABC123',
  total: 1865,
  city: 'Cairo',
  status: 'Pending',
};

const sample = buildOrderBarkNotification(ORDER);

const SEP = '━'.repeat(14);
const LIFECYCLE = [
  ['Pending', '🛍️', 'New Order'],
  ['Confirmed', '🟢', 'Order Confirmed'],
  ['Processing', '⚙️', 'Order Processing'],
  ['Shipped', '🚚', 'Order Shipped'],
  ['Delivered', '✅', 'Order Delivered'],
  ['Cancelled', '🚫', 'Order Cancelled'],
  ['Deleted', '🔴', 'Order Deleted'],
];

try {
  console.log('Bark notification channel');

  await section('[1] POST /push carries the documented JSON body', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200, message: 'success' }));

    const result = await sendBarkNotification(sample);

    eq(result, true, 'a successful push returns true');
    eq(calls.length, 1, 'exactly one request');
    eq(calls[0].url, 'https://api.day.app/push', 'official /push endpoint');
    eq(calls[0].init.method, 'POST', 'POST is used');
    eq(calls[0].init.headers['Content-Type'], 'application/json; charset=utf-8', 'JSON content type');
    ok(!calls[0].url.includes(DEVICE_KEY), 'device key is never in the URL');
    ok(!('Authorization' in calls[0].init.headers), 'no Authorization header');

    const body = sentBody();
    eq(body.device_key, DEVICE_KEY, 'device key travels in the JSON body');
    eq(body.title, sample.title, 'title is passed through');
    eq(body.body, sample.body, 'body is passed through');
    eq(body.id, 'zashm-order-ZSH-MW30TEST-ABC123', 'stable notification id');
    eq(typeof body.id, 'string', 'id is a JSON string (Bark requirement)');
    eq(body.group, 'zashm-orders', 'consistent notification group');
    eq(body.sound, 'minuet', 'pleasant built-in sound');
    eq(body.level, 'active', 'active level — never a critical alert');
    ok(!body.call, 'no repeating ringtone');
    ok(body.url.endsWith('/admin?tab=orders'), 'tap opens the admin orders view');

    eq(logs.length, 0, 'success logs nothing');
    eq(warnings.length, 0, 'success warns nothing');
  });

  await section('[2] Bark API errors are logged with status and a redacted message', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    // The real server echoes the key: "failed to get [KEY] device token".
    stubFetch(async () => barkResponse(400, {
      code: 400,
      message: `failed to get device token: failed to get [${DEVICE_KEY}] device token from database`,
    }));

    const result = await sendBarkNotification(sample);

    eq(result, false, 'non-2xx returns false');
    eq(logs.length, 1, 'one failure log line');
    ok(logs[0].includes('HTTP 400'), 'HTTP status is surfaced');
    ok(logs[0].includes('[device_key]'), 'device key is redacted');
    ok(!logs[0].includes(DEVICE_KEY), 'device key never reaches the logs');
    ok(!logs[0].includes('ZSH-MW30TEST-ABC123'), 'order data never reaches the logs');
    ok(logs[0].length < 400, 'log line is bounded');
  });

  await section('[3] HTTP 200 with a non-200 Bark code is treated as a failure', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 400, message: 'invalid device key' }));
    eq(await sendBarkNotification(sample), false, 'code !== 200 returns false');
    ok(logs[0].includes('HTTP 200'), 'transport status is still logged');
  });

  await section('[4] network and timeout failures never throw or leak', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    global.fetch = async () => {
      const err = new TypeError('fetch failed');
      throw err;
    };

    eq(await sendBarkNotification(sample), false, 'network failure returns false');
    eq(logs.length, 1, 'one failure log line');
    ok(logs[0].includes('network') && logs[0].includes('TypeError'), 'error type is logged');
    ok(!logs[0].includes(DEVICE_KEY), 'no key in the log');
    ok(!logs[0].includes('api.day.app'), 'no URL in the log');
  });

  await section('[5] missing BARK_DEVICE_KEY skips cleanly (no fetch, one warning)', async () => {
    capture();
    delete process.env.BARK_DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));

    eq(await sendBarkNotification(sample), false, 'unconfigured channel returns false');
    eq(calls.length, 0, 'no request is attempted');
    eq(warnings.length, 1, 'exactly one warning');
    ok(warnings[0].includes('BARK_DEVICE_KEY'), 'warning names the env var');
    ok(!warnings[0].includes(DEVICE_KEY), 'no key in the warning');
  });

  await section('[6] professional design for every lifecycle event', async () => {
    for (const [status, emoji, label] of LIFECYCLE) {
      const payload = buildOrderBarkNotification({ ...ORDER, status });
      const expectedBody =
        status === 'Deleted'
          ? [
              SEP,
              '💰 Total: EGP 1,865',
              '📍 City: Cairo',
              '📦 Status: Deleted',
              SEP,
              'The order was removed from ZASHM.',
            ].join('\n')
          : [
              SEP,
              '💰 Total: EGP 1,865',
              '📍 City: Cairo',
              `📦 Status: ${status}`,
              SEP,
              'Tap to review the order.',
            ].join('\n');

      eq(payload.title, `${emoji} ZASHM | ${label} #ZSH-MW30TEST-ABC123`, `${status} title`);
      eq(payload.body, expectedBody, `${status} body`);
      eq(payload.body.split(SEP).length - 1, 2, `${status} keeps both separators`);
      eq(payload.group, 'zashm-orders', `${status} group`);
      eq(payload.sound, 'minuet', `${status} sound`);
    }

    // Deletion carried by itself still renders the design without fake totals.
    const deleted = buildOrderBarkNotification({ id: ORDER.id, status: 'Deleted' });
    eq(
      deleted.body,
      [SEP, '📦 Status: Deleted', SEP, 'The order was removed from ZASHM.'].join('\n'),
      'delete-only body has no invented total or city'
    );

    // A future/unknown status must not break the title.
    const unknown = buildOrderBarkNotification({ ...ORDER, status: 'Refunded' });
    ok(unknown.title.startsWith('📦 ZASHM | Order Updated #'), 'unknown status falls back safely');
    ok(unknown.body.includes('📦 Status: Refunded'), 'unknown status text is still shown');
  });

  await section('[7] one stable notification id for the whole order lifecycle', async () => {
    const ids = new Set(
      LIFECYCLE.map(([status]) => buildOrderBarkNotification({ ...ORDER, status }).id)
    );
    eq(ids.size, 1, 'every event reuses the same id');
    eq([...ids][0], 'zashm-order-ZSH-MW30TEST-ABC123', 'id is derived from the order id');
    eq([...ids][0], barkOrderNotificationId(ORDER.id), 'shared id helper is the single source');

    ok(buildOrderBarkNotification({ ...ORDER, status: 'Confirmed' }).id !== 'zashm-orders',
      'group is not used as the replacement id');
    ok(barkOrderNotificationId('ZSH A\nB') === 'zashm-order-ZSHAB',
      'id is sanitized to safe characters');
    eq(barkOrderNotificationId(''), 'zashm-order-unknown', 'missing id degrades safely');
    eq(typeof barkOrderNotificationId(ORDER.id), 'string', 'id is always a string');
  });

  await section('[8] customer PII never reaches the notification', async () => {
    const privateOrder = {
      ...ORDER,
      customer: 'Fatima Secret',
      phone: '01099998888',
      phoneAlt: '01177776666',
      email: 'fatima.secret@example.com',
      address: '12 Hidden Street, Apt 4',
      notes: 'Deliver after 8pm, ask for Fatima',
      items: [{ name: 'Silk Abaya', size: 'M', color: 'Black', qty: 1 }],
    };

    const payloads = LIFECYCLE.map(([status]) => buildOrderBarkNotification({ ...privateOrder, status }));
    for (const payload of payloads) {
      const text = `${payload.title}\n${payload.body}`;
      for (const [label, value] of [
        ['name', privateOrder.customer],
        ['phone', privateOrder.phone],
        ['alt phone', privateOrder.phoneAlt],
        ['email', privateOrder.email],
        ['address', privateOrder.address],
        ['notes', privateOrder.notes],
        ['item name', privateOrder.items[0].name],
      ]) {
        ok(!text.toLowerCase().includes(String(value).toLowerCase()), `${label} is absent`);
      }
      ok(!/@|https?:\/\//.test(text), 'no email address or link');
      // The order id contains digits; remove it before looking for phone runs.
      ok(!/\d{10,}/.test(text.replace(/ZSH-[A-Z0-9-]+/g, '')), 'no phone-length digit run');
    }
  });

  await section('[9] the HTTP request body is PII-free too', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));

    await sendBarkNotification(buildOrderBarkNotification({ ...ORDER, status: 'Shipped' }));
    const serialized = calls[0].init.body;
    ok(!serialized.includes('Fatima'), 'no customer name');
    ok(!serialized.includes('01099998888'), 'no phone');
    ok(!serialized.includes('@'), 'no email');
    ok(!serialized.includes('Street'), 'no address');
    const body = JSON.parse(serialized);
    eq(Object.keys(body).sort(), ['body', 'device_key', 'group', 'id', 'level', 'sound', 'title', 'url'],
      'only the expected fields are sent');
  });

  await section('[10] call sites, duplicate guard and Telegram safety (source lock)', async () => {
    const orders = read('api/orders.js');
    const admin = read('api/admin/orders.js');
    const libSrc = read('api/_lib.js');

    ok(orders.includes('buildOrderBarkNotification({'), 'placement uses the builder');
    ok(orders.includes('sendBarkNotification,'), 'placement imports the sender');
    ok(/sendBarkNotification\(payload\)/.test(orders), 'placement sends the built payload');
    ok(orders.indexOf('sendTelegramNotification(message)') < orders.indexOf('buildOrderBarkNotification({'),
      'Telegram still sends first and is not replaced');
    ok(orders.includes("console.error('Bark notification failed:'"), 'placement failure is contained');

    ok(admin.includes('buildOrderBarkNotification({'), 'admin status/delete use the builder');
    ok(admin.includes("status: newStatus"), 'status change reflects the new status');
    ok(admin.includes("status: 'Deleted'"), 'deletion uses the Deleted status');
    ok(/if \(r\.changed !== false\) \{/.test(admin), 'idempotent retries do not re-notify');
    ok(admin.includes("console.error('Bark (status) failed:'"), 'status failure is contained');
    ok(admin.includes("console.error('Bark (delete) failed:'"), 'delete failure is contained');

    // The Telegram message still carries the full customer detail.
    ok(libSrc.includes("requireSecret('TELEGRAM_BOT_TOKEN')") ||
      libSrc.includes('TELEGRAM_BOT_TOKEN'), 'Telegram configuration untouched');
    ok(/function buildOrderTelegramMessage[\s\S]{0,4000}order\.customer/.test(libSrc),
      'Telegram still renders the customer name');

    ok(!/sendBarkNotification\([^)]*(customer|phone|email|address|notes)/.test(libSrc + orders + admin),
      'no customer field is ever passed to the push channel');
  });

  await section('[11] ntfy is completely removed', async () => {
    const offenders = [];
    for (const file of [
      'api/_lib.js', 'api/orders.js', 'api/admin/orders.js', 'api/admin/products.js',
      'api/admin/users.js', 'api/admin/coupons.js', 'api/admin/upload.js',
      'api/auth.js', 'api/coupons/validate.js', 'package.json',
    ]) {
      const src = read(file);
      if (/ntfy/i.test(src)) offenders.push(file);
    }
    eq(offenders, [], 'no ntfy reference in API code or package.json');
    ok(!read('.env.example').includes('NTFY_'), 'no ntfy env vars documented');

    // The old suite and module-level helpers must be gone, not merely unused.
    eq(lib.sendNtfyNotification, undefined, 'sendNtfyNotification is not exported');
    eq(lib.buildOrderNtfyPayload, undefined, 'buildOrderNtfyPayload is not exported');
    eq(lib.ntfyConfigSummary, undefined, 'ntfyConfigSummary is not exported');
  });

  await section('[12] a hung Bark server cannot hold the request open', async () => {
    const src = read('api/_lib.js');
    ok(src.includes('const BARK_TIMEOUT_MS = 8000'), 'an explicit timeout constant exists');
    ok(src.includes('signal: AbortSignal.timeout(BARK_TIMEOUT_MS)'), 'fetch is bounded by it');
    ok(src.includes('const BARK_PUSH_URL = \'https://api.day.app/push\''), 'official endpoint is pinned');
  });
} finally {
  restore();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(failures.map((f) => `  · ${f}`).join('\n'));
  process.exit(1);
}
process.exit(0);
