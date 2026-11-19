/**
 * End-to-end storefront journey in a real browser.
 *
 *   node scripts/test-e2e.mjs
 *
 * Why this exists: every other suite is either static analysis or a handler
 * driven by fakes. Nothing proved that the shipped bundle actually boots,
 * renders the catalogue, opens a product, puts it in the bag and validates
 * checkout. This does, against the production build, in headless Chrome, over
 * the Chrome DevTools Protocol.
 *
 * No new dependency: it drives the browser with the WebSocket that ships with
 * Node 22+, serves build-e2e/ from a tiny static server, and mocks the two
 * network surfaces the storefront touches (the products_public REST read and
 * /api/*). Nothing leaves the machine.
 *
 * A skipped run is only tolerated outside CI: with CI=true (GitHub Actions sets
 * it) a missing browser is a failure, not a pass.
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(root, 'build-e2e');
const APP_PORT = Number(process.env.ZSHM_E2E_PORT || 4173);
const CDP_PORT = Number(process.env.ZSHM_E2E_CDP_PORT || 9333);
const IS_CI = Boolean(process.env.CI);

let pass = 0;
let fail = 0;
function ok(value, label) {
  if (value) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
}
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Two products, one with a size/colour matrix so the add-to-bag path exercises
// the real variant logic. Images are inline SVG so no request leaves the page.
const PIXEL =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="4"><rect width="3" height="4" fill="#1a1a1a"/></svg>');

const PRODUCTS = [
  {
    id: 'e2e-tee',
    name: 'E2E Tee',
    category: 'T-Shirt',
    price: 500,
    originalPrice: 0,
    stock: 5,
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    images: [PIXEL],
    description: 'Fixture product for the end-to-end journey.',
    label: 'New',
    active: true,
    rating: 0,
    reviews: 0,
  },
  {
    id: 'e2e-pant',
    name: 'E2E Pant',
    category: 'Pants',
    price: 900,
    originalPrice: 0,
    stock: 4,
    sizes: [],
    colors: [],
    variantStock: {},
    images: [PIXEL],
    description: 'Second fixture product.',
    label: '',
    active: true,
    rating: 0,
    reviews: 0,
  },
];

// ─── Static server (build-e2e + the two mocked network surfaces) ────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

const requests = { orders: 0, api: 0, catalogue: 0 };

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };

    if (url.pathname === '/rest/v1/products_public') {
      requests.catalogue += 1;
      return send(200, 'application/json', JSON.stringify(PRODUCTS));
    }

    if (url.pathname.startsWith('/api/')) {
      requests.api += 1;
      if (url.pathname === '/api/orders') requests.orders += 1;
      return send(200, 'application/json', '{}');
    }

    let file = path.join(BUILD_DIR, decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) file = path.join(BUILD_DIR, 'index.html');
    const ext = path.extname(file);
    return send(200, MIME[ext] || 'application/octet-stream', readFileSync(file));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(APP_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ─── Minimal CDP client ─────────────────────────────────────────────────────
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) fn(msg.params);
      }
    });
  }

  async open() {
    if (this.ws.readyState === 1) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP socket did not open')), 15000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP socket error')); }, { once: true });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  close() {
    try { this.ws.close(); } catch (e) { /* already closed */ }
  }
}

async function jsonFetch(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // A Playwright/Puppeteer download is not a dependency of this repo, but it is
  // the usual reason a developer machine has no /Applications/Google Chrome.
  // Use it when it is already there instead of asking for an install.
  const homes = [
    path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'),
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
    path.join(process.env.HOME || '', '.cache', 'puppeteer'),
  ];
  for (const home of homes) {
    if (!home || !existsSync(home)) continue;
    for (const found of walk(home, 6)) {
      const base = path.basename(found);
      if (base === 'Google Chrome for Testing' || base === 'chrome' || base === 'headless_shell' || base === 'Chromium') {
        return found;
      }
    }
  }
  return null;
}

// Depth-limited directory walk: returns executable-looking files only.
function walk(dir, depth) {
  if (depth <= 0) return [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, depth - 1));
    else if (/^(Google Chrome for Testing|chrome|headless_shell|Chromium)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ─── Page helpers ───────────────────────────────────────────────────────────
function evaluate(cdp, expression) {
  return cdp
    .send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    .then((result) => {
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            'evaluate threw'
        );
      }
      return result.result?.value;
    });
}

