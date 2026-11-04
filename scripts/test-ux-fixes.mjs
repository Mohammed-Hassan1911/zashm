// Regression coverage for the UX/performance fixes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM } from 'jsdom';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFileSync(path.join(root, file), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

async function step(name, fn) {
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

function nodeLabel(node) {
  if (!node) return 'null';
  return node.nodeName + (node.id ? `#${node.id}` : '');
}

function assertSameNode(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${nodeLabel(expected)}, got ${nodeLabel(actual)}`);
  }
}

function sourceToRegExp(source) {
  let pattern = '';
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('(.*)', index)) {
      pattern += '.*';
      index += 3;
      continue;
    }
    const wildcard = source.slice(index).match(/^:[A-Za-z0-9_]+\*/);
    if (wildcard) {
      pattern += '.*';
      index += wildcard[0].length - 1;
      continue;
    }
    const char = source[index];
    pattern += /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${pattern}$`);
}

console.log('\n[1] Cache-Control policy');
{
  const config = JSON.parse(read('vercel.json'));
  const checks = [
    { path: '/assets/index-abc123.js', expected: 'immutable' },
    { path: '/assets/index-abc123.css', expected: 'immutable' },
    { path: '/index.html', expected: 'max-age=0' },
  ];
  for (const c of checks) {
    let value = '';
    for (const rule of config.headers || []) {
      if (!sourceToRegExp(rule.source).test(c.path)) continue;
      const h = (rule.headers || []).find((x) => String(x.key).toLowerCase() === 'cache-control');
      if (h) value = h.value;
    }
    await step(`${c.path} → ${c.expected}`, () => {
      assert.ok(value.includes(c.expected), `got "${value}"`);
    });
  }
}

console.log('\n[2] home hero reserves height (CLS)');
{
  const css = read('src/index.css');
  await step('.home-hero has a min height', () => {
    assert.ok(/\.home-hero\s*\{[^}]*height:\s*max\(100svh,\s*580px\)/.test(css));
  });
  await step('.home-hero-skeleton is a flex layout', () => {
    assert.ok(/\.home-hero-skeleton\s*\{[^}]*display:\s*flex/.test(css));
  });
}

console.log('\n[3] cart quantity and remove controls have accessible names');
{
  const cart = read('src/pages/CartPage.js');
  const labels = [
    "aria-label={`Decrease quantity of ${item?.product?.name || 'item'}`}",
    "aria-label={`Increase quantity of ${item?.product?.name || 'item'}`}",
    "aria-label={`Remove ${item?.product?.name || 'item'} from bag`}",
  ];
  for (const label of labels) {
    await step(`button exposes ${label.slice(13, 44)}…`, () => {
      assert.ok(cart.includes(label), `missing ${label}`);
    });
  }
}

