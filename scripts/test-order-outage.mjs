/**
 * Checkout during a database outage.
 *
 * Owner decision (2026-11-10): when the database is unreachable the shopper must
 * see NOTHING broken — the checkout confirms the order exactly like a stored one.
 * The only trace is a Telegram alert to the owner that carries the same order
 * body a normal notification would, plus a banner saying the order was not
 * stored and the customer was already told it was.
 *
 * This suite runs the REAL `/api/orders` handler with the Supabase host
 * unreachable and captures what the Telegram API would receive.
 *
 *   node scripts/test-order-outage.mjs
 */
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

// ─── environment (fake, never real credentials) ─────────────────────────────
process.env.SUPABASE_URL = 'https://outage-test.supabase.co';
process.env.REACT_APP_SUPABASE_URL = 'https://outage-test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-not-real';
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN';
process.env.TELEGRAM_CHAT_ID = '99887766';
process.env.SESSION_SECRET = 'test-session-secret-for-outage-suite';
process.env.ALLOWED_ORIGINS = 'https://za-shm.vercel.app';

const ORDER = {
  items: [{
    productId: 1794232720755261,
    qty: 1,
    size: 'M',
    color: 'Black',
    name: 'Jacket',
    unitPrice: 2500,
  }],
  idempotencyKey: 'outage-test-key-0001',
  couponCode: '',
  customer: {
    name: 'Ahmed Hassan',
    phone: '01012345678',
    phoneAlt: '',
    email: 'ahmed@example.com',
    address: '12 Nile Street, Mansoura',
    city: 'Dakahlia',
    notes: 'اتصل قبل التسليم',
  },
  client: { subtotal: 2500, discount: 0, shippingCost: 65, total: 2565 },
};

function makeReq(payload, { ip = '203.0.113.7' } = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(payload))]);
  stream.method = 'POST';
  stream.headers = {
    origin: 'https://za-shm.vercel.app',
    'content-type': 'application/json',
    'x-real-ip': ip,
  };
  stream.query = {};
  stream.socket = { remoteAddress: ip };
  return stream;
}

function makeRes() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: null,
    writes: 0,
    setHeader(key, value) { headers.set(String(key).toLowerCase(), value); },
    getHeader(key) { return headers.get(String(key).toLowerCase()); },
    end(chunk) {
      this.writes += 1;
      if (chunk !== undefined && chunk !== null) this.body = String(chunk);
    },
  };
}

// ─── the outage: every Supabase call fails like an unreachable project ──────
// The client is stubbed at module level instead of relying on the network:
// on Node < 22 supabase-js refuses to construct without native WebSocket, so a
// real client would fail at creation and take the generic catch-all path. The
// stub keeps the test on the same code path the production outage takes
// (product lookup returns an error) on every Node version.
const supabasePath = require.resolve('@supabase/supabase-js');
const offline = () => Promise.resolve({ data: null, error: { message: 'fetch failed', code: 'SUPABASE_DOWN' } });
const offlineQuery = {
  select: () => offlineQuery,
  in: () => offlineQuery,
  eq: () => offlineQuery,
  order: () => offlineQuery,
  limit: () => offlineQuery,
  single: offline,
  maybeSingle: offline,
  abortSignal: () => offlineQuery,
  then: (resolve, reject) => offline().then(resolve, reject),
};
const offlineClient = {
  from: () => offlineQuery,
  rpc: () => offlineQuery,
  storage: { from: () => ({ list: offline, remove: offline }) },
  auth: { getUser: offline },
};
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  children: [],
  paths: [],
  exports: { createClient: () => offlineClient },
};

