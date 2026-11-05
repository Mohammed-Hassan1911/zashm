// Regression coverage for the Bark (iOS) push channel.
//
// Locks the release-blocking contract:
//   * POST https://api.day.app/push with a JSON body, key only in the body;
//   * one stable notification id per order for every lifecycle event, so Bark
//     replaces the notification instead of stacking a new one;
//   * the body mirrors the Telegram message (Arabic, plain text) so the owner
//     can forward it to the customer and confirm the order;
//   * a new order is the only audible alert; later status changes replace the
//     same notification silently (passive, no sound);
//   * a failed database write sends a separate FAILED-… alert to both Bark and
//     Telegram (active + sound) with whatever customer data is available;
//   * every customer-provided value is sanitized and size-capped;
//   * customer detail is never written to the logs;
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
const {
  sendBarkNotification,
  buildOrderBarkNotification,
  buildOrderFailureBarkNotification,
  sendOrderFailureAlert,
  barkOrderNotificationId,
  newFailureReference,
} = lib;

const DEVICE_KEY = 'bark_DEVICEKEY_SECRET_0123456789abcdef';
const TELEGRAM_TOKEN = '123456:TEST_TELEGRAM_TOKEN';
const TELEGRAM_CHAT = '99887766';
const realFetch = global.fetch;
const realError = console.error;
const realWarn = console.warn;
let logs = [];
let warnings = [];
let calls = [];

function stubFetch(impl) {
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
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
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}
const sentBody = () => JSON.parse(calls[0].init.body);
const bytes = (value) => Buffer.byteLength(String(value), 'utf8');
const callsTo = (fragment) => calls.filter((call) => call.url.includes(fragment));
const telegramBody = () => {
  const call = callsTo('api.telegram.org');
  return call.length ? JSON.parse(call[0].init.body) : null;
};

const TRACKING_URL = 'https://za-shm.vercel.app/?track=ZSH-MW30TEST-ABC123&tk=v1.1762344900000.abcdefabcdefabcdefabcdefabcdef12';

const ORDER = {
  id: 'ZSH-MW30TEST-ABC123',
  subtotal: 1800,
  shippingCost: 65,
  discount: 0,
  discountCode: null,
  total: 1865,
  city: 'Cairo',
  status: 'Pending',
  customer: 'Fatima Ahmed',
  phone: '01012345678',
  address: '12 Nile Street, Zamalek, Apt 4',
  createdAt: '2026-11-05T12:15:00.000Z', // 14:15 in Cairo (UTC+2)
  date: '2026-11-05',
  tracking_url: TRACKING_URL,
  items: [
    { name: 'Silk Abaya', size: 'M', color: 'Black', qty: 1, unitPrice: 1300, price: 1300 },
    { name: 'Leather Belt', size: '85', color: 'Tan', qty: 2, unitPrice: 250, price: 500 },
  ],
};

// `initial: true` is what the placement path passes; it is the only audible case.
const sample = buildOrderBarkNotification({ ...ORDER, initial: true });

// Every lifecycle event WITHOUT `initial` — including a move back to Pending —
// must be a silent replacement of the single existing notification.
const LIFECYCLE = [
  ['Pending', '🛍️', 'طلب جديد', 'قيد المراجعة', 'passive', ''],
  ['Confirmed', '🟢', 'تم تأكيد الطلب', 'تم تأكيد الطلب', 'passive', ''],
  ['Processing', '⚙️', 'جاري تجهيز الطلب', 'قيد التجهيز', 'passive', ''],
  ['Shipped', '🚚', 'تم شحن الطلب', 'تم الشحن', 'passive', ''],
  ['Delivered', '✅', 'تم توصيل الطلب', 'تم التوصيل', 'passive', ''],
  ['Cancelled', '🚫', 'تم إلغاء الطلب', 'ملغي', 'passive', ''],
  ['Deleted', '🔴', 'تم حذف الطلب', 'محذوف', 'passive', ''],
];