const envDir = await mkdtemp(path.join(tmpdir(), 'zashm-ux-test-env-'));
const dom = new JSDOM(
  '<!doctype html><html><body><button id="opener">Shopping bag</button><div id="root"></div><div id="stock-root"></div></body></html>',
  { url: 'http://localhost/' },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.SVGElement = dom.window.SVGElement;
globalThis.Node = dom.window.Node;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.Event = dom.window.Event;
globalThis.AbortController = dom.window.AbortController;
globalThis.AbortSignal = dom.window.AbortSignal;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storeMock = `
  import React from 'react';
  const item = {
    key: 'ux-product-M-Black',
    product: { id: 'ux-product', name: 'Audit Jacket', price: 2500, images: ['/zashm-z-monogram.png'], stock: 5, active: true, variantStock: { 'M-Black': 5 } },
    size: 'M', color: 'Black', qty: 1,
  };
  let state;
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    for (const listener of listeners) listener();
  };
  state = {
    cart: [item],
    cartOpen: false,
    appliedDiscount: null,
    setCartOpen: (open) => set({ cartOpen: open }),
    removeFromCart: () => {},
    updateCartQty: () => ({ success: true }),
    cartTotal: () => 2500,
    setPage: () => {},
    removeAppliedDiscount: () => {},
  };
  function useStore(selector) {
    const sel = typeof selector === 'function' ? selector : (s) => s;
    return React.useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      () => sel(state),
      () => sel(state),
    );
  }
  useStore.setState = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    for (const listener of listeners) listener();
  };
  globalThis.__zashmUxTest = {
    open: () => set({ cartOpen: true }),
    close: () => set({ cartOpen: false }),
  };
  export { useStore };
`;

function mocksPlugin() {
  return {
    name: 'zashm-ux-mocks',
    enforce: 'pre',
    resolveId(source) {
      if (source === '../../store') return '\0virtual:store';
      if (source === '../ui/BackToTop') return '\0virtual:backtotop';
      if (source === 'framer-motion') return '\0virtual:framer';
      return null;
    },
    load(id) {
      if (id === '\0virtual:store') return storeMock;
      if (id === '\0virtual:backtotop') return `export function toast(){}; export default function BackToTop(){return null;}`;
      if (id === '\0virtual:framer') return `
        import React from 'react';
        export const motion = new Proxy({}, { get: (_, tag) => React.forwardRef((props, ref) => React.createElement(String(tag), { ...props, ref })) });
        export function AnimatePresence({ children }) { return children; }
      `;
      return null;
    },
  };
}

let server;
let drawerRoot;
try {
  server = await createServer({
    configFile: false,
    root,
    envDir,
    plugins: [react(), mocksPlugin()],
    esbuild: { loader: 'jsx', include: /src\/.*\.js$/, exclude: [] },
    optimizeDeps: { noDiscovery: true, entries: [] },
    appType: 'custom',
    logLevel: 'error',
    ssr: { noExternal: ['framer-motion'] },
    server: { middlewareMode: true },
  });

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { default: CartDrawer } = await server.ssrLoadModule('/src/components/shop/CartDrawer.js');
  const controls = globalThis.__zashmUxTest;
  drawerRoot = createRoot(document.getElementById('root'));

  await act(async () => drawerRoot.render(React.createElement(CartDrawer)));
  const opener = document.getElementById('opener');
  opener.focus();
  await act(async () => controls.open());
  const dialog = document.querySelector('[role="dialog"]');
  const buttons = () => [...document.querySelectorAll('[role="dialog"] button')];

  console.log('\n[4] cart drawer traps focus, locks scroll and restores focus');

  await step('drawer opens as a modal dialog', () => {
    assert.ok(dialog, 'dialog should be rendered');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-label'), 'Shopping bag');
  });

  await step('focus moves inside the dialog on open', () => {
    assert.ok(dialog.contains(document.activeElement), 'focus must leave the opener');
    assertSameNode(document.activeElement, buttons()[0], 'first control (close) receives focus');
  });

  await step('background scroll is locked while open', () => {
    assert.equal(document.body.style.overflow, 'hidden');
  });

  await step('Tab at the last control wraps to the first', () => {
    const list = buttons();
    list[list.length - 1].focus();
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assertSameNode(document.activeElement, list[0], 'Tab wraps to the first control');
    assert.equal(event.defaultPrevented, true);
  });

  await step('Shift+Tab at the first control wraps to the last', () => {
    const list = buttons();
    list[0].focus();
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assertSameNode(document.activeElement, list[list.length - 1], 'Shift+Tab wraps to the last control');
    assert.equal(event.defaultPrevented, true);
  });

  await step('Tab inside the dialog is left to the browser', () => {
    const list = buttons();
    list[1].focus();
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assertSameNode(document.activeElement, list[1], 'middle Tab stays on the focused control');
  });

  await step('real drawer: hidden trailing button does not break wrap', () => {
    const hidden = document.createElement('button');
    hidden.style.display = 'none';
    hidden.textContent = 'Hidden';
    dialog.appendChild(hidden);
    const btns = buttons().filter((b) => b.style.display !== 'none');
    btns[btns.length - 1].focus();
    const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    hidden.remove();
  });

  await step('closing restores focus to the opener and unlocks scroll', async () => {
    await act(async () => controls.close());
    assert.ok(document.querySelector('[role="dialog"]') === null, 'dialog closes when cartOpen flips false');
    assertSameNode(document.activeElement, opener, 'focus returns to the opener');
    assert.equal(document.body.style.overflow, '');
  });

  await step('Escape closes and restores focus', async () => {
    opener.focus();
    await act(async () => controls.open());
    assert.ok(document.querySelector('[role="dialog"]'));
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => document.dispatchEvent(event));
    assert.ok(document.querySelector('[role="dialog"]') === null, 'dialog closes when cartOpen flips false');
    assertSameNode(document.activeElement, opener, 'focus returns to the opener');
    assert.equal(document.body.style.overflow, '');
  });

  console.log('\n[4b] focus trap edge cases');
  {
    const ft = await server.ssrLoadModule('/src/lib/focus-trap.js');
    const { getFocusableElements, trapTabKey, focusFirstElement, redirectOutsideFocus } = ft;

    function makeContainer(html) {
      const container = document.createElement('div');
      container.setAttribute('tabindex', '-1');
      container.innerHTML = html;
      document.body.appendChild(container);
      return container;
    }
    function cleanup(container) { container.remove(); }

    await step('single focusable: Tab wraps to itself', () => {
      const c = makeContainer('<button id="only">Only</button>');
      const btn = c.querySelector('#only');
      btn.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, btn);
      cleanup(c);
    });

    await step('single focusable: Shift+Tab wraps to itself', () => {
      const c = makeContainer('<button id="only">Only</button>');
      const btn = c.querySelector('#only');
      btn.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, btn);
      cleanup(c);
    });

    await step('no focusable elements: focus moves to container', () => {
      const c = makeContainer('<p>text</p>');
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, c);
      cleanup(c);
    });

    await step('no focusable: Shift+Tab lands on container', () => {
      const c = makeContainer('<p>text</p>');
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, c);
      cleanup(c);
    });

    await step('middle element: Tab left to browser', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button><button id="cc">C</button>');
      const b = c.querySelector('#b');
      b.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, false);
      assert.equal(ev.defaultPrevented, false);
      cleanup(c);
    });

    await step('middle element: Shift+Tab left to browser', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button><button id="cc">C</button>');
      const b = c.querySelector('#b');
      b.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, false);
      assert.equal(ev.defaultPrevented, false);
      cleanup(c);
    });

    await step('first element: Shift+Tab wraps to last', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button><button id="cc">C</button>');
      const a = c.querySelector('#a');
      const last = c.querySelector('#cc');
      a.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, last);
      cleanup(c);
    });

    await step('last element: Tab wraps to first', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button><button id="cc">C</button>');
      const a = c.querySelector('#a');
      const last = c.querySelector('#cc');
      last.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, a);
      cleanup(c);
    });

    await step('disabled buttons excluded', () => {
      const c = makeContainer('<button id="a">A</button><button id="b" disabled>B</button><button id="cc">C</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 2);
      assert.ok(!list.some((el) => el.id === 'b'));
      cleanup(c);
    });

    await step('hidden attribute excluded', () => {
      const c = makeContainer('<button id="a">A</button><button id="b" hidden>B</button><button id="cc">C</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 2);
      assert.ok(!list.some((el) => el.id === 'b'));
      cleanup(c);
    });

    await step('display:none ancestor excluded', () => {
      const c = makeContainer('<div style="display:none"><button id="hidden">H</button></div><button id="visible">V</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'visible');
      cleanup(c);
    });

    await step('visibility:hidden ancestor excluded', () => {
      const c = makeContainer('<div style="visibility:hidden"><button id="hidden">H</button></div><button id="visible">V</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'visible');
      cleanup(c);
    });

    await step('inert ancestor excluded', () => {
      const c = makeContainer('<div inert><button id="hidden">H</button></div><button id="visible">V</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'visible');
      cleanup(c);
    });

    await step('disabled fieldset excluded', () => {
      const c = makeContainer('<fieldset disabled><button id="hidden">H</button></fieldset><button id="visible">V</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'visible');
      cleanup(c);
    });

    await step('aria-hidden ancestor excluded', () => {
      const c = makeContainer('<div aria-hidden="true"><button id="hidden">H</button></div><button id="visible">V</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'visible');
      cleanup(c);
    });

    await step('tabindex -1 excluded', () => {
      const c = makeContainer('<button id="a" tabindex="-1">A</button><button id="b">B</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'b');
      cleanup(c);
    });

    await step('contenteditable included', () => {
      const c = makeContainer('<div contenteditable="true" id="ce">editable</div><button id="b">B</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 2);
      cleanup(c);
    });

    await step('focus outside dialog redirected to first', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button>');
      const outside = document.createElement('button');
      outside.id = 'outside';
      document.body.appendChild(outside);
      outside.focus();
      const ev = { target: outside };
      const redirected = redirectOutsideFocus(ev, c);
      assert.equal(redirected, true);
      assertSameNode(document.activeElement, c.querySelector('#a'));
      outside.remove();
      cleanup(c);
    });

    await step('focus on non-listed inner node: Tab resolves forward', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button>');
      c.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, c.querySelector('#a'));
      cleanup(c);
    });

    await step('focusFirstElement: first control or container', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button>');
      const ok = focusFirstElement(c);
      assert.equal(ok, true);
      assertSameNode(document.activeElement, c.querySelector('#a'));
      cleanup(c);

      const empty = makeContainer('<p>none</p>');
      empty.setAttribute('tabindex', '-1');
      focusFirstElement(empty);
      assertSameNode(document.activeElement, empty);
      cleanup(empty);
    });

    await step('hidden trailing button does not break wrap', () => {
      const c = makeContainer('<button id="a">A</button><button id="b">B</button><button id="hidden" style="display:none">H</button>');
      const list = getFocusableElements(c);
      assert.equal(list.length, 2);
      const last = list[list.length - 1];
      last.focus();
      const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      const handled = trapTabKey(ev, c);
      assert.equal(handled, true);
      assert.equal(ev.defaultPrevented, true);
      assertSameNode(document.activeElement, list[0]);
      cleanup(c);
    });
  }

  console.log('\n[5] stock rejection is explained on the empty-bag screen');
  {
    const cartPage = read('src/pages/CartPage.js');
    const start = cartPage.indexOf('  if (safeCart.length === 0) {');
    assert.ok(start >= 0, 'empty branch not found');
    const end = cartPage.indexOf('  return (\n    <div style={{ paddingTop: 90', start);
    assert.ok(end > start, 'checkout layout not found after the empty branch');
    const branch = cartPage.slice(start, end);
    await step('empty state keeps the reason visible', () => {
      assert.ok(branch.includes('<StockFeedback'), 'empty state must keep the reason visible');
    });

    const { default: StockFeedback } = await server.ssrLoadModule('/src/components/shop/StockFeedback.js');
    const stockRoot = createRoot(document.getElementById('stock-root'));
    const notice = [
      '"Audit Jacket" was automatically removed from your bag because it\'s out of stock.',
    ];
    const errors = ['A product in your cart is no longer available.'];

    await act(async () => stockRoot.render(React.createElement(StockFeedback, { notice, errors })));
    await step('removal notice and rejection reason are both visible', () => {
      const status = document.querySelector('#stock-root [role="status"]');
      const alert = document.querySelector('#stock-root [role="alert"]');
      assert.ok(status, 'removal notice (status) must render');
      assert.ok(alert, 'stock rejection (alert) must render');
      assert.ok(status.textContent.includes('out of stock'), 'removal reason');
      assert.ok(alert.textContent.includes('no longer available'), 'rejection reason');
    });
  }
  console.log('\n[6] QA fixes: declared-stock inputs, COD disclosure and CLS skeletons');
  {
    const admin = read('src/pages/AdminApp.js');
    await step('admin recomputes Total Stock on every option change', () => {
      assert.ok(/normalizeOptionLabel|parseOptionList/.test(admin), 'option parsing helpers exist');
      assert.ok(/duplicateOptionLabels/.test(admin), 'duplicate option detection exists');
      assert.ok(/orphanBaselineRef/.test(admin) && /restoreAck/.test(admin) && /Confirm restoring these units/.test(admin),
        're-adding a removed option requires explicit confirmation before restoring orphan stock');
      assert.ok(/setForm\([\s\S]{0,400}sizes|sizes:[\s\S]{0,300}colors/.test(admin),
        'size/colour edits update the form');
      assert.ok(/totalFor\(|declaredVariantStockTotal/.test(admin), 'total uses the shared declared-combination helper');
    });

    const cart = read('src/pages/CartPage.js');
    await step('COD disclosure renders between the total and PLACE ORDER', () => {
      const totalAt = cart.indexOf('EGP {(finalTotal');
      const codAt = cart.indexOf('Cash on Delivery');
      const placeAt = cart.indexOf('PLACE ORDER');
      assert.ok(totalAt >= 0 && codAt > totalAt && placeAt > codAt,
        'payment selector must sit after the total and before PLACE ORDER');
      assert.ok(/Cash on Delivery/.test(cart), 'English COD label is present');
      assert.ok(/Pay in cash when your order arrives/.test(cart), 'payment-on-arrival explanation is present');
      assert.ok(/Coming soon/.test(cart), 'card option is advertised as coming soon');
    });

    const app = read('src/App.js');
    const css = read('src/index.css');
    await step('route skeletons reserve the final layout while chunks load', () => {
      assert.ok(/from '\.\/components\/ui\/PageSkeletons'/.test(app), 'App imports the route skeletons');
      assert.ok(/page === 'shop'\) return <ShopPageSkeleton/.test(app), 'shop route uses its skeleton');
      assert.ok(/page === 'product'\) return <ProductPageSkeleton/.test(app), 'product route uses its skeleton');
      assert.ok(/PageReadySignal/.test(app) && /firstPageReady && <Footer/.test(app),
        'the footer waits for the first real page commit');
      assert.ok(/\.page-skeleton\s*\{[\s\S]{0,160}min-height:\s*100svh/.test(css),
        'skeletons reserve one viewport');
      assert.ok(/\.page-skeleton-card-image\s*\{[\s\S]{0,120}aspect-ratio:\s*3\s*\/\s*4/.test(css),
        'skeleton cards use the real 3:4 image box');
    });

    const product = read('src/pages/ProductPage.js');
    await step('product page shows the skeleton while the catalogue is loading', () => {
      assert.ok(/productPending/.test(product), 'pending state is explicit');
      assert.ok(/ProductPageSkeleton/.test(product), 'the skeleton is rendered while pending');
      assert.ok(/productsLoadStatus === 'idle'|productsLoadStatus === 'loading'/.test(product),
        'only a settled load can produce "Product not found"');
    });
  }
} catch (error) {
  console.error('Fatal test harness error:', error);
  failed += 1;
  failures.push(`fatal: ${error && error.message ? error.message : error}`);
} finally {
  if (server) await server.close();
  try { await rm(envDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