const alerts = [];
let telegramMode = 'ok';
let telegramAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String((input && input.url) || input);
  if (url.includes('supabase.co')) throw new TypeError('fetch failed');
  if (url.includes('api.telegram.org')) {
    telegramAttempts += 1;
    if (telegramMode === 'down') throw new TypeError('telegram unreachable');
    if (telegramMode === 'fail-once' && telegramAttempts === 1) {
      throw new TypeError('telegram stalled');
    }
    let body = {};
    try { body = JSON.parse(String(init.body || '{}')); } catch { body = {}; }
    alerts.push(body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
    };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const handler = require('../api/orders.js');

async function place(payload = ORDER, options = {}) {
  const req = makeReq(payload, options);
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
}

// Strings a shopper must never see on the confirmation screen.
const BROKEN_MARKERS = [
  'outage', 'Outage', 'database', 'Database', 'Supabase',
  'WhatsApp', 'واتساب', 'خطأ', 'تعذر', 'معطّل', 'بيز',
  'Could not', 'try again', 'not saved', 'لم يُحفظ',
];
function customerSafe(body) {
  const text = JSON.stringify(body);
  return BROKEN_MARKERS.filter((marker) => text.includes(marker));
}

console.log('\n[1] database unreachable: the customer gets a normal confirmation');
let firstAlert = '';
let pendingOrder = null;
{
  alerts.length = 0;
  telegramMode = 'ok';
  const { status, body, res } = await place();
  eq(status, 200, 'the API answers 200, never a 5xx');
  eq(body.success, true, 'success is true');
  eq(body.pending, true, 'the response is flagged pending for the client only');
  eq(res.writes, 1, 'exactly one HTTP response is written');
  ok(/^ZSH-[A-Z0-9]+-[A-F0-9]{8}$/.test(body.order && body.order.id), 'the order has a real ZSH reference');
  eq(body.order.customer, 'Ahmed Hassan', 'the confirmation carries the customer');
  eq(body.order.total, 2565, 'the confirmation carries the total the shopper saw');
  eq(body.order.items[0].name, 'Jacket', 'the confirmation carries the product name');
  eq(body.order.tracking_url, '', 'no tracking link for an order that does not exist');
  eq(customerSafe(body), [], 'no broken/outage string reaches the shopper');
  pendingOrder = body.order;
  eq(alerts.length, 1, 'exactly one Telegram alert is sent');
  firstAlert = String((alerts[0] && alerts[0].text) || '');
}

console.log('\n[2] the owner alert says the database is down and the order was not stored');
{
  ok(firstAlert.startsWith('⚠️ ZASHM | تنبيه: الداتابيز معطّلة والأوردر لم يُسجَّل'), 'banner names the outage');
  ok(firstAlert.includes(`🔖 المرجع: ${pendingOrder.id}`), 'the reference is the same order id the customer saw');
  ok(firstAlert.includes('تعذر قراءة بيانات المنتجات'), 'the reason names the database read');
  ok(firstAlert.includes('❗ العميل شاف رسالة «تم تنفيذ طلبك»'), 'the owner is told the customer was already reassured');
  ok(firstAlert.includes('الأسعار اللي تحت جاية من شاشة العميل'), 'client-sourced amounts are explained');
}

console.log('\n[3] the alert carries the same order body a normal notification would');
{
  const text = firstAlert;
  ok(text.includes('السلام عليكم أ/ Ahmed'), 'customer greeting');
  ok(text.includes('• الاسم: Ahmed Hassan'), 'customer name');
  ok(text.includes('• الهاتف: 01012345678'), 'customer phone');
  ok(text.includes('• المدينة: Dakahlia'), 'governorate');
  ok(text.includes('12 Nile Street, Mansoura'), 'street address');
  ok(text.includes('اتصل قبل التسليم'), 'customer notes');
  ok(text.includes('• Jacket (M / Black) × 1 — EGP 2,500'), 'product, size, colour, quantity and line total');
  ok(text.includes('• المجموع الفرعي: EGP 2,500 (حسب العميل، غير مؤكد)'), 'subtotal, labelled unverified');
  ok(text.includes('• الشحن: EGP 65'), 'shipping is the real server figure, unlabelled');
  ok(text.includes('• الإجمالي: EGP 2,565 (حسب العميل، غير مؤكد)'), 'total, labelled unverified');
  ok(text.includes(`• رقم الطلب: ${pendingOrder.id}`), 'order id');
  ok(!text.includes('test-service-role-key-not-real'), 'the service key never reaches the message');
  ok(!text.includes('123456:TEST_TOKEN'), 'the bot token never reaches the message');
}

console.log('\n[4] the alert buttons work without a stored order');
{
  const markup = alerts[0] && alerts[0].reply_markup;
  ok(markup && Array.isArray(markup.inline_keyboard), 'an inline keyboard is attached');
  const buttons = (markup.inline_keyboard || []).flat();
  const labels = buttons.map((b) => b.text);
  ok(labels.some((t) => t.includes('واتساب للعميل')), 'a WhatsApp button for the customer is present');
  const chat = buttons.find((b) => b.text.includes('واتساب للعميل'));
  ok(chat && String(chat.url).startsWith('https://wa.me/201012345678'), 'it opens the customer number directly');
  ok(labels.some((t) => t.includes('نسخ رقم الطلب')), 'a copy-reference button is present');
  ok(!buttons.some((b) => /\/track\?/.test(String(b.url))), 'no dead tracking link');
}

console.log('\n[5] an invalid cart never pages the owner');
{
  alerts.length = 0;
  const { status, body } = await place({
    ...ORDER,
    idempotencyKey: 'outage-test-key-0002',
    customer: { ...ORDER.customer, phone: '123' },
  }, { ip: '203.0.113.8' });
  eq(status, 422, 'validation still fails fast');
  ok(Array.isArray(body.errors) && body.errors.length > 0, 'the customer sees why');
  eq(alerts.length, 0, 'no Telegram spam for a customer typo');
}

console.log('\n[6] Telegram being down cannot change the customer response');
{
  alerts.length = 0;
  telegramAttempts = 0;
  telegramMode = 'down';
  const { status, body } = await place({ ...ORDER, idempotencyKey: 'outage-test-key-0003' }, { ip: '203.0.113.9' });
  eq(status, 200, 'the confirmation is still a 200');
  eq(body.success, true, 'success is still true');
  eq(body.pending, true, 'still pending');
  eq(telegramAttempts, 2, 'a failed alert is retried exactly once');
  telegramMode = 'ok';
}

console.log('\n[7] a stalled Telegram connection is retried and the alert still arrives');
{
  alerts.length = 0;
  telegramAttempts = 0;
  telegramMode = 'fail-once';
  const { status, body } = await place({ ...ORDER, idempotencyKey: 'outage-test-key-0004' }, { ip: '203.0.113.10' });
  eq(status, 200, 'the order still confirms');
  eq(body.pending, true, 'still pending');
  eq(telegramAttempts, 2, 'two attempts were made');
  eq(alerts.length, 1, 'the second attempt delivered the alert');
  ok(String(alerts[0].text).includes('• Jacket (M / Black) × 1'), 'the retried alert keeps the full order');
  telegramMode = 'ok';
}

console.log('\n[8] the alert text is safe and bounded');
{
  const text = firstAlert;
  ok(Buffer.byteLength(text, 'utf8') <= 4096, 'stays inside the Telegram byte budget');
  ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), 'no control characters');
  ok(!/\n{3,}/.test(text), 'no runaway blank lines');
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