async function waitFor(cdp, expression, label, timeoutMs = 12000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await evaluate(cdp, expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function goto(cdp, route) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}${route}` });
  await waitFor(cdp, 'document.readyState === "complete"', `load ${route}`);
  // React mounts after the module graph loads; wait for a live root.
  await waitFor(cdp, 'document.querySelector("#root") && document.querySelector("#root").children.length > 0', `mount ${route}`);
}

const clickSelector = (selector) =>
  `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`;

// ─── Run ────────────────────────────────────────────────────────────────────
const chrome = await findChrome();

if (typeof WebSocket === 'undefined' || !chrome) {
  const reason = typeof WebSocket === 'undefined'
    ? `Node ${process.version} has no global WebSocket (needs Node 22+)`
    : 'no Chrome/Chromium binary found (set CHROME_PATH)';
  if (IS_CI) {
    console.log(`  FAIL end-to-end browser suite cannot run in CI: ${reason}`);
    process.exit(1);
  }
  console.log(`  SKIP end-to-end browser suite: ${reason}`);
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

console.log(`[1] building the storefront against a local catalogue (${chrome})`);
const build = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', 'build-e2e', '--emptyOutDir'],
  {
    cwd: root,
    stdio: process.env.VERBOSE ? 'inherit' : 'pipe',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${APP_PORT}`,
      VITE_SUPABASE_ANON_KEY: 'e2e-anon-key',
      REACT_APP_SUPABASE_URL: `http://127.0.0.1:${APP_PORT}`,
      REACT_APP_SUPABASE_ANON_KEY: 'e2e-anon-key',
      REACT_APP_GA_ID: '',
    },
  }
);
if (build.status !== 0) {
  console.log('  FAIL production build failed');
  console.log(String(build.stderr || '').slice(-2000));
  process.exit(1);
}
ok(existsSync(path.join(BUILD_DIR, 'index.html')), 'the build produced an index.html');
ok(existsSync(path.join(BUILD_DIR, 'fonts', 'cormorant-garamond-latin-var.woff2')), 'the brand font ships with the build');

const server = await startServer();
const profile = mkdtempSync(path.join(tmpdir(), 'zshm-e2e-'));
const args = [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--mute-audio',
  'about:blank',
];
if (process.platform === 'linux') args.unshift('--no-sandbox');
const browser = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let browserStderr = '';
browser.stderr.on('data', (chunk) => { browserStderr = (browserStderr + chunk).slice(-4000); });

