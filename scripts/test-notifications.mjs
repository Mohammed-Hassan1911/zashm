// Regression coverage for order notifications (Telegram only).
//
// Locks the release-blocking contract:
//   * a new order sends the customer confirmation text — the exact message the
//     owner forwards on WhatsApp — as PLAIN TEXT, so `_` in an email and `-`
//     in an order id survive the copy untouched;
//   * action URLs live in an inline keyboard, never in the copyable body;
//   * a status change or deletion sends the SHORT internal line instead;
//   * customer-controlled values cannot forge an extra line or price;
//   * a message is clamped to Telegram's byte budget;
//   * a failed database write still alerts the owner on Telegram;
//   * Bark is gone from the code, tests, config and package scripts.
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
  sendTelegramNotification,
  buildOrderTelegramMessage,
  buildOrderStatusMessage,
  buildOrderEditMessage,
  buildOrderTelegramActions,
  buildOrderFailureMessage,
  sendOrderFailureAlert,
  newFailureReference,
} = lib;

const TELEGRAM_TOKEN = '123456:TEST_TELEGRAM_TOKEN';
const TELEGRAM_CHAT = '99887766';
// Needed so the WhatsApp hand-off button can be signed, exactly like production.
process.env.SESSION_SECRET = 'test-session-secret-for-notification-tests';
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
function telegramResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ ok: status >= 200 && status < 300 }),
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
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}
const bytes = (value) => Buffer.byteLength(String(value), 'utf8');
const telegramBody = () => {
  const call = calls.find((entry) => entry.url.includes('api.telegram.org'));
  return call ? JSON.parse(call.init.body) : null;
};

const TRACKING_URL =
  'https://za-shm.vercel.app/?track=ZSH-MW30TEST-ABC123&tk=v1.1762344900000.abcdefabcdefabcdefabcdefabcdef12';

const ORDER = {
  id: 'ZSH-MW30TEST-ABC123',
  status: 'Pending',
  customer: 'Fatima Ahmed',
  phone: '01012345678',
  phoneAlt: '01177776666',
  email: 'fatima.secret@example.com',
  city: 'Cairo',
  address: '12 Nile Street, Zamalek, Apt 4',
  notes: 'Deliver after 8pm',
  items: [
    { name: 'Silk Abaya', size: 'M', color: 'Black', qty: 1, price: 1300 },
    { name: 'Leather Belt', size: '85', color: 'Tan', qty: 2, price: 500 },
  ],
  subtotal: 1800,
  shippingCost: 65,
  discount: 250,
  discountCode: 'EID_250',
  total: 1615,
  createdAt: '2026-11-05T12:15:00.000Z',
  tracking_url: TRACKING_URL,
};