const EXPECTED_NEW_ORDER_BODY = [
  'ZASHM | طلب جديد',
  '📌 حالة الطلب: قيد المراجعة',
  '',
  '👤 بيانات العميل',
  '• الاسم: Fatima Ahmed',
  '• الهاتف: 01012345678 — واتساب: https://wa.me/201012345678',
  '📍 عنوان الشحن',
  '• المدينة: Cairo',
  '• العنوان: 12 Nile Street, Zamalek, Apt 4',
  '',
  '🛍️ المنتجات',
  '• Silk Abaya (M / Black) × 1 — EGP 1,300',
  '• Leather Belt (85 / Tan) × 2 — EGP 500',
  '',
  '💰 ملخص الحساب',
  '• المجموع الفرعي: EGP 1,800',
  '• الشحن: EGP 65',
  '• الإجمالي: EGP 1,865',
  '',
  '🚚 تتبع الطلب',
  TRACKING_URL,
  '• رقم الطلب: ZSH-MW30TEST-ABC123',
  '',
  '💚 حابين نأكد مع حضرتك الأوردر، ولو عندك أي استفسار إحنا تحت أمرك في أي وقت.',
].join('\n');

const FAILURE = {
  reference: 'FAILED-20261106-153000-AB12',
  reason: 'save_failed',
  customer: {
    name: 'Fatima Ahmed',
    phone: '01012345678',
    address: '12 Nile Street, Zamalek, Apt 4',
    city: 'Cairo',
    notes: 'Deliver after 8pm',
  },
  items: [{ name: 'Silk Abaya', size: 'M', color: 'Black', qty: 1, price: 1300 }],
  subtotal: 1800,
  shippingCost: 65,
  discount: 0,
  total: 1865,
  createdAt: '2026-11-05T12:15:00.000Z',
};

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
    eq(body.subtitle, sample.subtitle, 'subtitle is passed through');
    eq(body.body, sample.body, 'body is passed through');
    eq(body.id, 'zashm-order-ZSH-MW30TEST-ABC123', 'stable notification id');
    eq(typeof body.id, 'string', 'id is a JSON string (Bark requirement)');
    eq(body.group, 'zashm-orders', 'consistent notification group');
    eq(body.sound, 'minuet', 'a new order rings once');
    eq(body.level, 'active', 'a new order is an active alert');
    ok(!body.call, 'no repeating ringtone');
    ok(body.url.endsWith('/admin?tab=orders'), 'tap opens the admin orders view');
    eq(Object.keys(body).sort(),
      ['body', 'copy', 'device_key', 'group', 'id', 'level', 'sound', 'subtitle', 'title', 'url'],
      'only the expected fields are sent');
    eq(body.copy, sample.copy, 'copy payload is passed through');
    ok(!body.copy.includes('wa.me/'), 'copy payload has no WhatsApp link');

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
    ok(!logs[0].includes('ZSH-MW30TEST-ABC123'), 'order id never reaches the logs');
    ok(!logs[0].includes('Fatima'), 'customer name never reaches the logs');
    ok(!logs[0].includes('01012345678'), 'phone never reaches the logs');
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
      throw new TypeError('fetch failed');
    };

    eq(await sendBarkNotification(sample), false, 'network failure returns false');
    eq(logs.length, 1, 'one failure log line');
    ok(logs[0].includes('network') && logs[0].includes('TypeError'), 'error type is logged');
    ok(!logs[0].includes(DEVICE_KEY), 'no key in the log');
    ok(!logs[0].includes('api.day.app'), 'no URL in the log');
    ok(!logs[0].includes('Fatima'), 'no customer data in the log');
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

  await section('[6] NEW ORDER is a forwardable copy of the Telegram message', async () => {
    eq(sample.title, '🛍️ ZASHM | طلب جديد · #ZSH-MW30TEST-ABC123', 'title prioritises the order number');
    eq(sample.subtitle, 'EGP 1,865 · Fatima Ahmed', 'subtitle prioritises total + customer');
    eq(sample.body, EXPECTED_NEW_ORDER_BODY, 'exact NEW ORDER body');
    eq(sample.id, 'zashm-order-ZSH-MW30TEST-ABC123', 'stable id');
    eq(sample.group, 'zashm-orders', 'group');
    eq(sample.sound, 'minuet', 'sound');
    eq(sample.level, 'active', 'level');

    for (const fragment of [
      'بيانات العميل',
      'حالة الطلب: قيد المراجعة',
      'الاسم: Fatima Ahmed',
      'الهاتف: 01012345678 — واتساب: https://wa.me/201012345678',
      'عنوان الشحن',
      'المدينة: Cairo',
      'العنوان: 12 Nile Street, Zamalek, Apt 4',
      'المنتجات',
      'Silk Abaya (M / Black) × 1 — EGP 1,300',
      'Leather Belt (85 / Tan) × 2 — EGP 500',
      'المجموع الفرعي: EGP 1,800',
      'الشحن: EGP 65',
      'الإجمالي: EGP 1,865',
      'تتبع الطلب',
      TRACKING_URL,
      'رقم الطلب: ZSH-MW30TEST-ABC123',
      'حابين نأكد مع حضرتك الأوردر',
    ]) {
      ok(sample.body.includes(fragment), `body contains ${fragment}`);
    }
    // The same sections the Telegram builder renders.
    const telegram = lib.buildOrderTelegramMessage({ ...ORDER, items: ORDER.items }, TRACKING_URL);
    for (const fragment of ['الاسم', 'الهاتف', 'عنوان الشحن', 'المنتجات', 'ملخص الحساب', 'تتبع الطلب']) {
      ok(telegram.includes(fragment), `Telegram still has ${fragment}`);
      ok(sample.body.includes(fragment), `Bark mirrors ${fragment}`);
    }

    // Line-for-line identical to Telegram once Markdown is unwrapped; the only
    // intentional differences are the order id hyphens and the WhatsApp link,
    // which only the notification body carries.
    const telegramPlain = telegram
      .split('\n')
      .map((line) => line.replace(/\*/g, '').replace(/\[واتساب\]\((https:\/\/wa\.me\/\d+)\)/, 'واتساب: $1'))
      .join('\n');
    const barkLines = sample.body.split('\n');
    const tgLines = telegramPlain.split('\n');
    eq(tgLines.length, barkLines.length, 'same number of lines as Telegram');
    const differing = tgLines
      .map((line, index) => (line === barkLines[index] ? null : { index, telegram: line, bark: barkLines[index] }))
      .filter(Boolean);
    eq(differing.length, 1, 'only one line differs from Telegram (the order id)');
    eq(differing[0].telegram, '• رقم الطلب: ZSHMW30TESTABC123', 'Telegram strips hyphens from the id');
    eq(differing[0].bark, '• رقم الطلب: ZSH-MW30TEST-ABC123', 'Bark keeps the real order id');
    ok(sample.body.includes('📌 حالة الطلب: قيد المراجعة'), 'status line is present, like Telegram');
    ok(sample.body.includes('واتساب: https://wa.me/201012345678'), 'phone line links straight to WhatsApp');
    ok(/wa\.me\/\d+/.test(sample.body), 'the WhatsApp link is a real deep link');

    // The copy payload is the message the owner forwards: no raw wa.me URL.
    ok(!sample.copy.includes('wa.me'), 'copy payload has no WhatsApp link');
    ok(sample.copy.includes('• الهاتف: 01012345678 — واتساب'), 'copy payload keeps the WhatsApp hint');
    const copyLines = sample.copy.split('\n');
    eq(copyLines.length, barkLines.length, 'copy keeps the same line count as the notification');
    const copyDiff = barkLines
      .map((line, index) => (line === copyLines[index] ? null : index))
      .filter((index) => index !== null);
    const phoneIndex = barkLines.findIndex((line) => line.startsWith('• الهاتف:'));
    ok(phoneIndex > 0, 'phone line exists');
    eq(copyDiff, [phoneIndex], 'only the phone line differs between body and copy');
    eq(copyLines[phoneIndex], '• الهاتف: 01012345678 — واتساب', 'copy phone line is clean');
    // And the copy is exactly what the customer should receive.
    const telegramClean = telegramPlain.replace(/ — واتساب: https:\/\/wa\.me\/\d+/, ' — واتساب');
    eq(
      copyLines.filter((line, index) => line !== telegramClean.split('\n')[index]).length,
      1,
      'copy differs from Telegram only by the order id'
    );
  });

  await section('[7] only a new order rings; every later status is a silent replacement', async () => {
    for (const [status, emoji, label, statusLine, level, sound] of LIFECYCLE) {
      const payload = buildOrderBarkNotification({ ...ORDER, status });

      eq(payload.title, `${emoji} ZASHM | ${label} · #ZSH-MW30TEST-ABC123`, `${status} title`);
      eq(payload.subtitle, 'EGP 1,865 · Fatima Ahmed', `${status} subtitle`);
      eq(payload.level, level, `${status} level`);
      eq(payload.sound, sound, `${status} sound`);
      eq(payload.body.split('\n')[0], `ZASHM | ${label}`, `${status} headline`);
      eq(payload.body.split('\n')[1], `📌 حالة الطلب: ${statusLine}`, `${status} status line`);

      for (const fragment of [
        '• الاسم: Fatima Ahmed',
        '• الهاتف: 01012345678',
        '• العنوان: 12 Nile Street, Zamalek, Apt 4',
        '• Silk Abaya (M / Black) × 1 — EGP 1,300',
        '• Leather Belt (85 / Tan) × 2 — EGP 500',
        '• الإجمالي: EGP 1,865',
      ]) {
        ok(payload.body.includes(fragment), `${status} keeps ${fragment}`);
      }

      if (status === 'Deleted') {
        ok(payload.body.endsWith('تم حذف هذا الأوردر من ZASHM.'), 'deleted footer');
        ok(!payload.body.includes('حابين نأكد'), 'deleted has no confirmation line');
      } else if (status === 'Cancelled') {
        ok(payload.body.endsWith('تم إلغاء هذا الأوردر.'), 'cancelled footer');
      } else {
        ok(payload.body.endsWith('حابين نأكد مع حضرتك الأوردر، ولو عندك أي استفسار إحنا تحت أمرك في أي وقت.'),
          `${status} confirmation line`);
      }
    }

    // Placement (`initial: true`) is the ONLY audible event.
    const first = buildOrderBarkNotification({ ...ORDER, status: 'Pending', initial: true });
    eq(first.level, 'active', 'placement is an active alert');
    eq(first.sound, 'minuet', 'placement rings once');

    // Moving an order BACK to Pending — from any status — stays completely silent.
    for (const from of ['Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']) {
      const back = buildOrderBarkNotification({ ...ORDER, status: 'Pending' });
      eq(back.level, 'passive', `${from} → Pending is passive`);
      eq(back.sound, '', `${from} → Pending has no sound`);
      eq(back.id, first.id, `${from} → Pending replaces the same notification`);
      eq(back.title, first.title, `${from} → Pending reuses the new-order title`);
    }

    // The wire payload for a status update really is silent.
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));
    await sendBarkNotification(buildOrderBarkNotification({ ...ORDER, status: 'Shipped' }));
    const wire = sentBody();
    eq(wire.level, 'passive', 'status update is passive');
    ok(!('sound' in wire), 'status update omits sound entirely');
    ok(!wire.call, 'no repeating ring');

    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));
    await sendBarkNotification(buildOrderBarkNotification({ ...ORDER, status: 'Pending' }));
    const backWire = sentBody();
    eq(backWire.level, 'passive', 'back-to-Pending wire is passive');
    ok(!('sound' in backWire), 'back-to-Pending sends no sound key');
    ok(!backWire.call, 'back-to-Pending does not ring');
  });

  await section('[8] one stable notification id for the whole order lifecycle', async () => {
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

    // The failure alert must never replace a real order notification.
    const failure = buildOrderFailureBarkNotification(FAILURE);
    eq(failure.id, 'zashm-order-FAILED-20261106-153000-AB12', 'failure uses its own id');
    ok(failure.id !== buildOrderBarkNotification(ORDER).id, 'failure id cannot replace the order');
  });

  await section('[9] the item list is capped and the payload stays under the APNs budget', async () => {
    const manyItems = Array.from({ length: 12 }, (_, index) => ({
      name: `Item ${index + 1}`,
      size: 'M',
      color: 'Black',
      qty: 1,
      unitPrice: 100,
      price: 100,
    }));

    const capped = buildOrderBarkNotification({ ...ORDER, items: manyItems });
    ok(capped.body.includes('• Item 10 '), 'tenth item is shown');
    ok(!capped.body.includes('• Item 11 '), 'eleventh item is not shown');
    ok(capped.body.includes('• +2 more items'), 'remaining items are summarised');
    eq(capped.body.split('\n').filter((line) => line.startsWith('• Item ')).length, 10,
      'exactly ten item lines');

    const single = buildOrderBarkNotification({
      ...ORDER,
      items: [...manyItems.slice(0, 10), manyItems[10]],
    });
    ok(single.body.includes('• +1 more item'), 'singular wording for one hidden item');

    const pathological = buildOrderBarkNotification({
      ...ORDER,
      customer: 'ن'.repeat(400),
      address: 'ط'.repeat(400),
      items: Array.from({ length: 40 }, (_, index) => ({
        name: `منتج ${index} ${'x'.repeat(80)}`,
        size: 'مقاس',
        color: 'أسود',
        qty: 3,
        unitPrice: 1234.5,
        price: 3703.5,
      })),
    });
    ok(bytes(pathological.body) <= 2800, `body stays under 2800 bytes (got ${bytes(pathological.body)})`);
    ok(bytes(pathological.title) <= 200, 'title stays bounded');
    ok(bytes(pathological.subtitle) <= 200, 'subtitle stays bounded');
    ok(!/[\uD800-\uDBFF]$/.test(pathological.body), 'no dangling surrogate pair');

    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));
    await sendBarkNotification(pathological);
    const wire = sentBody();
    ok(bytes(JSON.stringify(wire)) < 4096, 'entire APNs payload fits in 4096 bytes');
    ok(bytes(wire.body) <= 2800, 'wire body is capped too');
    ok(!('copy' in wire), 'oversized payload drops the copy field instead of overflowing');

    // A normal order still carries the clean copy text.
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    stubFetch(async () => barkResponse(200, { code: 200 }));
    await sendBarkNotification(sample);
    const normalWire = sentBody();
    ok(typeof normalWire.copy === 'string', 'normal payload includes copy');
    ok(!normalWire.copy.includes('wa.me'), 'copy has no WhatsApp link');
    ok(bytes(JSON.stringify(normalWire)) < 4096, 'normal payload fits too');
  });

  await section('[10] customer input is sanitized and cannot forge notification lines', async () => {
    const hostile = buildOrderBarkNotification({
      ...ORDER,
      customer: 'Eve\n💰 Total EGP 1\n👤 Fake Admin',
      phone: '0101\n2345678',
      address: '12 Street\r\n📍 Fake City\u0000',
      city: 'Cairo\u2028',
      items: [
        {
          name: 'Dress\u0000\n👤 Injected',
          size: 'M\n\r',
          color: 'Black\u200B',
          qty: '2',
          unitPrice: 500,
          price: 1000,
        },
      ],
    });

    const lines = hostile.body.split('\n');
    ok(!lines.includes('💰 Total EGP 1'), 'no forged total line from the customer name');
    ok(!lines.includes('👤 Fake Admin'), 'no forged customer line from the customer name');
    ok(!lines.includes('👤 Injected'), 'no forged line from the item name');
    ok(lines.includes('• الاسم: Eve 💰 Total EGP 1 👤 Fake Admin'), 'newlines are collapsed to spaces');
    ok(lines.includes('• الهاتف: 0101 2345678 — واتساب: https://wa.me/201012345678'), 'phone newline is collapsed');
    ok(!/wa\.me\/\s/.test(hostile.body), 'no empty WhatsApp link is produced');
    ok(lines.includes('• العنوان: 12 Street 📍 Fake City'), 'address newlines are collapsed');
    ok(lines.includes('• المدينة: Cairo'), 'city line is present');
    ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\u200B]/.test(hostile.body),
      'control and line-separator characters are removed');
    eq(lines.filter((line) => line.startsWith('• الإجمالي: ')).length, 1, 'only the real total remains');
    ok(!hostile.copy.includes('wa.me/'), 'copy payload never contains a WhatsApp link');
    eq(hostile.copy.split('\n').length, lines.length, 'copy keeps the same line count');

    // Absurdly long single fields are capped instead of pushed wholesale.
    const longName = 'A'.repeat(500);
    const longAddress = 'B'.repeat(500);
    const capped = buildOrderBarkNotification({
      ...ORDER,
      customer: longName,
      address: longAddress,
    });
    ok(!capped.body.includes('A'.repeat(61)), 'customer name capped at 60 characters');
    ok(!capped.body.includes('B'.repeat(221)), 'address capped at 220 characters');
  });

  await section('[11] PII scope: included by design, never logged, no extras', async () => {
    const privateOrder = {
      ...ORDER,
      phoneAlt: '01177776666',
      email: 'fatima.secret@example.com',
      notes: 'Deliver after 8pm, ask for Fatima',
    };
    const payload = buildOrderBarkNotification({ ...privateOrder, status: 'Shipped' });

    // The body mirrors Telegram, so every operational field is included.
    ok(payload.body.includes('• الاسم: Fatima Ahmed'), 'customer name is included');
    ok(payload.body.includes('• الهاتف: 01012345678'), 'phone is included');
    ok(payload.body.includes('• هاتف بديل: 01177776666'), 'alt phone is included');
    ok(payload.body.includes('• الإيميل: fatima.secret@example.com'), 'email is included');
    ok(payload.body.includes('• العنوان: 12 Nile Street, Zamalek, Apt 4'), 'address is included');
    ok(payload.body.includes('• ملاحظات: Deliver after 8pm, ask for Fatima'), 'notes are included');
    ok(payload.body.includes('• Silk Abaya (M / Black)'), 'items are included');

    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    global.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await sendBarkNotification(payload);
    const log = logs.join('\n');
    ok(!log.includes('Fatima'), 'name never logged');
    ok(!log.includes('01012345678'), 'phone never logged');
    ok(!log.includes('01177776666'), 'alt phone never logged');
    ok(!log.includes('fatima.secret@example.com'), 'email never logged');
    ok(!log.includes('12 Nile Street'), 'address never logged');
    ok(!log.includes('Silk Abaya'), 'item never logged');
    ok(!log.includes(DEVICE_KEY), 'key never logged');
  });

  await section('[12] a failed order alerts BOTH Telegram and Bark', async () => {
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    stubFetch(async (url) => {
      if (String(url).includes('api.day.app')) return barkResponse(200, { code: 200 });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });

    const result = await sendOrderFailureAlert(FAILURE);

    eq(result.reference, FAILURE.reference, 'the reference is preserved');
    eq(result.telegram, true, 'Telegram accepted the alert');
    eq(result.bark, true, 'Bark accepted the alert');
    eq(calls.length, 2, 'exactly one request per channel');

    const tg = telegramBody();
    ok(tg, 'Telegram request exists');
    ok(!('parse_mode' in tg), 'failure alert is plain text (no Markdown/link injection)');
    ok(tg.text.includes('الأوردر لم يُحفظ'), 'Telegram says the order was not saved');
    ok(tg.text.includes('FAILED-20261106-153000-AB12'), 'Telegram carries the reference');
    ok(tg.text.includes('الاسم: Fatima Ahmed'), 'Telegram carries the customer name');
    ok(tg.text.includes('الهاتف: 01012345678'), 'Telegram carries the phone');
    ok(tg.text.includes('العنوان: 12 Nile Street'), 'Telegram carries the address');
    ok(tg.text.includes('Silk Abaya'), 'Telegram carries the known items');
    ok(tg.text.includes('الإجمالي: EGP 1,865'), 'Telegram carries the server total');
    ok(tg.text.includes('تواصل مع العميل يدويًا'), 'Telegram tells the owner what to do');
    ok(!tg.text.includes('fetch failed'), 'no raw error leaks into Telegram');

    const bark = callsTo('api.day.app')[0];
    const wire = JSON.parse(bark.init.body);
    eq(wire.id, 'zashm-order-FAILED-20261106-153000-AB12', 'separate failure id');
    eq(wire.level, 'active', 'failure alert is active');
    eq(wire.sound, 'minuet', 'failure alert rings');
    ok(wire.title.includes('طلب لم يُحفظ'), 'Bark title says the order was not saved');
    ok(wire.body.includes('FAILED-20261106-153000-AB12'), 'Bark carries the reference');
    ok(wire.body.includes('الاسم: Fatima Ahmed'), 'Bark carries the customer name');
    ok(wire.body.includes('الهاتف: 01012345678'), 'Bark carries the phone');
    ok(wire.body.includes('تواصل مع العميل يدويًا'), 'Bark tells the owner what to do');
    ok(!wire.body.includes('fetch failed'), 'no raw error leaks into Bark');

    // One channel being down must not stop the other.
    capture();
    process.env.BARK_DEVICE_KEY = DEVICE_KEY;
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    stubFetch(async (url) => {
      if (String(url).includes('api.day.app')) return barkResponse(500, { code: 500, message: 'down' });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    const partial = await sendOrderFailureAlert(FAILURE);
    eq(partial.telegram, true, 'Telegram still succeeds when Bark is down');
    eq(partial.bark, false, 'Bark failure is reported, not thrown');
  });

  await section('[13] failure-alert metadata degrades safely without DB data', async () => {
    const partial = buildOrderFailureBarkNotification({
      reference: newFailureReference(),
      reason: 'product_lookup',
      customer: { name: 'Omar', phone: '01111111111', city: 'Giza', address: '6 Pyramids Road' },
      items: [{ productId: 7, size: 'L', color: 'Red', qty: 2 }],
    });
    ok(partial.body.includes('تعذر قراءة بيانات المنتجات'), 'reason is mapped to Arabic');
    ok(partial.body.includes('منتج #7'), 'unknown product still has a readable placeholder');
    ok(partial.body.includes('× 2'), 'quantity survives');
    ok(!partial.body.includes('الإجمالي:'), 'no invented total without server prices');
    ok(partial.body.includes('تواصل مع العميل يدويًا'), 'manual follow-up instruction');
    ok(/^FAILED-\d{14}-[A-F0-9]{4}$/.test(newFailureReference()), 'reference shape');
  });

  await section('[14] call sites: full order object, silent updates, failure paths', async () => {
    const orders = read('api/orders.js');
    const admin = read('api/admin/orders.js');
    const libSrc = read('api/_lib.js');

    ok(orders.includes('buildOrderBarkNotification({'), 'placement uses the builder');
    ok(orders.includes('sendBarkNotification,'), 'placement imports the sender');
    ok(/sendBarkNotification\(payload\)/.test(orders), 'placement sends the built payload');
    ok(orders.includes('...orderRow'), 'placement passes the full order row');
    ok(orders.includes('items: orderItems'), 'placement passes the items');
    ok(orders.includes('tracking_url: trackingUrl'), 'placement passes the tracking link');
    ok(orders.includes('createdAt: timestamps.created'), 'placement passes the order time');
    ok(orders.includes('initial: true'), 'placement marks the notification as the first one (audible)');
    ok(orders.indexOf('sendTelegramNotification(message)') < orders.indexOf('buildOrderBarkNotification({'),
      'Telegram still sends first and is not replaced');
    ok(orders.includes("console.error('Bark notification failed:'"), 'placement failure is contained');

    ok(admin.includes('buildOrderBarkNotification({'), 'admin status/delete use the builder');
    ok(admin.includes('status: newStatus'), 'status change reflects the new status');
    ok(admin.includes("status: 'Deleted'"), 'deletion uses the Deleted status');
    ok(admin.includes('...full'), 'status/delete pass the full order row');
    ok(admin.includes('shippingCost:'), 'status/delete pass shipping');
    ok(admin.includes('tracking_url:'), 'status/delete pass the tracking link');
    ok(admin.includes('parseOrderRow(row)'), 'deletion reads the order before removing it');
    ok(/if \(r\.changed !== false\) \{/.test(admin), 'idempotent retries do not re-notify');
    ok(admin.includes("console.error('Bark (status) failed:'"), 'status failure is contained');
    ok(admin.includes("console.error('Bark (delete) failed:'"), 'delete failure is contained');
    ok(!admin.includes('initial:'), 'status/delete never mark a notification as the first one');
    ok(/const audible = rawStatus === 'Failed' \|\| \(initial === true && rawStatus === 'Pending'\)/.test(libSrc),
      'only placement (initial + Pending) is audible');

    // The plain-text body must mirror the Telegram template line for line.
    const plainSrc = libSrc.slice(
      libSrc.indexOf('function buildOrderPlainMessage'),
      libSrc.indexOf('function buildOrderFailureMessage')
    );
    ok(plainSrc.includes('— واتساب: https://wa.me/${wa}'), 'phone line links straight to WhatsApp');
    ok(libSrc.includes('function stripWhatsAppLink'), 'link stripping is centralised');
    ok(libSrc.includes('copy: stripWhatsAppLink(body)'), 'notification ships a link-free copy payload');
    ok(/function stripWhatsAppLink[\s\S]{0,400}\.replace\(\/ — واتساب:/.test(libSrc),
      'only the WhatsApp suffix is stripped, the hint stays');
    ok(plainSrc.includes('📌 حالة الطلب: ${style.line}'), 'status line is rendered in the body');
    ok(libSrc.includes('📌 *حالة الطلب:* قيد المراجعة'), 'Telegram renders the same status line');
    ok(plainSrc.indexOf('🚚 تتبع الطلب') < plainSrc.indexOf('• رقم الطلب:'),
      'order number comes after the tracking link, like Telegram');
    ok(plainSrc.indexOf('📍 عنوان الشحن') < plainSrc.indexOf('🛍️ المنتجات'),
      'shipping address precedes the items, like Telegram');

    // Failure fallback: every database-failure exit alerts; business refusals do not.
    ok(orders.includes('sendOrderFailureAlert,'), 'placement imports the failure alert');
    ok(orders.includes("alertFailure('product_lookup')"), 'product read failure alerts');
    ok(orders.includes("alertFailure('coupon_lookup')"), 'coupon read failure alerts');
    ok(orders.includes("alertFailure('save_failed')"), 'RPC failure alerts');
    ok(orders.includes("alertFailure('unexpected')"), 'unexpected failure alerts');
    ok(orders.includes('if (!orderStored) await alertFailure'), 'no false alert after a commit');
    ok(orders.includes('orderStored = true'), 'the stored flag is set on success');
    ok(/reason === 'unavailable'[\s\S]{0,900}?return json\(res, 422/.test(orders)
      && !/reason === 'unavailable'[\s\S]{0,900}?alertFailure/.test(orders),
      'stock refusal stays silent');
    ok(/reason === 'coupon_unavailable'[\s\S]{0,300}?return json\(res, 422/.test(orders)
      && !/reason === 'coupon_unavailable'[\s\S]{0,300}?alertFailure/.test(orders),
      'coupon refusal stays silent');

    // The Telegram order message still carries the full customer detail.
    ok(libSrc.includes('TELEGRAM_BOT_TOKEN'), 'Telegram configuration untouched');
    ok(/function buildOrderTelegramMessage[\s\S]{0,4000}order\.customer/.test(libSrc),
      'Telegram still renders the customer name');
    ok(/function buildOrderTelegramMessage[\s\S]{0,4000}order\.phone/.test(libSrc),
      'Telegram still renders the phone');
    ok(/function buildOrderTelegramMessage[\s\S]{0,4000}order\.notes/.test(libSrc),
      'Telegram still renders the notes');
  });

  await section('[15] ntfy is completely removed', async () => {
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

  await section('[16] a hung Bark server cannot hold the request open', async () => {
    const src = read('api/_lib.js');
    ok(src.includes('const BARK_TIMEOUT_MS = 8000'), 'an explicit timeout constant exists');
    ok(src.includes('const FAILURE_ALERT_TIMEOUT_MS = 5000'), 'the failure path has a tighter bound');
    ok(/AbortSignal\.timeout\([\s\S]{0,160}BARK_TIMEOUT_MS/.test(src), 'fetch is bounded by it');
    ok(src.includes("const BARK_PUSH_URL = 'https://api.day.app/push'"), 'official endpoint is pinned');
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
