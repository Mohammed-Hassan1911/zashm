/**
 * Group E — final hardening tests.
 *
 *   node scripts/test-final-hardening.mjs
 *
 * Covers:
 *   - SEC-13 Telegram Markdown/CRLF injection is neutralised
 *   - SEC-14 order ids use crypto randomness and a stable format
 *   - SEC-16 tracking REQUIRES a valid tk token (no id-only lookup, no DB hit)
 *   - SEC-18 image sniffing accepts AVIF but rejects MP4 `ftyp`
 *   - SEC-19 every SQL function pins search_path
 *   - SEC-23 admin product errors never echo raw DB messages
 *   - SEC-27 storefront reads products_public; reservedStock is not exposed
 *   - SEC-24 / SEC-28 are documented for a human decision
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

// ─── Fake Supabase (orders only) ────────────────────────────────────────────
const db = { orders: [], queries: [] };

const sb = {
  from(table) {
    return {
      _id: null,
      select() { return this; },
      eq(col, val) { if (col === 'id') this._id = val; return this; },
      async maybeSingle() {
        db.queries.push({ table, id: this._id });
        const row = table === 'orders' ? db.orders.find((o) => String(o.id) === String(this._id)) : null;
        return { data: row ? { ...row } : null, error: null };
      },
    };
  },
};

process.env.SESSION_SECRET = 'test-session-secret-for-final-hardening-tests';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.PUBLIC_BASE_URL;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => sb };
  return originalLoad.call(this, request, parent, isMain);
};
const lib = require('../api/_lib.js');
lib.supabaseAdmin();
const ordersHandler = require('../api/orders.js');
Module._load = originalLoad;

// ─── HTTP fakes ─────────────────────────────────────────────────────────────
let ipCounter = 1;
function makeReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return {
    method,
    query,
    headers: {
      'content-type': 'application/json',
      'x-real-ip': `192.0.2.${(ipCounter++ % 250) + 1}`,
      ...headers,
    },
    socket: { remoteAddress: '192.0.2.1' },
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
async function track(query) {
  const req = makeReq({ query });
  const res = makeRes();
  await ordersHandler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

// ─── [1] Telegram markdown/CRLF injection ───────────────────────────────────
console.log('\n[1] Telegram message sanitisation');
{
  const hostile = 'Alice\n*Total: 0* _urgent_ `x` [link](https://evil)';
  const message = lib.buildOrderTelegramMessage(
    {
      id: 'ZSH-ABC123-DEADBEEF',
      customer: hostile,
      phone: '01012345678',
      phoneAlt: '',
      email: 'a@example.com',
      address: 'Line one\nLine two',
      city: 'Cairo',
      notes: 'note\r\n*FREE*',
      discountCode: null,
      items: [{ name: 'Shirt\n*FREE*', size: 'M', color: 'Red', qty: 1, price: 100 }],
      subtotal: 100,
      discount: 0,
      total: 100,
      shippingCost: 0,
    },
    'https://example.test/?track=ZSH-ABC123-DEADBEEF&tk=abc'
  );

  const nameLine = message.split('\n').find((l) => l.includes('الاسم:'));
  ok(nameLine !== undefined, 'customer line exists');
  ok(!nameLine.includes('*'), 'customer line cannot inject bold markers');
  ok(!nameLine.includes('_'), 'customer line cannot inject italics markers');
  ok(!nameLine.includes('\n'), 'customer value stays on one line');
  ok(nameLine.includes('Alice') && nameLine.includes('Total: 0'), 'content is preserved as plain text');

  const itemLine = message.split('\n').find((l) => l.includes('Shirt'));
  ok(itemLine !== undefined && !itemLine.includes('*'), 'item name cannot inject bold markers');
  ok(!message.includes('*FREE*'), 'no forged markdown survives anywhere');
  ok(!message.includes('\r'), 'no carriage returns survive');

  const longName = 'A'.repeat(600);
  const truncated = lib.buildOrderTelegramMessage(
    { customer: longName, phone: '01012345678', items: [], subtotal: 0, discount: 0, total: 0 },
    'https://example.test'
  );
  const truncatedLine = truncated.split('\n').find((l) => l.includes('الاسم:'));
  ok(truncatedLine.length < 450, 'values are capped at 400 characters');
}

// ─── [2] order id generation ────────────────────────────────────────────────
console.log('\n[2] order id entropy');
{
  const libSrc = read('api/_lib.js');
  ok(/crypto\.randomBytes\(4\)/.test(libSrc), 'server ids use crypto.randomBytes');
  ok(!/=\s*Math\.random\(/.test(libSrc), 'server ids do not use Math.random');

  const clientSrc = read('src/lib/security.js');
  ok(!/=\s*Math\.random\(/.test(clientSrc), 'client id helper no longer uses Math.random');

  const ids = [];
  for (let i = 0; i < 500; i += 1) ids.push(lib.generateOrderId());
  ok(ids.every((id) => /^ZSH-[0-9A-Z]+-[0-9A-F]{8}$/.test(id)), 'all ids match ZSH-<base36>-<8 hex>');
  eq(new Set(ids).size, 500, '500 generated ids are all distinct');
  const sample = lib.generateOrderId();
  ok(/^ZSH-[0-9A-Z]+-[0-9A-F]{8}$/.test(sample), 'sample id format is stable');
}

// ─── [3] image sniffing (AVIF vs MP4) ───────────────────────────────────────
console.log('\n[3] image type detection');
{
  function ftyp(major, compatible = []) {
    const size = 16 + compatible.length * 4;
    const b = Buffer.alloc(size);
    b.writeUInt32BE(size, 0);
    b.write('ftyp', 4, 'ascii');
    b.write(major.padEnd(4, ' ').slice(0, 4), 8, 'ascii');
    b.writeUInt32BE(0, 12);
    compatible.forEach((c, i) => b.write(c.padEnd(4, ' ').slice(0, 4), 16 + i * 4, 'ascii'));
    return b;
  }

  eq(lib.detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg', 'JPEG detected');
  eq(lib.detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png', 'PNG detected');
  eq(lib.detectImageType(Buffer.from('GIF89a....', 'ascii')), 'image/gif', 'GIF detected');
  eq(lib.detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp', 'WEBP detected');

  eq(lib.detectImageType(ftyp('avif')), 'image/avif', 'AVIF major brand accepted');
  eq(lib.detectImageType(ftyp('avis')), 'image/avif', 'AVIF sequence brand accepted');
  eq(lib.detectImageType(ftyp('mif1', ['mif1', 'avif'])), 'image/avif', 'AVIF compatible brand accepted');
  eq(lib.detectImageType(ftyp('isom', ['isom', 'iso2', 'mp41'])), null, 'MP4 ftyp rejected');
  eq(lib.detectImageType(ftyp('M4V ', ['M4V ', 'mp42'])), null, 'M4V ftyp rejected');
  eq(lib.detectImageType(Buffer.from([0x00, 0x01, 0x02])), null, 'short buffer rejected');
}

// ─── [4] tracking requires the token ────────────────────────────────────────
console.log('\n[4] secure order tracking');
{
  const orderId = 'ZSH-MQZUYMH6-DEADBEEF';
  db.orders = [{
    id: orderId,
    status: 'Shipped',
    date: '2026-10-30',
    customer: 'Alice',
    phone: '01012345678',
    phoneAlt: '',
    email: 'alice@example.com',
    address: '1 Street',
    city: 'Cairo',
    notes: 'secret note',
    items: '[]',
    timestamps: '{}',
    subtotal: 100,
    discount: 0,
    total: 100,
  }];

  delete process.env.TRACKING_TOKEN_TTL_HOURS;
  const token = lib.trackToken(orderId);
  ok(/^v1\.\d{1,16}\.[0-9a-f]{32}$/.test(token), 'new tracking token is versioned by default');
  const defaultExpiry = Number(token.split('.')[1]);
  ok(defaultExpiry > Date.now() && defaultExpiry <= Date.now() + 30 * 24 * 60 * 60 * 1000 + 5000,
    'default tracking token lifetime is 30 days');
  ok(lib.verifyTrackToken(orderId, token), 'correct token verifies');
  ok(!lib.verifyTrackToken(orderId, token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))), 'wrong token rejected');
  ok(!lib.verifyTrackToken(orderId, ''), 'empty token rejected');
  ok(!lib.verifyTrackToken('ZSH-OTHER-00000000', token), 'token is bound to the order id');

  const url = lib.trackingUrlFor(orderId);
  ok(url.includes(`track=${encodeURIComponent(orderId)}`), 'tracking URL carries the id');
  ok(lib.verifyTrackToken(orderId, new URL(url).searchParams.get('tk')), 'tracking URL carries a valid token');

  // Configured expiries are honoured, while legacy links remain compatible.
  {
    const legacy = crypto.createHmac('sha256', process.env.SESSION_SECRET)
      .update(`track:${orderId}`).digest('hex').slice(0, 32);
    const before = process.env.TRACKING_TOKEN_TTL_HOURS;
    process.env.TRACKING_TOKEN_TTL_HOURS = '24';
    const expiring = lib.trackToken(orderId);
    ok(/^v1\.\d{1,16}\.[0-9a-f]{32}$/.test(expiring), 'TTL env issues a versioned token');
    const exp = Number(expiring.split('.')[1]);
    ok(exp > Date.now() && exp <= Date.now() + 24 * 60 * 60 * 1000 + 5000, 'versioned token expires in ~24h');
    ok(lib.verifyTrackToken(orderId, expiring), 'versioned token verifies');
    ok(!lib.verifyTrackToken(orderId, expiring.replace(/\.([a-f0-9])/, (m, c) => `.${c === 'a' ? 'b' : 'a'}`)),
      'tampered versioned token rejected');
    ok(lib.verifyTrackToken(orderId, legacy), 'legacy token still verifies while TTL env is set');

    const expired = lib.trackToken(orderId, Date.now() - 1000);
    ok(/^v1\./.test(expired), 'explicit expiry creates a versioned token');
    ok(!lib.verifyTrackToken(orderId, expired), 'expired versioned token rejected');

    if (before === undefined) delete process.env.TRACKING_TOKEN_TTL_HOURS;
    else process.env.TRACKING_TOKEN_TTL_HOURS = before;
  }

  db.queries = [];
  let r = await track({ track: orderId });
  eq(r.status, 200, 'id-only request is a normal 200');
  eq(r.body, { found: false }, 'id-only request returns found:false');
  eq(db.queries.length, 0, 'id-only request never touches the database');

  db.queries = [];
  r = await track({ track: orderId, tk: 'f'.repeat(32) });
  eq(r.body, { found: false }, 'wrong token returns found:false');
  eq(db.queries.length, 0, 'wrong token never touches the database');

  db.queries = [];
  r = await track({ track: 'ZSH-NOT-A-VALID-ID-TOO-LONG', tk: token });
  eq(r.body, { found: false }, 'malformed id returns found:false');
  eq(db.queries.length, 0, 'malformed id never touches the database');

  db.queries = [];
  r = await track({ track: orderId, tk: token });
  eq(r.status, 200, 'valid token returns 200');
  eq(r.body.found, true, 'valid token finds the order');
  eq(r.body.access, 'full', 'valid token gets full access');
  eq(r.body.order.customer, 'Alice', 'full details are returned only with the token');
  eq(r.body.order.notes, 'secret note', 'notes included for the token holder');
  eq(db.queries.length, 1, 'valid token performs exactly one lookup');

  const ordersSrc = read('api/orders.js');
  ok(!/access:\s*'status'/.test(ordersSrc), "the id-only 'status' access path is gone");
  ok(typeof lib.maskOrderForLimitedAccess === 'function', 'mask helper is still exported for compatibility');
  const masked = lib.maskOrderForLimitedAccess({ customer: 'A', phone: '1', address: 'x', id: 'ZSH-1' });
  eq(masked.customer, '', 'mask helper still strips PII');

  const adminSrc = read('src/pages/AdminApp.js');
  ok(!/trackingLinkFor/.test(adminSrc), 'admin UI never fabricates a token-less tracking link');
  const cartSrc = read('src/pages/CartPage.js');
  ok(!/\/\?track=' \+ encodeURIComponent/.test(cartSrc), 'checkout does not fall back to an id-only tracking URL');
}

// ─── [5] SQL search_path ────────────────────────────────────────────────────
console.log('\n[5] SQL function hardening');
{
  const dir = new URL('supabase/', root);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  ok(files.length >= 6, 'migration files are present');

  for (const file of files) {
    // Count definitions only: comment prose such as "a trailing ROLLBACK …
    // cancels every CREATE FUNCTION above" is not a definition and must not be
    // required to pin search_path (nor inflate the pinned count).
    const sql = read(`supabase/${file}`)
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n');
    const functions = (sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/gi) || []).length;
    const pinned = (sql.match(/SET\s+search_path\s*=\s*public\s*,\s*pg_temp/gi) || []).length;
    eq(pinned >= functions, true, `${file}: every function pins search_path (${pinned}/${functions})`);
  }

  const securitySql = read('supabase/security_hardening.sql');
  ok(!/SET search_path = public\s*$/m.test(securitySql), 'security_hardening does not pin only public');
  ok(/FROM pg_trigger t[\s\S]*auth[\s\S]*users/.test(securitySql),
    'all auth.users triggers are inspected before any change');
  ok(/v_provisioning/.test(securitySql) && /Refusing to create on_auth_user_created_secure/.test(securitySql),
    'an existing provisioning trigger blocks a duplicate');
  ok(/pg_get_functiondef/.test(securitySql), 'old trigger functions are documented before replacement');
  ok(!/CREATE OR REPLACE FUNCTION public\.prevent_last_admin_demotion/.test(securitySql),
    'the duplicate last-admin function is removed');
  ok(/admin_protection\.sql/.test(securitySql) && /zshm_protect_last_admin/.test(securitySql),
    'last-admin protection points at the single authoritative file');
}

// ─── [6] generic admin errors ───────────────────────────────────────────────
console.log('\n[6] admin product error messages');
{
  const src = read('api/admin/products.js');
  ok(/error: 'Could not save product'/.test(src), 'create returns a generic error');
  ok(/error: 'Could not update product'/.test(src), 'update returns a generic error');
  ok(/error: 'Could not delete product'/.test(src), 'delete returns a generic error');
  ok(!/return json\(res, status, \{ error: err && err\.message/.test(src), 'raw DB messages are not returned');
  ok(/console\.error\('Product create failed:'/.test(src), 'create failures are still logged server-side');
  ok(/console\.error\('Product update failed:'/.test(src), 'update failures are still logged server-side');
}

// ─── [7] SEC-27 public product view ─────────────────────────────────────────
console.log('\n[7] products_public view');
{
  const sql = read('supabase/products_public_view.sql');
  ok(/REVOKE ALL ON public\.products FROM PUBLIC, anon, authenticated/.test(sql),
    'base table revoked from PUBLIC + browser roles');
  ok(/GRANT SELECT ON public\.products_public TO anon, authenticated/.test(sql), 'view granted to browser roles');
  ok(/v_allow\s+text\[\] := ARRAY\[/.test(sql), 'view is built from an explicit allow-list');
  ok(!/lower\(column_name\) <> 'reservedstock'/.test(sql), 'reservedStock is not merely excluded dynamically');
  ok(/'reservedStock' = ANY \(v_allow\)/.test(sql), 'reservedStock is rejected if ever added to the allow-list');
  ok(/security_invoker = false/.test(sql), 'view runs with owner privileges (required after the revoke)');
  ok(/NOTIFY pgrst, 'reload schema'/.test(sql), 'PostgREST schema cache is reloaded');
  ok(/products_public/.test(sql) && /DROP VIEW IF EXISTS public\.products_public/.test(sql), 'view is recreated safely');
  ok(/products_public_frontend_live/.test(sql), 'phase 3 is gated on the frontend deployment flag');
  ok(/PHASE 3 SKIPPED/.test(sql), 'running the file before deployment skips the revoke');
  ok(/has_table_privilege\('public', 'public\.products', 'SELECT'\)/.test(sql),
    'the post-apply check includes PUBLIC');
  ok(/has_table_privilege\('anon', 'public\.products', 'SELECT'\)/.test(sql),
    'the post-apply check proves anon cannot read the base table');
  ok(/has_table_privilege\('authenticated', 'public\.products', 'SELECT'\)/.test(sql),
    'the post-apply check proves authenticated cannot read the base table');
  ok(/REVOKE SELECT \(%I\) ON TABLE public\.products FROM PUBLIC, anon, authenticated/.test(sql),
    'column-level grants on the base table are revoked too');
  ok(/aclexplode\(a\.attacl\)/.test(sql),
    'the post-apply check detects surviving column-level grants');

  const phase1 = sql.indexOf('PHASE 1');
  const phase3 = sql.indexOf('PHASE 3');
  const revokeBase = sql.indexOf("REVOKE ALL ON public.products FROM PUBLIC");
  ok(phase1 > 0 && phase3 > phase1 && revokeBase > phase3,
    'staged rollout order is preserved: view/grant first, base-table revoke last');

  const store = read('src/store.js');
  const security = read('src/lib/security.js');
  ok(/from\('products_public'\)/.test(store), 'storefront reads products_public');
  ok(/from\('products_public'\)/.test(security), 'security cache reads products_public');
  ok(!/from\('products'\)/.test(store), 'storefront never reads the base table');
  ok(!/from\('products'\)/.test(security), 'security cache never reads the base table');
}

// ─── [8] SEC-24 / SEC-28 documentation ──────────────────────────────────────
console.log('\n[8] production rollout decisions');
{
  const docPath = 'docs/security-production-checklist.md';
  ok(existsSync(new URL(docPath, root)), 'production checklist exists');
  const doc = read(docPath);
  ok(/SEC-24/.test(doc), 'SEC-24 is documented');
  ok(/SEC-28/.test(doc), 'SEC-28 is documented');
  ok(/reservedStock` is intentionally unused/.test(doc), 'reservedStock remains explicitly excluded from availability');
  ok(/Production status: not verified/.test(doc), 'reservedStock production migration status is not assumed');
  ok(/sign ?ups?/i.test(doc) && /disable/i.test(doc), 'signup shutdown is documented');
  ok(/Nothing in this file has been applied/i.test(doc), 'the checklist states nothing was applied');

  const sqlFiles = readdirSync(new URL('supabase/', root)).filter((f) => f.endsWith('.sql'));
  const writerSql = sqlFiles
    .map((f) => read(`supabase/${f}`))
    .filter((s) => /SET\s+"?reservedStock"?\s*=/.test(s));
  eq(writerSql.length, 0, 'no migration invents a reservedStock lifecycle');
}

// ─── [9] floating actions ──────────────────────────────────────────────────
console.log('\n[9] floating actions stay accessible');
{
  const css = read('src/index.css');
  const app = read('src/App.js');
  const backToTop = read('src/components/ui/BackToTop.js');
  const whatsapp = read('src/components/ui/WhatsAppButton.js');

  const floatingBlock = css.slice(css.indexOf('FLOATING ACTIONS'), css.indexOf('.size-guide-overlay'));
  ok(/\.back-to-top,\s*\.whatsapp-fab\s*\{[^}]*position:\s*fixed/.test(floatingBlock),
    'both floating buttons are position: fixed');
  ok(/--floating-action-z:\s*30000/.test(floatingBlock),
    'floating buttons use a z-index above every page layer');
  ok(/z-index:\s*var\(--floating-action-z\)/.test(floatingBlock),
    'the high z-index is actually applied to the buttons');
  ok(/env\(safe-area-inset-bottom/.test(floatingBlock),
    'floating buttons respect the bottom safe area');
  ok(/env\(safe-area-inset-left/.test(floatingBlock) && /env\(safe-area-inset-right/.test(floatingBlock),
    'floating buttons respect the horizontal safe areas');

  ok(!/mobile-whatsapp-obstructed|mobile-back-to-top-obstructed/.test(css + app),
    'no obstruction class can hide the floating buttons');
  ok(!/mobile-keyboard-open\s+\.(whatsapp-fab|back-to-top)/.test(css),
    'the on-screen keyboard never hides the floating buttons');
  ok(!/\.whatsapp-fab\s*\{[^}]*display:\s*none/.test(css) &&
     !/\.back-to-top\s*\{[^}]*display:\s*none/.test(css),
    'CSS never sets display:none on the floating buttons');

  ok(/createPortal\(/.test(whatsapp) && /document\.body/.test(whatsapp),
    'WhatsApp button is portalled to document.body');
  ok(/window\.scrollY > 300/.test(backToTop),
    'scroll-to-top appears after scrolling beyond 300px');
  ok(/<AnimatePresence/.test(backToTop) && /\{visible && \(/.test(backToTop),
    'scroll-to-top fades/slides in and out with visibility');
  ok(/useReducedMotion/.test(backToTop) &&
     /reduceMotion \? 'auto' : 'smooth'/.test(backToTop),
    'scroll-to-top respects reduced motion and scroll behavior');
  ok(/window\.scrollTo\(\{ top: 0, behavior: reduceMotion \? 'auto' : 'smooth' \}\)/.test(backToTop),
    'scroll-to-top returns the page to the top when clicked');
  ok(/className="back-to-top"/.test(backToTop) && /className="whatsapp-fab"/.test(whatsapp),
    'both components use the styled floating classes');
  ok(/aria-label="Scroll back to top"/.test(backToTop) &&
     /aria-label="Chat with ZASHM on WhatsApp"/.test(whatsapp),
    'both floating buttons are accessible');

  ok(/\.back-to-top\s*\{[^}]*width:\s*46px;[^}]*height:\s*46px/.test(floatingBlock) &&
     /\.whatsapp-fab\s*\{[^}]*width:\s*52px;[^}]*height:\s*52px/.test(floatingBlock),
    'desktop floating button sizes are unchanged');
  ok(/@media \(max-width: 768px\)[\s\S]*?\.back-to-top\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/.test(css) &&
     /@media \(max-width: 768px\)[\s\S]*?\.whatsapp-fab\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/.test(css),
    'mobile floating buttons retain 44px touch targets');
  ok(/\.back-to-top svg\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px/.test(css) &&
     /\.whatsapp-fab svg\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/.test(css),
    'mobile floating icons shrink proportionally');
}

// ─── [10] public SEO and empty checkout accessibility ────────────────────────
console.log('\n[10] public SEO and checkout accessibility');
{
  const cartPage = read('src/pages/CartPage.js');
  ok(/<h1[^>]*>Your bag is empty<\/h1>/.test(cartPage),
    'empty checkout state has a semantic page heading');
  ok(/Cash on delivery/.test(cartPage),
    'checkout states the real COD method');
  ok(!/No online payment is taken/.test(cartPage),
    'checkout no longer shows the removed online-payment line');
  ok(/Cash on delivery/.test(cartPage), 'checkout states the COD method in English');
  ok(/className="order-confirmation-card"/.test(cartPage) &&
     /className="order-confirmation-summary"/.test(cartPage),
    'order confirmation uses the redesigned summary layout');
  ok(/className="order-confirmation-page"/.test(cartPage) &&
     /@media \(max-width: 560px\)[\s\S]*?\.order-confirmation-card/.test(read('src/index.css')),
    'order confirmation layout adapts to mobile screens');
  ok(!/تم تسجيل طلبك بنجاح/.test(cartPage) && !/WHAT HAPPENS NEXT/.test(cartPage),
    'order confirmation drops the repeated received-order copy');
  ok((cartPage.match(/style=\{orderActionStyle\}/g) || []).length === 3 &&
     /className="order-confirmation-continue"[\s\S]{0,400}?CONTINUE SHOPPING/.test(cartPage),
    'track, support and continue actions share one identical style');
  const trackPage = read('src/pages/TrackOrder.js');
  ok(/className="track-shipping-grid"/.test(trackPage) &&
     /\.track-shipping-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.7fr\) minmax\(0, 1fr\)/.test(read('src/index.css')) &&
     !/gridTemplateColumns: 'repeat\(auto-fit/.test(trackPage),
    'shipping details stay side by side on phones instead of stacking');

  ok(!/🔍|💬|🛍️/.test(cartPage) &&
     /<PackageSearch[\s\S]{0,200}?TRACK YOUR ORDER/.test(cartPage) &&
     /<Headset[\s\S]{0,200}?CONTACT SUPPORT/.test(cartPage) &&
     /<ShoppingBag[\s\S]{0,200}?CONTINUE SHOPPING/.test(cartPage),
    'order confirmation actions use icon components instead of emoji');

  const store = read('src/store.js');
  ok(/void get\(\)\.refreshProducts\(\)/.test(store) &&
     !/await get\(\)\.refreshProducts\(\)/.test(store.slice(store.indexOf('placeOrder: async'), store.indexOf('updateOrderStatus: async'))),
    'order success is not delayed while refreshing the product catalog');

  const app = read('src/App.js');
  ok(/window\.scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/.test(app) &&
     /prefers-reduced-motion: reduce/.test(app),
    'home/shop navigation returns to top smoothly and respects reduced motion');
  ok(/initial=\{\{ opacity: 0 \}\}[\s\S]*?exit=\{\{ opacity: 0 \}\}[\s\S]*?duration: 0\.38, ease: \[0\.4, 0, 0\.2, 1\]/.test(app),
    'storefront page transitions use a restrained crossfade without vertical jumps');
  const productCard = read('src/components/shop/ProductCard.js');
  ok(/initial=\{\{ opacity: 0 \}\}[\s\S]*?duration: 0\.3,[\s\S]*?delay: Math\.min\(Math\.max\(index, 0\), 5\) \* 0\.015/.test(productCard),
    'product cards use a brief fade with minimal stagger on collection entry');
}

// ─── [11] reload resilience and footer polish ──────────────────────────────
console.log('\n[11] reload resilience and footer polish');
{
  const app = read('src/App.js');
  const entry = read('src/index.js');
  const recovery = read('src/lib/chunkRecovery.js');
  const auth = read('src/lib/auth.js');
  const css = read('src/index.css');

  ok(/vite:preloadError/.test(entry) && /preventDefault\(\)/.test(entry) && /reloadForChunkError/.test(entry),
    'stale Vite preloads are intercepted before the error reaches the UI');
  ok(/RELOAD_KEY[\s\S]*?RELOAD_WINDOW_MS = 10000/.test(recovery) &&
     /Date\.now\(\) - readLastReload\(\) < RELOAD_WINDOW_MS/.test(recovery),
    'chunk reloads are rate-limited so a broken deployment cannot loop');
  ok(/export function lazyWithRetry/.test(recovery) &&
     /await importer\(\)[\s\S]*?await delay\(RETRY_DELAY_MS\)[\s\S]*?await importer\(\)/.test(recovery),
    'lazy routes retry once before falling back to a guarded reload');
  ok(/lazyWithRetry\(/.test(app) && !/React\.lazy\(/.test(app),
    'every storefront lazy route uses the retry wrapper');

  const authInit = auth.slice(auth.indexOf('async function init()'), auth.indexOf('}, [loadUsers])'));
  ok(/void loadUsers\(\)/.test(authInit) && !/await loadUsers\(\)/.test(authInit),
    'auth startup never blocks the storefront on the admin users request');
  ok(/app-startup-stall/.test(app) && /window\.location\.reload\(\)/.test(app.slice(app.indexOf('function AppStartupScreen'), app.indexOf('/* ================= MODAL COMPONENT'))),
    'a stalled startup screen offers a manual reload instead of staying black');

  ok(/\.site-footer a:hover[\s\S]*?transform: scale\(1\.045\)/.test(css) &&
     /\.site-footer \.footer-contact p:hover[\s\S]*?transform: scale\(1\.03\)/.test(css),
    'footer links and contact rows zoom subtly on hover');
  ok(/\.site-footer a\[target='_blank'\]:hover[\s\S]*?transform: scale\(1\.12\)/.test(css),
    'footer social icons zoom from their centre');
  ok(/\.site-footer \.footer-contact p:hover[\s\S]{0,200}?transform: none/.test(css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))),
    'footer hover zoom is disabled for reduced motion');
}

// ─── [12] header/nav badges + governorate suggestions ──────────────────────
console.log('\n[12] badge proximity and governorate copy');
{
  const header = read('src/components/shop/Header.js');
  const mobileNav = read('src/components/shop/MobileNav.js');
  const cartPage = read('src/pages/CartPage.js');
  const productPage = read('src/pages/ProductPage.js');

  // The badge must be positioned against the 20px icon, not the 42px hit area:
  // otherwise it floats ~19px away from the glyph.
  ok(/const iconWrapStyle = \{[\s\S]*?position: 'relative'[\s\S]*?\};/.test(header),
    'header icons have their own positioning box');
  eq((header.match(/style=\{iconWrapStyle\}/g) || []).length, 2,
    'both the wishlist and the bag icon use the icon box');
  ok(/<span style=\{iconWrapStyle\}>\s*<Heart/.test(header),
    'the wishlist badge is anchored to the heart icon');
  ok(/<span style=\{iconWrapStyle\}>\s*<ShoppingBag/.test(header),
    'the bag badge is anchored to the bag icon');
  const badgeStart = header.indexOf('const badgeStyle');
  const badge = header.slice(badgeStart, badgeStart + 400);
  ok(/top: -7,[\s\S]*?right: -7,/.test(badge),
    'header badges sit at the upper-right corner of the glyph');
  ok(!/top: isMobile \? -3 : -2/.test(header) && !/right: isMobile \? -2 : 0/.test(header),
    'the bag badge no longer overrides the shared position');
  eq((header.match(/aria-hidden="true"/g) || []).length, 2,
    'both header badges are decorative for screen readers');
  ok(/aria-label=\{wishlist\?\.length > 0/.test(header),
    'the wishlist button announces its count');
  ok(/cartCount === 1 \? '' : 's'/.test(header),
    'the bag button pluralises its announced count');

  ok(/top: -7, right: -7, minWidth: 15, height: 15/.test(mobileNav),
    'the bottom-nav badge sits at the upper-right corner of the glyph too');
  ok(/aria-label=\{badge > 0 \?/.test(mobileNav),
    'bottom-nav buttons announce their badge count');
  ok(/<span\s+aria-hidden="true"/.test(mobileNav),
    'the decorative sole badge number is hidden from screen readers');

  ok(!/<span lang="ar" dir="rtl">\{GOVERNORATE_AR\[city\]\}<\/span>/.test(cartPage),
    'governorate suggestions show the English name only');
  ok(/clearCanonical/.test(productPage) && /robots: 'noindex, nofollow'/.test(productPage),
    'the unknown-product view is noindex and drops its canonical');
}

console.log('\n[13] admin image upload payload budget');
{
  const uploader = read('src/components/admin/ImageUploader.js');
  const endpoint = read('api/admin/upload.js');

  // Parse the client constants so the budget is checked numerically, not by
  // trusting comments: a JSON body of {file: <dataUrl>} must stay well under
  // both the server limit and the ~4.5MB platform cap.
  const bytes = (name) => {
    const m = uploader.match(new RegExp(`const ${name} = ([0-9.]+(?: \\* [0-9]+)+);`));
    if (!m) return NaN;
    return m[1].split('*').map((part) => Number(part.trim()))
      .reduce((a, b) => a * b, 1);
  };

  eq(bytes('MAX_COMPRESSED_SIZE'), 900 * 1024, 'compressed images target 900KB');
  eq(bytes('DATAURL_LIMIT'), 1.35 * 1024 * 1024, 'the data URL is capped at 1.35MB');
  eq(bytes('MAX_FILE_SIZE'), 15 * 1024 * 1024, 'source files up to 15MB are accepted');

  const bodyBytes = bytes('DATAURL_LIMIT') + 64; // JSON envelope
  ok(bodyBytes < 1.5 * 1024 * 1024,
    `a prepared upload body stays under 1.5MB (${Math.round(bodyBytes / 1024)}KB)`);

  const serverBody = endpoint.match(/const MAX_BODY = (\d+) \* 1024 \* 1024;/);
  ok(serverBody && bodyBytes < Number(serverBody[1]) * 1024 * 1024,
    'the client body fits inside the server MAX_BODY');
  ok(/const MAX_DECODED = (\d+) \* 1024 \* 1024;/.test(endpoint),
    'the server still caps decoded bytes');

  // One upload at a time: parallel multi-megabyte bodies saturate mobile
  // uplinks, and a dropped connection surfaces as a network error.
  ok(/const MAX_PARALLEL_UPLOADS = 1;/.test(uploader),
    'images upload sequentially');
  ok(/const UPLOAD_RETRIES = 1;/.test(uploader),
    'a failed upload is retried once');
  ok(/function isRetryableUploadError\(err\) \{[\s\S]*?status === 0[\s\S]*?status === 408[\s\S]*?status === 504[\s\S]*?\n\}/.test(uploader),
    'the retry covers dropped connections, timeouts and gateway errors');
  ok(/status === 413/.test(uploader) && /too large for the server/.test(uploader),
    'a 413 is reported as a size problem, not a network error');
  ok(/setProgress\(\{ done: 0, total: validFiles\.length \}\)/.test(uploader) &&
     /setProgress\(\{ done: 0, total: 0 \}\)/.test(uploader),
    'upload progress starts and resets with the upload');
  ok(/resized automatically/.test(uploader) && !/Maximum 5MB per image/.test(uploader),
    'the drop zone advertises the real 15MB limit');
}

// ─── [14] private-page robots meta and accessibility landmarks ──────────────
console.log('\n[14] private-page robots meta and accessibility landmarks');
{
  const seo = read('src/lib/seo.js');
  ok(/if \(robots\) \{\s*setNamed\('robots', robots\);\s*\} else \{/.test(seo),
    'setPageMeta rewrites robots to index, follow only when a page omits robots');

  const cart = read('src/pages/CartPage.js');
  for (const title of ['Shopping Bag', 'Checkout', 'Wishlist']) {
    const call = cart.match(new RegExp(`setPageMeta\\(\\{ title: '${title}'[^}]*\\}\\)`));
    ok(call && /robots: 'noindex, nofollow'/.test(call[0]),
      `the ${title} page keeps its own noindex robots meta (matching X-Robots-Tag)`);
  }

  const admin = read('src/pages/AdminApp.js');
  ok(/setPageMeta\(\{ title: 'Admin Panel'[^}]*robots: 'noindex, nofollow'/.test(admin),
    'the admin panel keeps its own noindex robots meta');

  const app = read('src/App.js');
  ok(/<main>\s*<AnimatePresence>/.test(app) && /<\/AnimatePresence>\s*<\/main>/.test(app),
    'storefront page content renders inside a main landmark');
  ok((app.match(/<main>/g) || []).length === 1,
    'the storefront declares exactly one main landmark');
  ok(!/<h4 style=\{titleStyle\}>/.test(app) &&
     (app.match(/<h2 className="footer-col-title">/g) || []).length === 3,
    'footer section titles use h2 so the heading order never skips a level');
  ok(/aria-label="ZASHM on Instagram"/.test(app) && /aria-label="ZASHM on Facebook"/.test(app),
    'footer social icon links expose an accessible name');

  const notFound = read('src/pages/NotFoundPage.js');
  ok(!/<main/.test(notFound),
    'the not-found page does not nest a second main inside the app landmark');

  const productCard = read('src/components/shop/ProductCard.js');
  ok(!/aria-label=\{`View\s/.test(productCard),
    'product cards take their accessible name from their visible content');
  ok(/role="button"\s*\n\s*tabIndex=\{0\}/.test(productCard),
    'product cards stay keyboard reachable after dropping the aria-label override');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