const EXPECTED_CUSTOMER_MESSAGE = [
  'السلام عليكم أ/ Fatima 👋',
  'مع حضرتك فريق ZASHM. حابين نأكد مع حضرتك تفاصيل الأوردر قبل الشحن.',
  '',
  '👤 بيانات العميل',
  '• الاسم: Fatima Ahmed',
  '• الهاتف: 01012345678',
  '• هاتف بديل: 01177776666',
  '• الإيميل: fatima.secret@example.com',
  '',
  '📍 عنوان الشحن',
  '• المدينة: Cairo',
  '• العنوان: 12 Nile Street, Zamalek, Apt 4',
  '• ملاحظات: Deliver after 8pm',
  '',
  '🛍️ المنتجات',
  '• Silk Abaya (M / Black) × 1 — EGP 1,300',
  '• Leather Belt (85 / Tan) × 2 — EGP 500',
  '',
  '💰 ملخص الحساب',
  '• المجموع الفرعي: EGP 1,800',
  '• الشحن: EGP 65',
  '• كود الخصم: EID_250',
  '• قيمة الخصم: EGP 250',
  '• الإجمالي: EGP 1,615',
  '',
  '🚚 تتبع الأوردر',
  TRACKING_URL,
  '• رقم الطلب: ZSH-MW30TEST-ABC123',
  '',
  'لو البيانات دي مظبوطة، ردّ علينا بـ ✅ ونكمّل التجهيز والشحن.',
  '✏️ ولو حابب تعدّل أي حاجة — الاسم، العنوان، المقاس، أو منتج — قولّنا قبل الشحن وإحنا هنظبّطها.',
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

const WA_BUTTON_RE =
  /^https:\/\/wa\.me\/201012345678\?text=.+$/;

try {
  console.log('Order notifications (Telegram only)');

  await section('[1] a new order sends the customer confirmation text', async () => {
    const message = buildOrderTelegramMessage(ORDER, TRACKING_URL);

    eq(message, EXPECTED_CUSTOMER_MESSAGE, 'exact customer message');
    for (const fragment of [
      'السلام عليكم',
      'بيانات العميل',
      'عنوان الشحن',
      'المنتجات',
      'ملخص الحساب',
      'تتبع الأوردر',
      'رقم الطلب: ZSH-MW30TEST-ABC123',
      'لو البيانات دي مظبوطة',
      'ولو حابب تعدّل أي حاجة',
    ]) {
      ok(message.includes(fragment), `message contains ${fragment}`);
    }
    ok(bytes(message) < 3900, `normal message fits the budget (${bytes(message)} bytes)`);
  });

  await section('[2] optional data is omitted, never rendered as blank lines', async () => {
    const minimal = buildOrderTelegramMessage({
      id: 'ZSH-ONLY-ID',
      customer: '',
      phone: '01012345678',
      city: '',
      items: [],
      subtotal: 0,
      discount: 0,
      total: 0,
    });

    ok(minimal.startsWith('السلام عليكم أ/ عميلنا العزيز'), 'greeting falls back for a missing name');
    ok(!minimal.includes('هاتف بديل'), 'no alt-phone line');
    ok(!minimal.includes('الإيميل'), 'no email line');
    ok(!minimal.includes('ملاحظات'), 'no notes line');
    ok(!minimal.includes('كود الخصم'), 'no coupon line');
    ok(!minimal.includes('قيمة الخصم'), 'no discount line');
    ok(!minimal.includes('تتبع الأوردر'), 'no tracking block without a URL');
    ok(!minimal.includes('• الشحن:'), 'zero shipping is omitted');
    ok(minimal.includes('• المدينة: غير محدد'), 'missing city is explicit');
    ok(minimal.includes('لا توجد منتجات'), 'empty cart is explicit');
    ok(minimal.includes('• الإجمالي: EGP 0'), 'zero total still renders');
  });

  await section('[3] Telegram receives plain text plus an inline keyboard', async () => {
    capture();
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    stubFetch(async () => telegramResponse(200));

    const message = buildOrderTelegramMessage(ORDER, TRACKING_URL);
    const replyMarkup = buildOrderTelegramActions(ORDER, TRACKING_URL);
    eq(await sendTelegramNotification(message, { parseMode: null, replyMarkup }), true, 'send succeeds');

    eq(calls.length, 1, 'exactly one request');
    eq(calls[0].url, `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, 'sendMessage endpoint');
    eq(calls[0].init.method, 'POST', 'POST is used');

    const body = telegramBody();
    eq(body.chat_id, TELEGRAM_CHAT, 'configured chat');
    eq(body.parse_mode, undefined, 'no parse_mode: the copy stays plain text');
    eq(body.text, message, 'message is sent verbatim');
    ok(body.text.includes('• الإيميل: fatima.secret@example.com'), 'email underscore survives');
    ok(body.text.includes('• كود الخصم: EID_250'), 'coupon underscore survives');
    ok(body.text.includes('• رقم الطلب: ZSH-MW30TEST-ABC123'), 'order id hyphens survive');
    eq(body.reply_markup, replyMarkup, 'action buttons travel as reply_markup');
    eq(logs.length, 0, 'success logs nothing');
    eq(warnings.length, 0, 'success warns nothing');
  });

  await section('[4] missing Telegram configuration skips cleanly', async () => {
    capture();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    stubFetch(async () => telegramResponse(200));

    eq(await sendTelegramNotification('hello'), false, 'unconfigured channel returns false');
    eq(calls.length, 0, 'no request is attempted');
    eq(warnings.length, 1, 'exactly one warning');
    ok(warnings[0].includes('TELEGRAM_BOT_TOKEN'), 'warning names the env var');
    ok(!warnings[0].includes('hello'), 'message content is not logged');
  });

  await section('[5] status changes send a short internal line, not the customer text', async () => {
    eq(
      buildOrderStatusMessage(ORDER, 'Shipped'),
      [
        '🚚 ZASHM | تم شحن الطلب',
        '• رقم الطلب: ZSH-MW30TEST-ABC123',
        '• العميل: Fatima Ahmed',
        '• الحالة: تم الشحن',
        '• الإجمالي: EGP 1,615',
      ].join('\n'),
      'exact Shipped line'
    );

    for (const [status, headline] of [
      ['Pending', '🛍️ ZASHM | طلب جديد'],
      ['Confirmed', '🟢 ZASHM | تم تأكيد الطلب'],
      ['Processing', '⚙️ ZASHM | جاري تجهيز الطلب'],
      ['Delivered', '✅ ZASHM | تم توصيل الطلب'],
      ['Cancelled', '🚫 ZASHM | تم إلغاء الطلب'],
      ['Deleted', '🔴 ZASHM | تم حذف الطلب'],
      ['Failed', '⚠️ ZASHM | طلب لم يُحفظ'],
    ]) {
      eq(buildOrderStatusMessage(ORDER, status).split('\n')[0], headline, `${status} headline`);
    }

    const shipped = buildOrderStatusMessage(ORDER, 'Shipped');
    ok(!shipped.includes('السلام عليكم'), 'no customer greeting');
    ok(!shipped.includes('✅ لو البيانات'), 'no confirmation request');
    ok(!shipped.includes('• الهاتف'), 'no phone number in the internal line');
    ok(!shipped.includes('المنتجات'), 'no item list in the internal line');

    const unknown = buildOrderStatusMessage(ORDER, 'Returned');
    ok(unknown.startsWith('📦 ZASHM | تحديث الطلب'), 'unknown status has a neutral headline');
    ok(unknown.includes('• الحالة: Returned'), 'unknown status text is still shown');
    const hostile = buildOrderStatusMessage(ORDER, 'Shipped\n💰 Total EGP 0');
    ok(!hostile.includes('\n💰'), 'a status value cannot forge a line');
  });

  await section('[6] action buttons keep URLs out of the copyable body', async () => {
    const actions = buildOrderTelegramActions(ORDER, TRACKING_URL);
    eq(actions.inline_keyboard.length, 3, 'three button rows');
    eq(actions.inline_keyboard[0].length, 3, 'WhatsApp + tracking + copy share the first row');

    const whatsapp = actions.inline_keyboard[0][0];
    ok(whatsapp.text.includes('واتساب'), 'WhatsApp button is labelled');
    ok(WA_BUTTON_RE.test(whatsapp.url), 'button opens WhatsApp directly with the pre-filled message');
    eq(actions.inline_keyboard[0][1].url, TRACKING_URL, 'tracking button opens the order page');
    ok(actions.inline_keyboard[2][0].url.endsWith('/admin?tab=orders'), 'admin button opens the orders view');

    const noWhatsApp = buildOrderTelegramActions(ORDER, TRACKING_URL, { includeWhatsApp: false });
    eq(noWhatsApp.inline_keyboard[0].length, 1, 'status/delete drop the WhatsApp button');
    eq(noWhatsApp.inline_keyboard[0][0].url, TRACKING_URL, 'tracking button remains');

    const message = buildOrderTelegramMessage(ORDER, TRACKING_URL);
    ok(!message.includes('/admin'), 'no admin URL in the body');
    ok(!message.includes('/api/orders?'), 'no hand-off URL in the body');
    ok(!message.includes('https://wa.me/201012345678'), 'the inline customer wa.me line is removed');

    // Without SESSION_SECRET the redirect cannot be signed: no dead button.
    const secret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    const unsigned = buildOrderTelegramActions(ORDER, TRACKING_URL);
    process.env.SESSION_SECRET = secret;
    ok(!JSON.stringify(unsigned).includes('wa=1'), 'unsigned hand-off button is dropped');
  });

  await section('[7] pathological carts are clamped to the Telegram byte budget', async () => {
    const pathological = buildOrderTelegramMessage({
      id: 'ZSH-BIG-1',
      customer: 'ن'.repeat(400),
      phone: '01012345678',
      city: 'Cairo',
      address: 'ط'.repeat(400),
      items: Array.from({ length: 60 }, (_, index) => ({
        name: `منتج ${index} ${'x'.repeat(80)}`,
        size: 'مقاس',
        color: 'أسود',
        qty: 3,
        price: 3703.5,
      })),
      subtotal: 222210,
      shippingCost: 65,
      discount: 0,
      total: 222275,
    });
    ok(bytes(pathological) > 3900, 'fixture really exceeds the budget');

    capture();
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    stubFetch(async () => telegramResponse(200));
    await sendTelegramNotification(pathological);
    const body = telegramBody();
    ok(bytes(body.text) <= 3900, `wire text stays within 3900 bytes (got ${bytes(body.text)})`);
    ok(!/[\uD800-\uDBFF]$/.test(body.text), 'no dangling surrogate pair');
  });

  await section('[8] a failed order alerts Telegram with whatever data exists', async () => {
    capture();
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    stubFetch(async () => telegramResponse(200));

    const result = await sendOrderFailureAlert(FAILURE);
    eq(result.reference, FAILURE.reference, 'the reference is preserved');
    eq(result.telegram, true, 'Telegram accepted the alert');
    eq(calls.length, 1, 'Telegram is the only channel');

    const body = telegramBody();
    eq(body.parse_mode, undefined, 'failure alert is plain text');
    ok(body.text.includes('الأوردر لم يُحفظ'), 'says the order was not saved');
    ok(body.text.includes('FAILED-20261106-153000-AB12'), 'carries the reference');
    ok(body.text.includes('الاسم: Fatima Ahmed'), 'carries the customer name');
    ok(body.text.includes('الهاتف: 01012345678'), 'carries the phone');
    ok(body.text.includes('العنوان: 12 Nile Street'), 'carries the address');
    ok(body.text.includes('Silk Abaya'), 'carries the known items');
    ok(body.text.includes('الإجمالي: EGP 1,865'), 'carries the server total');
    ok(body.text.includes('تواصل مع العميل يدويًا'), 'tells the owner what to do');
    ok(!body.text.includes('fetch failed'), 'no raw error leaks into Telegram');
    ok(calls[0].init.signal, 'the failure path is time-bounded');

    const degraded = buildOrderFailureMessage({
      reference: newFailureReference(),
      reason: 'product_lookup',
      customer: { name: 'Omar', phone: '01111111111', city: 'Giza', address: '6 Pyramids Road' },
      items: [{ productId: 7, size: 'L', color: 'Red', qty: 2 }],
    });
    ok(degraded.includes('تعذر قراءة بيانات المنتجات'), 'reason is mapped to Arabic');
    ok(degraded.includes('منتج #7'), 'unknown product still has a readable placeholder');
    ok(!degraded.includes('الإجمالي:'), 'no invented total without server prices');
    ok(/^FAILED-\d{14}-[A-F0-9]{4}$/.test(newFailureReference()), 'reference shape');
  });

  await section('[9] Telegram failures never throw or leak customer data', async () => {
    capture();
    process.env.TELEGRAM_BOT_TOKEN = TELEGRAM_TOKEN;
    process.env.TELEGRAM_CHAT_ID = TELEGRAM_CHAT;
    global.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const result = await sendOrderFailureAlert(FAILURE);
    eq(result.telegram, false, 'a transport failure is reported, not thrown');
    const log = logs.join('\n');
    ok(log.includes('TypeError'), 'error type is logged');
    ok(!log.includes('Fatima'), 'name never logged');
    ok(!log.includes('01012345678'), 'phone never logged');
    ok(!log.includes('12 Nile Street'), 'address never logged');
    ok(!log.includes('Silk Abaya'), 'item never logged');
    ok(!log.includes(TELEGRAM_TOKEN), 'bot token never logged');
  });

  await section('[10] Bark is completely removed', async () => {
    const offenders = [];
    for (const file of [
      'api/_lib.js', 'api/orders.js', 'api/admin/orders.js', 'api/admin/products.js',
      'api/admin/users.js', 'api/admin/coupons.js', 'api/admin/upload.js',
      'api/auth.js', 'api/coupons/validate.js', 'package.json',
    ]) {
      const src = read(file);
      if (/bark/i.test(src)) offenders.push(file);
    }
    eq(offenders, [], 'no Bark reference in API code, config or package scripts');

    eq(lib.sendBarkNotification, undefined, 'sendBarkNotification is not exported');
    eq(lib.buildOrderBarkNotification, undefined, 'buildOrderBarkNotification is not exported');
    eq(lib.buildOrderFailureBarkNotification, undefined, 'failure Bark builder is not exported');
    eq(lib.barkOrderNotificationId, undefined, 'Bark id helper is not exported');
    eq(lib.buildOrderClipboardMessage, undefined, 'old clipboard builder is gone');
    eq(lib.buildOrderPlainMessage, undefined, 'old plain builder is gone');
    eq(lib.whatsAppOrderLink, undefined, 'old hand-off helper is gone');

    const pkg = JSON.parse(read('package.json'));
    ok(pkg.scripts.test.includes('test-notifications.mjs'), 'npm test runs this suite');
    ok(!pkg.scripts.test.includes('test-bark-notify'), 'the Bark suite is removed from npm test');
  });

  await section('[11] call sites use the new builders', async () => {
    const orders = read('api/orders.js');
    const admin = read('api/admin/orders.js');

    ok(orders.includes('buildOrderTelegramMessage('), 'placement builds the customer message');
    ok(orders.includes('sendTelegramNotification(message'), 'placement sends it');
    ok(orders.includes('parseMode: null'), 'placement opts into plain text');
    ok(orders.includes('buildOrderTelegramActions('), 'placement attaches action buttons');
    ok(orders.includes('if (!orderStored) await alertFailure'), 'no false alert after a commit');
    ok(orders.includes("alertFailure('product_lookup')"), 'product read failure alerts');
    ok(orders.includes("alertFailure('coupon_lookup')"), 'coupon read failure alerts');
    ok(orders.includes("alertFailure('save_failed')"), 'RPC failure alerts');
    ok(orders.includes("alertFailure('unexpected')"), 'unexpected failure alerts');

    ok(admin.includes('buildOrderStatusMessage('), 'admin sends the short status line');
    ok(admin.includes('buildOrderEditMessage(order, updated)'), 'admin diffs every edit');
    ok(admin.includes('buildOrderTelegramActions('), 'admin attaches action buttons');
    ok(admin.includes('includeWhatsApp: false'), 'admin never offers the customer text');
    ok(/if \(r\.changed !== false\) \{/.test(admin), 'idempotent retries do not re-notify');
    ok(admin.includes("buildOrderStatusMessage(deletedOrder, 'Deleted')"), 'deletion notifies too');
  });

  await section('[12] edit alerts describe exactly what changed', async () => {
    const before = {
      id: 'ZSH-EDIT-1', customer: 'Old Name', phone: '01000000000', phoneAlt: '',
      email: '', address: 'Old address', city: 'Cairo', notes: '', status: 'Pending',
      items: [{ productId: 1, name: 'Tee', size: 'M', color: 'Black', qty: 1, price: 100 }],
      subtotal: 100, discount: 0, discountCode: '', total: 165,
    };
    const after = {
      ...before,
      customer: 'New Name',
      phone: '01123456789',
      address: 'New address 123',
      items: [
        { productId: 1, name: 'Tee', size: 'M', color: 'Black', qty: 2, price: 200 },
        { productId: 2, name: 'Hat', size: '', color: '', qty: 1, price: 150 },
      ],
      subtotal: 350, discount: 20, discountCode: 'SAVE10', total: 395,
    };
    const text = buildOrderEditMessage(before, after);

    ok(text.includes('الاسم: Old Name → New Name'), 'name change is explicit');
    ok(text.includes('الهاتف: 01000000000 → 01123456789'), 'phone change is explicit');
    ok(text.includes('العنوان: Old address → New address 123'), 'address change is explicit');
    ok(text.includes('الكمية: Tee (M / Black) × 1 — EGP 100 → × 2 — EGP 200'),
      'quantity change keeps the size/colour and both line prices');
    ok(text.includes('إضافة: Hat × 1 — EGP 150'),
      'added line keeps the quantity and line price');
    ok(text.includes('الإجمالي قبل: EGP 165'), 'the old total is shown');
    ok(text.includes('الإجمالي بعد: EGP 395'), 'the new total is shown');
    ok(text.includes('الفرق: +EGP 230'), 'the difference is signed');
    ok(text.includes('الكوبون: تمت إضافة SAVE10'), 'a newly added coupon is named');
    ok(!text.includes('السلام عليكم'), 'the customer greeting is never reused');
    ok(!text.includes('http'), 'no URL is placed in the copyable body');

    const removed = buildOrderEditMessage(after, {
      ...after,
      items: [{ productId: 2, name: 'Hat', size: '', color: '', qty: 1, price: 150 }],
      subtotal: 150, discount: 0, discountCode: '', total: 215,
    });
    ok(removed.includes('حذف: Tee (M / Black) × 2 — EGP 200'),
      'a removed line names the product, size and old price');
    ok(removed.includes('الكوبون: تم حذف SAVE10'), 'coupon removal is named');
    ok(removed.includes('الفرق: −EGP 180'), 'a reduction is shown as a negative difference');

    const noop = buildOrderEditMessage(before, { ...before });
    ok(noop.includes('لا توجد تغييرات'), 'a no-op edit says so instead of printing an empty block');
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
