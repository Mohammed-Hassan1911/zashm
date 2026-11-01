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

  const token = lib.trackToken(orderId);
  ok(/^[0-9a-f]{32}$/.test(token), 'tracking token is 32 hex chars');
  ok(lib.verifyTrackToken(orderId, token), 'correct token verifies');
  ok(!lib.verifyTrackToken(orderId, token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))), 'wrong token rejected');
  ok(!lib.verifyTrackToken(orderId, ''), 'empty token rejected');
  ok(!lib.verifyTrackToken('ZSH-OTHER-00000000', token), 'token is bound to the order id');

  const url = lib.trackingUrlFor(orderId);
  ok(url.includes(`track=${encodeURIComponent(orderId)}`), 'tracking URL carries the id');
  ok(url.includes(`tk=${token}`), 'tracking URL carries the token');

  // Optional expiring tokens (TRACKING_TOKEN_TTL_HOURS). Legacy links must keep
  // working, and an explicit expiry must be honoured.
  {
    const before = process.env.TRACKING_TOKEN_TTL_HOURS;
    process.env.TRACKING_TOKEN_TTL_HOURS = '24';
    const expiring = lib.trackToken(orderId);
    ok(/^v1\.\d{1,16}\.[0-9a-f]{32}$/.test(expiring), 'TTL env issues a versioned token');
    const exp = Number(expiring.split('.')[1]);
    ok(exp > Date.now() && exp <= Date.now() + 24 * 60 * 60 * 1000 + 5000, 'versioned token expires in ~24h');
    ok(lib.verifyTrackToken(orderId, expiring), 'versioned token verifies');
    ok(!lib.verifyTrackToken(orderId, expiring.replace(/\.([a-f0-9])/, (m, c) => `.${c === 'a' ? 'b' : 'a'}`)),
      'tampered versioned token rejected');
    ok(lib.verifyTrackToken(orderId, token), 'legacy token still verifies while TTL env is set');

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
    const sql = read(`supabase/${file}`);
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
console.log('\n[8] outstanding production decisions');
{
  const docPath = 'docs/security-production-checklist.md';
  ok(existsSync(new URL(docPath, root)), 'production checklist exists');
  const doc = read(docPath);
  ok(/SEC-24/.test(doc), 'SEC-24 is documented');
  ok(/SEC-28/.test(doc), 'SEC-28 is documented');
  ok(/DECISION REQUIRED/i.test(doc), 'reservedStock needs an explicit schema decision');
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
