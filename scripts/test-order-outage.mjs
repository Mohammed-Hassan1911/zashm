/**
 * Checkout during a database outage.
 *
 * The owner's requirement: even if Supabase is down, the Telegram message must
 * still arrive with everything needed to finish the sale by phone. This suite
 * runs the REAL `/api/orders` handler with the Supabase host unreachable and
 * captures what the Telegram API would receive.
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
  items: [{ productId: 1794232720755261, qty: 1, size: 'M', color: 'Black', name: 'Jacket' }],
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
  client: { shippingCost: 65, total: 2565 },
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
    setHeader(key, value) { headers.set(String(key).toLowerCase(), value); },
    getHeader(key) { return headers.get(String(key).toLowerCase()); },
    end(chunk) { if (chunk !== undefined && chunk !== null) this.body = String(chunk); },
  };
}

// ─── the outage: every Supabase call fails like an unreachable project ──────
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

console.log('\n[1] Supabase unreachable: the order fails cleanly, not silently');
let firstAlert = '';
{
  alerts.length = 0;
  telegramMode = 'ok';
  const { status, body } = await place();
  eq(status, 500, 'the API answers 500 instead of pretending the order exists');
  eq(body.success, false, 'success is false');
  eq(body.error, 'Could not load products', 'the customer gets a plain retry message');
  eq(alerts.length, 1, 'exactly one Telegram alert is sent');
  firstAlert = String((alerts[0] && alerts[0].text) || '');
  ok(firstAlert.startsWith('⚠️ ZASHM | تنبيه: الأوردر لم يُحفظ'), 'the alert says the order was NOT saved');
  ok(firstAlert.includes('تعذر قراءة بيانات المنتجات'), 'the reason names the database read');
  ok(!firstAlert.includes('تم استلام'), 'the alert never claims the order was received');
}

console.log('\n[2] the alert carries everything needed to finish the sale by phone');
{
  const text = firstAlert;
  ok(text.includes('• الاسم: Ahmed Hassan'), 'customer name');
  ok(text.includes('• الهاتف: 01012345678'), 'customer phone');
  ok(text.includes('https://wa.me/201012345678'), 'one-tap WhatsApp link');
  ok(text.includes('• المدينة: Dakahlia'), 'governorate');
  ok(text.includes('12 Nile Street, Mansoura'), 'street address');
  ok(text.includes('اتصل قبل التسليم'), 'customer notes');
  ok(text.includes('• Jacket (M / Black) × 1'), 'product name, size, colour and quantity');
  ok(text.includes('• الإجمالي (حسب العميل، غير مؤكد): EGP 2,565'), 'customer-reported total, labelled unverified');
  ok(text.includes('الأوردر لم يصل إلى قاعدة البيانات'), 'the footer tells the owner what to do');
  ok(!text.includes('test-service-role-key-not-real'), 'the service key never reaches the message');
  ok(!text.includes('123456:TEST_TOKEN'), 'the bot token never reaches the message');
}

console.log('\n[3] an invalid cart never pages the owner');
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

console.log('\n[4] Telegram being down cannot change the customer response');
{
  alerts.length = 0;
  telegramAttempts = 0;
  telegramMode = 'down';
  const { status, body } = await place({ ...ORDER, idempotencyKey: 'outage-test-key-0003' }, { ip: '203.0.113.9' });
  eq(status, 500, 'the response is unchanged');
  eq(body.error, 'Could not load products', 'same message, no internal detail');
  eq(telegramAttempts, 2, 'a failed alert is retried exactly once');
  telegramMode = 'ok';
}

console.log('\n[5] a stalled Telegram connection is retried and the alert still arrives');
{
  alerts.length = 0;
  telegramAttempts = 0;
  telegramMode = 'fail-once';
  const { status } = await place({ ...ORDER, idempotencyKey: 'outage-test-key-0004' }, { ip: '203.0.113.10' });
  eq(status, 500, 'the order still fails cleanly');
  eq(telegramAttempts, 2, 'two attempts were made');
  eq(alerts.length, 1, 'the second attempt delivered the alert');
  ok(String(alerts[0].text).includes('• Jacket (M / Black) × 1'), 'the retried alert keeps the full order');
  telegramMode = 'ok';
}

console.log('\n[6] the alert text is safe and bounded');
{
  const text = firstAlert;
  ok(Buffer.byteLength(text, 'utf8') <= 4096, 'stays inside the Telegram byte budget');
  ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), 'no control characters');
  ok(!/\n{3,}/.test(text), 'no runaway blank lines');
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