let cdp = null;
const cleanup = () => {
  try { cdp && cdp.close(); } catch (e) { /* ignore */ }
  try { browser.kill('SIGKILL'); } catch (e) { /* ignore */ }
  try { server.close(); } catch (e) { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { rmSync(BUILD_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
};

try {
  console.log('\n[2] boot the shipped bundle');
  let version = null;
  for (let i = 0; i < 100 && !version; i += 1) {
    try {
      version = await jsonFetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch (e) {
      await sleep(200);
    }
  }
  if (!version) throw new Error(`Chrome did not expose CDP.\n${browserStderr}`);
  ok(Boolean(version.webSocketDebuggerUrl), 'Chrome exposes a DevTools endpoint');

  const page = await jsonFetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}`.slice(0, 300));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').trim();
    consoleErrors.push(`console.error: ${text}`.slice(0, 300));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error' && p.entry?.source === 'javascript') {
      consoleErrors.push(`log: ${p.entry.text}`.slice(0, 300));
    }
  });

  console.log('\n[3] home renders the catalogue from products_public');
  await goto(cdp, '/');
  await waitFor(cdp, '!!document.querySelector(".product-card")', 'a product card');
  eq(await evaluate(cdp, 'document.querySelectorAll(".product-card").length'), 2, 'both fixture products render');
  eq(await evaluate(cdp, 'document.querySelector(".hero-brand-word").textContent.trim()'), 'ZASHM', 'the wordmark renders');
  ok(requests.catalogue >= 1, 'the storefront read the public catalogue over REST');
  ok(await evaluate(cdp, 'getComputedStyle(document.body).fontFamily.includes("Montserrat")'), 'the self-hosted body face is applied');
  eq(await evaluate(cdp, 'document.documentElement.scrollWidth <= innerWidth + 1'), true, 'no horizontal overflow at 390px');

  console.log('\n[4] open a product from its card');
  await evaluate(cdp, clickSelector('.product-card'));
  await waitFor(cdp, '!!document.querySelector(".product-title")', 'the product page');
  eq(await evaluate(cdp, 'location.pathname.startsWith("/product/")'), true, 'the route changed to /product/:id');
  eq(await evaluate(cdp, 'document.querySelector(".product-title").textContent.trim()'), 'E2E Tee', 'the right product opened');
  ok(/500/.test(await evaluate(cdp, 'document.querySelector(".product-price").textContent')), 'the price renders');

  console.log('\n[5] add the product to the bag');
  // The page pre-selects the first sellable variation, but the shopper's own
  // tap is what has to work, so pick the colour and the size explicitly.
  await evaluate(cdp, clickSelector('.product-color-option'));
  await waitFor(
    cdp,
    'document.querySelector(\'[data-size-value][aria-label="Selected size: M"]\') !== null',
    'the size tap to register'
  );
  await evaluate(cdp, clickSelector('.product-size-option'));
  await waitFor(
    cdp,
    'document.querySelector(\'[data-size-value][aria-label="Selected size: M"]\') !== null',
    'the chosen size to be shown'
  );
  eq(
    await evaluate(cdp, 'document.querySelector(".add-to-bag-btn").disabled'),
    false,
    'add-to-bag is enabled for an in-stock variation'
  );

  await evaluate(cdp, clickSelector('.add-to-bag-btn'));
  await waitFor(
    cdp,
    '/added to your bag/i.test(document.querySelector(".zashm-toast-message") ? document.querySelector(".zashm-toast-message").textContent : "")',
    'the success toast'
  );
  ok(true, 'adding to the bag shows the success toast');

  // At 390px the desktop header bag is not rendered at all; the bottom nav is
  // the mobile bag button and it names the count it holds.
  const bagLabel = await waitFor(
    cdp,
    `(function(){
       var el = document.querySelector('.mobile-nav-item[aria-label^="Bag"]');
       return el ? el.getAttribute('aria-label') : false;
     })()`,
    'the mobile bag button'
  );
  eq(bagLabel, 'Bag, 1 item', 'the mobile bag badge counts the added item');

  await evaluate(cdp, clickSelector('.mobile-nav-item[aria-label^="Bag"]'));
  await waitFor(cdp, '!!document.querySelector(".cart-drawer")', 'the bag drawer');
  ok(
    /E2E Tee/.test(await evaluate(cdp, 'document.querySelector(".cart-drawer").textContent')),
    'the drawer lists the product that was just added'
  );

  console.log('\n[6] the bag survives a reload and totals correctly');
  await goto(cdp, '/cart');
  await waitFor(cdp, '!!document.querySelector(".bag-line")', 'the bag line items');
  ok(
    /E2E Tee/.test(await evaluate(cdp, 'document.querySelector(".bag-lines").textContent')),
    'the bag persisted across a full page load'
  );
  ok(
    /500/.test(await evaluate(cdp, 'document.querySelector(".bag-summary").textContent')),
    'the bag shows the 500 EGP line total'
  );

  console.log('\n[7] checkout validates before it calls the API');
  await goto(cdp, '/checkout');
  await waitFor(cdp, '!!document.querySelector(".checkout-place-order")', 'the place-order button');
  const ordersBefore = requests.orders;
  await evaluate(cdp, clickSelector('.checkout-place-order'));
  await waitFor(
    cdp,
    'document.querySelectorAll(\'[aria-invalid="true"]\').length > 0',
    'the required-field errors'
  );
  const validation = await evaluate(cdp, `
    (function(){
      var body = document.body.textContent || '';
      return {
        invalid: document.querySelectorAll('[aria-invalid="true"]').length,
        alerts: Array.from(document.querySelectorAll('.checkout-error'))
          .filter(function(e){ return e.textContent.trim(); })
          .map(function(e){ return e.textContent.trim(); }),
        stillOnCheckout: location.pathname === '/checkout',
        mentionsMissing: /required|enter|please|مطلوب/i.test(body),
        payment: (function(){
          var row = document.querySelector('.checkout-payment-option');
          var name = row && row.querySelector('.checkout-payment-name');
          return {
            label: name ? name.textContent.trim() : null,
            radios: document.querySelectorAll('input[name="payment-method"]').length,
            soon: /Coming soon|In a future update/i.test(body)
          };
        })()
      };
    })()
  `);
  ok(validation.invalid > 0, 'the empty checkout marks its required fields invalid');
  ok(validation.alerts.length > 0, 'each missing field gets a visible message');
  ok(validation.mentionsMissing, 'the messages say what is missing');
  eq(validation.stillOnCheckout, true, 'an empty checkout stays on /checkout');
  eq(requests.orders, ordersBefore, 'an invalid form never reaches /api/orders');
  eq(validation.payment.label, 'Cash on Delivery', 'the only payment method is Cash on Delivery');
  eq(validation.payment.radios, 0, 'no selectable payment radios are rendered');
  eq(validation.payment.soon, false, 'no "coming soon" payment placeholder is rendered');

  console.log('\n[8] unknown routes are real 404s');
  await goto(cdp, '/this-route-does-not-exist');
  await waitFor(cdp, '/Page not found/i.test(document.body.textContent)', 'the 404 view');
  ok(true, 'an unknown path renders "Page not found"');

  console.log('\n[9] the session stayed clean');
  const errors = consoleErrors.filter((line) => !/favicon|net::ERR_/i.test(line));
  if (errors.length) console.log(`  console errors: ${JSON.stringify(errors.slice(0, 4), null, 1)}`);
  eq(errors.length, 0, 'no uncaught exceptions or console errors during the journey');
} catch (error) {
  fail += 1;
  console.log(`  FAIL ${error && error.message ? error.message : error}`);
  if (browserStderr) console.log(`  browser stderr (tail): ${browserStderr.slice(-600)}`);
} finally {
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
