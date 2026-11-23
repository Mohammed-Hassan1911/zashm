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
  '<!doctype html><html><body><button id="opener">Shopping bag</button><div id="root"></div><div id="stock-root"></div><div id="toast-root"></div></body></html>',
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
        export function useReducedMotion() { return true; }
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

    await step('a server outage is not mislabelled as a stock problem', () => {
      assert.ok(/<StockFeedback[^>]*title=\{orderOutage \?/.test(cartPage),
        'CartPage passes an outage-specific heading');
    });
    await act(async () => stockRoot.render(React.createElement(StockFeedback, {
      errors: ['Could not load products'],
      title: 'Couldn’t place the order:',
    })));
    await step('the outage heading replaces the stock heading', () => {
      const alert = document.querySelector('#stock-root [role="alert"]');
      assert.ok(alert, 'error alert renders');
      assert.ok(alert.textContent.includes('Couldn’t place the order:'), 'outage heading is shown');
      assert.ok(!alert.textContent.includes('Stock availability issue'), 'stock heading is not shown');
    });
    await act(async () => stockRoot.unmount());
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
      assert.ok(/Pay in cash when it arrives\./.test(cart), 'payment-on-arrival explanation is present');
      assert.ok(!/Coming soon|In a future update|Credit \/ Debit Card/.test(cart),
        'no disabled "coming soon" payment placeholder is rendered');
      assert.ok(!/value="card"/.test(cart), 'the card method is gone, not merely hidden');
    });

    await step('checkout keeps its original element placement', () => {
      const deliveryAt = cart.indexOf('checkout-delivery-title');
      const summaryAt = cart.indexOf('checkout-summary-title');
      const itemsAt = cart.indexOf('checkout-item-list');
      const discountAt = cart.indexOf('checkout-coupon-title');
      const totalsAt = cart.indexOf('checkout-summary-totals');
      const paymentAt = cart.indexOf('checkout-payment-title');
      const submitAt = cart.indexOf('checkout-side-submit');
      assert.ok(deliveryAt >= 0 && summaryAt > deliveryAt,
        'the delivery form comes first, then the summary');
      assert.ok(itemsAt > summaryAt && discountAt > itemsAt && totalsAt > discountAt
        && paymentAt > totalsAt && submitAt > paymentAt,
        'the summary keeps pieces, discount, total, payment, CTA in the original order');
      assert.ok(!/checkout-money/.test(cart) && !/checkout-side-items/.test(cart),
        'the split summary cards are gone: one Order Summary card holds them all');
      assert.ok(/<aside className="checkout-card checkout-summary"/.test(cart),
        'the whole summary is a single card');
    });

    const checkoutCssSource = read('src/index.css');
    const checkoutCss = checkoutCssSource.slice(
      checkoutCssSource.indexOf('/* ─── CHECKOUT'),
      checkoutCssSource.indexOf('/* ─── ORDER CONFIRMATION')
    );
    await step('checkout stacks on phones exactly like the original', () => {
      assert.ok(/@media \(max-width: 768px\) \{[\s\S]*?\.checkout-grid \{\s*grid-template-columns:\s*minmax\(0, 1fr\)/.test(checkoutCss),
        'phones use one full-width column');
      assert.ok(!/\.checkout-money/.test(checkoutCss) && !/\.checkout-side-items/.test(checkoutCss),
        'no interleaving wrapper survives in the stylesheet');
      assert.ok(/@media \(min-width: 769px\) \{\s*\.checkout-summary \{ position: sticky; top: 100px; \}/.test(checkoutCss),
        'the summary sticks beside the form on desktop only');
    });

    await step('checkout does not repeat the exchange promise', () => {
      assert.ok(!/checkout-exchange-note/.test(cart),
        'the exchange note is gone from the checkout view');
      assert.ok(!/Exchange or return within/.test(cart),
        'checkout no longer restates the return window under PLACE ORDER');
      assert.ok(!/Size not right\?/.test(cart), 'the doubt line is gone too');
      assert.ok(!/checkout-exchange-note/.test(read('src/index.css')),
        'its now-unused responsive rule was removed as well');
    });

    await step('the product page still states the exchange window once', () => {
      const productSource = read('src/pages/ProductPage.js');
      assert.ok(/7-Day Exchanges &amp; Returns/.test(productSource),
        'the product page keeps the exchange promise where the shopper decides');
      assert.ok(/Exchange or return within 7 days of delivery/.test(productSource),
        'the window and the condition are still spelled out');
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

    await step('the selected size sits in the same pill as the Size Guide', () => {
      assert.ok(/data-size-value="true"/.test(product), 'the selected size has its own pill');
      assert.ok(/sizePillStyle/.test(product), 'both pills share one style object');
      assert.ok(/\[data-size-guide\],\s*\n\s*\[data-size-value\]/.test(css),
        'both pills shrink together at small widths');
      assert.ok(/\{'Color'\}\{' '\}/.test(product), 'the colour label reads as two words when copied');
      assert.ok(product.indexOf('className="product-stock') < product.indexOf('className="product-buy-row'),
        'the stock reassurance sits above the buy row');
      assert.ok(/\.product-stock \{[^}]*margin: 0 0 12px;/.test(css),
        'the badge hugs the buy row above it');
    });
  }

  console.log('\n[7] a failed Place Order names the wrong field and its reason');
  {
    const { CHECKOUT_FIELDS, buildCheckoutErrorNotice, focusCheckoutField } =
      await server.ssrLoadModule('/src/lib/checkoutErrors.mjs');

    await step('fields are listed in the visual order of the form', () => {
      assert.deepEqual(CHECKOUT_FIELDS.map((f) => f.key),
        ['name', 'phone', 'phoneAlt', 'email', 'address', 'city']);
      assert.deepEqual(CHECKOUT_FIELDS.map((f) => f.id),
        ['checkout-name', 'checkout-phone', 'checkout-phone-alt', 'checkout-email',
          'checkout-address', 'checkout-governorate'],
        'each field points at the real input id');
    });

    await step('one wrong field is named with its own message', () => {
      const notice = buildCheckoutErrorNotice({
        phone: 'Invalid phone number. Must be 11 digits starting with 01.',
      });
      assert.deepEqual(notice, {
        message: 'Phone Number: Invalid phone number. Must be 11 digits starting with 01.',
        field: 'phone',
        label: 'Phone Number',
        id: 'checkout-phone',
        alsoCheck: [],
      });
    });

    await step('several wrong fields point at the first one and list the rest', () => {
      const notice = buildCheckoutErrorNotice({
        city: 'Please select your governorate from the list.',
        name: 'Full name is required.',
        address: 'Street address is required.',
      });
      assert.equal(notice.field, 'name', 'first field on the page leads');
      assert.equal(notice.id, 'checkout-name');
      assert.equal(notice.message,
        'Full Name: Full name is required.\nAlso check: Street Address, Governorate.');
      assert.deepEqual(notice.alsoCheck, ['Street Address', 'Governorate']);
    });

    await step('an empty or cleared form produces no notice', () => {
      assert.equal(buildCheckoutErrorNotice({}), null);
      assert.equal(buildCheckoutErrorNotice(null), null);
      assert.equal(buildCheckoutErrorNotice({ name: '   ', city: null }), null,
        'blank messages are ignored');
    });

    await step('focus moves to the named field even after scrolling', () => {
      const input = document.createElement('input');
      input.id = 'checkout-phone';
      document.body.appendChild(input);
      let scrolled = null;
      let focusOptions = null;
      input.scrollIntoView = (options) => { scrolled = options; };
      const baseFocus = input.focus.bind(input);
      input.focus = (options) => { focusOptions = options; baseFocus(); };

      assert.equal(focusCheckoutField('checkout-phone'), true);
      assert.equal(document.activeElement, input, 'the wrong field is focused');
      assert.equal(focusOptions && focusOptions.preventScroll, true,
        'focus must not undo the scroll');
      assert.equal(scrolled && scrolled.block, 'center', 'the field is brought into view');
      input.remove();
      assert.equal(focusCheckoutField('checkout-missing'), false, 'missing ids fail safely');
      assert.equal(focusCheckoutField(''), false, 'an empty id fails safely');
    });

    const cart = read('src/pages/CartPage.js');
    await step('the form shows the notice, keeps inline errors and cannot be locked by a typo', () => {
      const validationAt = cart.indexOf('const errs = validateOrderFormCustom(form);');
      const noticeAt = cart.indexOf('buildCheckoutErrorNotice(errs)');
      const toastAt = cart.indexOf("toast(notice.message, 'error')");
      const focusAt = cart.indexOf('focusCheckoutField(notice.id)');
      const lockAt = cart.indexOf('isPlacingOrder.current = true', validationAt);
      assert.ok(validationAt >= 0, 'validation runs in handleOrder');
      assert.ok(noticeAt > validationAt, 'the notice is built from the same errors');
      assert.ok(toastAt > noticeAt, 'the notice is shown as an error toast');
      assert.ok(focusAt > toastAt, 'the shopper is taken to the wrong field');
      assert.ok(lockAt > focusAt, 'the submit lock is only taken after validation passes');
      assert.ok(cart.includes('setErrors(errs)'), 'inline per-field errors are preserved');
      assert.ok(cart.includes("aria-describedby={errors.name ? 'checkout-name-error'"),
        'inline errors stay linked to their inputs');
    });

    const backToTop = await server.ssrLoadModule('/src/components/ui/BackToTop.js');
    const toastRoot = createRoot(document.getElementById('toast-root'));
    const notice = buildCheckoutErrorNotice({
      phone: 'Invalid phone number. Must be 11 digits starting with 01.',
      city: 'Please select your governorate from the list.',
    });
    await act(async () => toastRoot.render(React.createElement(backToTop.Toaster)));
    await act(async () => { backToTop.toast(notice.message, 'error'); });

    await step('the toast renders the two-line notice as an alert', () => {
      const alert = document.querySelector('.zashm-toast[role="alert"]');
      assert.ok(alert, 'the error toast renders with role="alert"');
      const text = alert.textContent.replace(/\s+/g, ' ').trim();
      assert.ok(text.includes('Phone Number: Invalid phone number.'), `field + reason, got "${text}"`);
      assert.ok(text.includes('Also check: Governorate.'), `other fields are listed, got "${text}"`);
    });

    await act(async () => toastRoot.unmount());
  }

  console.log('\n[8] mobile admin zoom, WhatsApp review phone and one-line add to bag');
  {
    const css = read('src/index.css');
    const admin = read('src/pages/AdminApp.js');
    const login = read('src/components/admin/AdminLogin.js');
    const product = read('src/pages/ProductPage.js');

    await step('the admin phone opens a WhatsApp chat in a new tab', () => {
      assert.ok(admin.includes('https://wa.me/'), 'the review phone links to wa.me');
      assert.ok(admin.includes(".replace(/^0/, '20')"), 'the local 0 is swapped for the 20 country code');
      assert.ok(admin.includes('target="_blank"') && admin.includes('rel="noopener noreferrer"'),
        'the chat opens safely in a new tab');
      assert.ok(!admin.includes('href={`tel:'), 'no stale tel: link remains');
    });

    await step('the repeat-order discount message is Arabic', () => {
      assert.ok(admin.includes('شكرًا لثقتك في ZASHM'), 'the WhatsApp prefill is Arabic');
      assert.ok(admin.includes('كود خصم خاص بيك'), 'the personal discount code is offered');
      assert.ok(admin.includes('ZASHM 🎁'), 'a clearly visible emoji follows the brand name');
      assert.ok(!admin.includes('Thank you for your trust in ZASHM'), 'the old English copy is gone');
    });

    await step('new reviews raise a numeric badge in the admin', () => {
      assert.ok(/id:'reviews'[^\n]*badge:'reviews'/.test(admin), 'the sidebar entry carries a badge');
      assert.ok(admin.includes('/admin/reviews?status=pending&limit=1'),
        'the number is the pending count from the database');
      assert.ok(admin.includes('onCountsChange={setPendingReviews}'),
        'approving or rejecting a review refreshes the number');
    });

    await step('admin login and dashboard fields render at 16px on phones', () => {
      assert.ok(login.includes('className="admin-login"'), 'the login screen is targeted');
      assert.ok(/\.admin-login input,[\s\S]{0,200}font-size:\s*16px\s*!important/.test(css),
        'login inputs override inline sizes to 16px');
      assert.ok(/\.admin-container input,[\s\S]{0,200}font-size:\s*16px\s*!important/.test(css),
        'dashboard inputs override inline sizes to 16px');
    });

    await step('ADD TO BAG is a full-width, legible CTA on phones', () => {
      assert.ok(product.includes('className="gold-btn add-to-bag-btn"'), 'the button has a stable hook');
      assert.ok(product.includes("whiteSpace: 'nowrap'"), 'the label cannot wrap');
      assert.ok(/@media \(max-width: 768px\)[\s\S]{0,600}\.product-buy-row\s*\{[\s\S]{0,200}display:\s*grid/.test(css),
        'the buy row becomes a grid on phones');
      assert.ok(/\.product-buy-row > \.add-to-bag-btn\s*\{[\s\S]{0,300}grid-column:\s*1 \/ -1[\s\S]{0,300}min-height:\s*44px/.test(css),
        'the CTA spans the full row with a 44px target');
      assert.ok(/\.product-buy-row > \.add-to-bag-btn\s*\{[\s\S]{0,400}font-size:\s*11\.5px/.test(css),
        'the label stays readable instead of shrinking to 10px');
      assert.ok(!product.includes('product-sticky-buy'), 'no sticky buy bar duplicates the CTA on scroll');
      assert.ok(!css.includes('.product-sticky-buy'), 'no sticky buy styles remain');
      assert.ok(!css.includes('has-sticky-buy'), 'no body flag remains for a removed bar');
    });
  }

  console.log('\n[9] 44px tap targets across the storefront chrome');
  {
    const css = read('src/index.css');
    const app = read('src/App.js');
    const product = read('src/pages/ProductPage.js');
    const cart = read('src/pages/CartPage.js');
    const drawer = read('src/components/shop/CartDrawer.js');
    const shop = read('src/pages/ShopPage.js');
    const header = read('src/components/shop/Header.js');
    const nav = read('src/components/shop/MobileNav.js');
    const card = read('src/components/shop/ProductCard.js');
    const home = read('src/pages/HomePage.js');
    const sort = shop.slice(shop.indexOf('{/* SORT */}'), shop.indexOf('{/* FILTER PANEL */}'));

    await step('header, footer and checkout chrome reach 44px', () => {
      assert.ok(/\.zashm-header-search,\s*\n?\.zashm-header-utilities > button\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/.test(css),
        'header search and utility buttons are 44px');
      assert.ok(/\.site-footer a\[target='_blank'\]\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/.test(css),
        'footer social links are 44px squares');
      assert.ok(/@media \(max-width: 768px\) \{[\s\S]{0,900}\.site-footer \.footer-social a\[target='_blank'\] \{[^}]*width:\s*44px;[^}]*height:\s*44px/.test(css),
        'footer social icons keep a full 44px tap target on phones');
      assert.ok(/\.checkout-grid input,\s*\n?\s*\.checkout-grid select\s*\{\s*min-height:\s*44px/.test(css),
        'checkout fields are 44px tall');
      assert.ok(/\.gold-btn,\s*\n?\.outline-btn\s*\{\s*min-height:\s*44px/.test(css),
        'every gold/outline button is at least 44px tall');
    });

    await step('cart, drawer and mobile nav controls reach 44px', () => {
      assert.ok(!/width:\s*34,\s*height:\s*34/.test(cart), 'cart quantity buttons are no longer 34px');
      assert.ok(/width:\s*44,\s*height:\s*44/.test(cart), 'cart quantity buttons are 44px');
      assert.ok(/width:\s*44,\s*height:\s*44/.test(drawer), 'drawer close/qty buttons are 44px');
      // The nav's tap targets and label size moved from inline styles into
      // .mobile-nav-item / .mobile-nav-label, so the guarantee is asserted on
      // the stylesheet that now owns them.
      assert.ok(/\.mobile-nav-item\s*\{[^}]*min-width:\s*(4[4-9]|[5-9]\d)px;[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/.test(css),
        'mobile nav items are at least 44px');
      assert.ok(/\.mobile-nav-label\s*\{[^}]*font-size:\s*10px;[^}]*font-weight:\s*500/.test(css),
        'mobile nav labels are 10px and lighter, so they read as a caption');
      assert.ok(/mobile-nav--keyboard-open/.test(nav),
        'the keyboard-open state still hides the bottom nav');
      assert.ok(/padding:\s*\n\s*'0 max\(14px, calc\(env\(safe-area-inset-right, 0px\) \+ 14px\)\) calc\(6px \+ env\(safe-area-inset-bottom, 0px\)\) max\(14px, calc\(env\(safe-area-inset-left, 0px\) \+ 14px\)\)'/.test(nav) &&
         !/calc\(10px \+ env\(safe-area-inset-bottom/.test(nav),
        'the mobile dock sits 6px above the bottom edge plus the safe area, clear of the gesture strip');
      assert.ok(/\.site-search-input\s*\{[^}]*min-height:\s*44px/.test(css) &&
         /className="site-search-input"/.test(header),
        'the header search field is 44px tall, with its sizing in CSS');
      assert.ok(/className="site-search-field-icon"/.test(header) &&
         /\.site-search-field-icon\s*\{[^}]*color:\s*var\(--gold\)/.test(css),
        'the search glyph sits inside the field in brand gold');
      assert.ok(/aria-expanded=\{searchOpen\}/.test(header),
        'the search toggle announces its open state');
    });

    await step('shop filters, sort and price inputs are touch-safe', () => {
      assert.ok(/\.shop-chip,\s*\n\.shop-filter-toggle \{[^}]*min-height:\s*44px;[^}]*font-size:\s*11px;/.test(css),
        'chips and the Filter toggle share one 44px / 11px desktop ladder');
      assert.ok(/\.shop-sort \{[^}]*min-height:\s*44px;[^}]*font-size:\s*11px;/.test(css),
        'the sort select sits on the same ladder');
      assert.ok(!/minHeight:\s*44,[\s\S]{0,80}?border: selected/.test(shop),
        'chip sizing lives in CSS, not an inline style, so phones can override it');
      assert.ok(!/minHeight:\s*44,\s*\n\s*background:\s*'var\(--bg3\)'/.test(shop),
        'the sort select no longer pins its own height inline');
      const phoneToolbar = (css.match(/@media \(max-width: 767px\) \{[\s\S]*?\n\}/g) || [])
        .find((block) => /\.shop-chip,/.test(block)) || '';
      assert.ok(/\.shop-chip,\s*\n\s*\.shop-filter-toggle \{\s*min-height:\s*32px;[^}]*font-size:\s*9\.5px;/.test(phoneToolbar),
        'phones shrink the chips and the Filter toggle together (44→32px, 11→9.5px)');
      assert.ok(/\.shop-sort \{\s*min-height:\s*32px;[^}]*font-size:\s*9\.5px;/.test(phoneToolbar),
        'the sort select shrinks with the chips into a compact control');
      assert.ok(/\.shop-sort-wrap \{[^}]*width:\s*clamp\(140px, 11vw, 160px\)/.test(css) &&
         /\.shop-sort-wrap \{ width: 148px; \}/.test(phoneToolbar),
        'the sort is compact but a little wider than its label on every screen');
      assert.ok(!/shop-result-pill/.test(shop) && !/shop-toolbar-actions/.test(shop),
        'there is no piece-count pill or extra wrapper beside the sort');
      assert.ok(/\.shop-sort \{[^}]*background: linear-gradient\(180deg, rgba\(255, 255, 255, 0\.05\), rgba\(255, 255, 255, 0\.01\)\), var\(--bg3\);[^}]*border: 1px solid rgba\(255, 255, 255, 0\.11\);[^}]*color: var\(--text2\);/.test(css) &&
         !/background:\s*'var\(--bg3\)'/.test(sort) &&
         !/backgroundImage:\s*'linear-gradient/.test(sort),
        'the sort paint lives in CSS, matching the unselected chip surface');
      assert.ok(/\.shop-sort \{[^}]*transition: none;[^}]*touch-action: manipulation;/.test(css),
        'the select has no CSS transition of its own to lag behind the picker');
      assert.ok(/\.shop-sort:active,\s*\n\.shop-sort:focus,\s*\n\.shop-sort:focus-visible \{[^}]*border-color: rgba\(255, 240, 202, 0\.3\);[^}]*background: linear-gradient\(135deg, #9a7a2e 0%, #c9a84c 46%, #e8c870 100%\);[^}]*color: #14110b;/.test(css),
        'pressing or focusing the sort fills it with the same gold as an active chip');
      assert.ok(/\.shop-sort-wrap:active \.shop-sort-chevron,\s*\n\.shop-sort-wrap:focus-within \.shop-sort-chevron \{[^}]*color: #14110b;/.test(css),
        'the chevron switches to dark ink while the sort is gold');
      assert.ok(/onPointerDown=\{\(\) => \{ sortPointerRef\.current = true; \}\}/.test(shop) &&
         /if \(sortPointerRef\.current\) event\.currentTarget\.blur\(\);/.test(shop) &&
         /event\.key === 'Escape'\)/.test(shop) &&
         /document\.addEventListener\('pointerdown', clearSortFocus, true\)/.test(shop) &&
         /event\.target !== select\) select\.blur\(\)/.test(shop),
        'pointer choices, Escape, and tapping away clear the gold; keyboard choices do not');
      assert.ok(/\['ArrowDown', 'ArrowUp', 'Home', 'End'\]\.includes\(event\.key\)\)\s*\{\s*sortPointerRef\.current = false;\s*\}/.test(shop) &&
         /onBlur=\{\(\) => \{ sortPointerRef\.current = false; \}\}/.test(shop),
        'arrow keys clear the pointer flag so the select keeps focus and its gold fill');
      assert.ok(/isEditable[\s\S]{0,320}?element\.matches\('textarea'\)/.test(nav) &&
         !/isEditable[\s\S]{0,320}?element\.matches\('textarea, select'\)/.test(nav),
        'opening the native sort picker does not count as a keyboard, so the bottom nav stays');
      assert.ok(/\.shop-filter-toggle\s*\{\s*flex:\s*1 1 auto;[^}]*min-width:\s*96px;[^}]*padding:\s*6px 14px;/.test(phoneToolbar),
        'the Filter toggle fills the remaining space beside the sort on phones');
      assert.ok(/\.shop-label-chip-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(phoneToolbar) &&
         /\.shop-label-chip\s*\{\s*min-height:\s*34px;[^}]*font-size:\s*10\.5px;/.test(phoneToolbar),
        'label chips arrange in a tidy grid and are slightly smaller on phones');
      assert.ok(/\.price-input \{\s*font-size:\s*16px/.test(css),
        'price inputs are 16px on phones (no iOS zoom)');
      assert.ok(/@media \(min-width: 769px\) \{\s*\.price-input \{ font-size: 14px; \}/.test(css),
        'and drop to a calmer 14px under a real pointer');
      assert.ok(!/fontSize:\s*16/.test(shop),
        'the size lives in CSS so the "No minimum"/"No maximum" hint can be smaller');
    });

    await step('product cards keep a clean photo and readable badges', () => {
      assert.ok(/@media \(max-width: 768px\) \{\s*\.product-card-labels \.label-badge \{\s*font-size:\s*clamp\(8px, 2\.1cqw, 9px\)/.test(css)
        && /\.product-card-image\s*\{[^}]*container-type:\s*inline-size/.test(css),
        'card labels shrink on phones and small screens while staying readable');
      assert.ok(/\.product-card-labels\s*\{[^}]*top:\s*0;[^}]*left:\s*0;[^}]*padding:\s*0;/.test(css),
        'the card label is welded into the top-left corner of the image');
      assert.ok(!/\.product-page-label\s*\{[^}]*left:\s*50%/.test(css),
        'the product page label stays on the top-left image edge too');
      assert.ok(/\.product-card-labels \.label-badge\s*\{[^}]*text-align:\s*center/.test(css),
        'the label text is centred inside its box');
      assert.ok(/\.product-card-labels \.label-badge\s*\{[^}]*transition:\s*box-shadow/.test(css)
        && !/zashm-label-in/.test(css)
        && !/zashm-label-glow/.test(css),
        'the label box is static: no entrance, no glow loop');
      assert.ok(/className="product-card-image"[\s\S]{0,1600}className="product-card-labels"/.test(card),
        'every card cover carries the label box on the image');
      assert.ok(/className="product-card-labels product-page-label"[\s\S]{0,400}?className="product-card-image\b/.test(product),
        'the product page label sits in its own row above the photo, never over it');
      assert.ok(/\.product-page-label\s*\{[\s\S]{0,140}?position: static/.test(css),
        'the product page label is in flow, so the badge cannot cover the image');
      assert.ok(/fontSize:\s*10,[\s\S]{0,120}whiteSpace:\s*'nowrap'/.test(card), 'the discount badge is 10px');
      assert.ok(!/product-card-action/.test(card) && !/product-card-action/.test(css),
        'the photo carries no overlay buttons: no eye, no heart');
      assert.ok(/product-wish-btn/.test(product) && /toggleWishlist\(p\.id\)/.test(product),
        'saving a piece still lives on the product page');
      assert.ok(!/toggleWishlist/.test(card),
        'the card never writes to the wishlist itself');
      assert.ok(/\{!isMobile && \(\s*<div className="zashm-header-utilities">/.test(header),
        'on a phone the header renders only the search icon, at the far right');
      assert.ok(/useState\(\(\) => \(\s*typeof window !== 'undefined' && window\.innerWidth <= 768\s*\)\)/.test(header),
        'the phone layout is known on the first render, so the header icons never flash before they are removed');
      assert.ok(/\.product-collection-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/.test(css)
        && /@media \(max-width: 768px\)\s*\{\s*\.product-collection-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/.test(css),
        'collections are four-up on desktop and two-up on phones');
      assert.ok(/\.product-card \.product-card-image::after\s*\{[^}]*linear-gradient/.test(css)
        && /\.product-card:hover \.product-card-image::after/.test(css),
        'a pointer-only sheen animates the photo without touching the product page gallery');
      assert.ok(/h1:not\(\.hero-brand\)[\s\S]{0,240}font-size:\s*clamp\(28px, 5\.6vw, 36px\)/.test(css),
        'phone titles keep a 28px floor and grow back on a 768px tablet');
      assert.ok(/<MotionConfig reducedMotion="always">/.test(app),
        'framer-motion movement is disabled for everyone');
    });

    await step('each scroll area owns its own scroll, and the glass stays flat', () => {
      // The drawer must not hand its scroll back to the page underneath it.
      assert.ok(/body\.style\.position = 'fixed'/.test(drawer)
        && /body\.style\.top = `-\$\{scrollY\}px`/.test(drawer)
        && /const restoreY = leaveAtTopRef\.current \? 0 : scrollY;/.test(drawer)
        && /window\.scrollTo\(0, restoreY\)/.test(drawer)
        && /window\.requestAnimationFrame\?\.\(\(\) => window\.scrollTo\(0, restoreY\)\)/.test(drawer),
        'the bag drawer fixes the body and restores its offset unless it is leaving for a new page');
      assert.ok(/\.cart-drawer-body\s*\{[^}]*overscroll-behavior:\s*contain/.test(css),
        'the drawer body contains its own overscroll');
      assert.ok(!/repeating-linear-gradient/.test(css.slice(css.indexOf('Ambient backdrop'), css.indexOf('Film grain'))),
        'the background carries no vertical fluted lines');
      assert.ok(/\.product-card-image\.product-gallery-main::before\s*\{\s*display:\s*none;/.test(css)
        && !/\.product-gallery-main::after\s*\{[^}]*inset 0 0 0 1px/.test(css),
        'the product photo keeps one outer border, not a border inside a border');

      // The promo chip is a small champagne pill, never a full-width green box.
      assert.ok(/\.bag-coupon-applied\s*\{[^}]*border-radius:\s*999px/.test(css)
        && /\.checkout-coupon-applied\s*\{[^}]*border-radius:\s*999px/.test(css),
        'applied codes read as compact pills in the bag and at checkout');
      const chipBlocks = [...css.matchAll(/\.(?:bag|checkout)-coupon-applied[^{]*\{([^}]*)\}/g)]
        .map((m) => m[1]).join('\n');
      assert.ok(!/#4ec07e/.test(chipBlocks) && !/rgba\(39, 174, 96/.test(chipBlocks),
        'the old green success panel is gone');
      assert.ok(/\.bag-coupon-applied button::after\s*\{[^}]*inset:\s*-5px -6px/.test(css)
        && /\.checkout-coupon-applied button::after\s*\{[^}]*inset:\s*-5px -6px/.test(css),
        'the compact Remove keeps a 44px tap area through a transparent pseudo-element');

      // Glass is painted, never blurred: no backdrop-filter on the checkout cards.
      for (const selector of ['.checkout-card', '.checkout-form-card', '.checkout-summary', '.bag-summary']) {
        const rules = [...css.matchAll(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g'))]
          .map((m) => m[1]);
        assert.ok(rules.some((rule) => /radial-gradient/.test(rule) && /linear-gradient/.test(rule)),
          `${selector} layers a sheen and a floor instead of a flat fill`);
        assert.ok(rules.every((rule) => !/backdrop-filter/.test(rule)),
          `${selector} does not blur the page behind it`);
      }
    });

    await step('the header Z has no cloud, and checkout is polished black', () => {
      const cart = read('src/pages/CartPage.js');

      // The header monogram sits straight on the bar: no blurred halo, no gold glow.
      assert.ok(!/\.zashm-header-logo::before/.test(css),
        'the warm pool behind the header Z is gone');
      assert.ok(/\.zashm-header-logo img\s*\{[^}]*filter:\s*drop-shadow\(0 1px 2px rgba\(0, 0, 0, 0\.55\)\);/.test(css),
        'the monogram keeps only a dark contact shadow, not a gold halo');

      // The checkout surfaces are glossy black with white specular hairlines.
      // Each selector is declared more than once (padding, sticky, shells), so
      // read the block that actually paints the edge.
      const shellBlock = (selector) => {
        const rules = [...css.matchAll(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`, 'g'))]
          .map((m) => m[1])
          .filter((rule) => /border(-color)?:/.test(rule));
        return rules[rules.length - 1] || '';
      };
      const cardBlock = shellBlock('.checkout-card');
      const formBlock = shellBlock('.checkout-form-card');
      const summaryBlock = shellBlock('.checkout-summary');
      assert.ok(/border:\s*1px solid rgba\(255, 255, 255/.test(cardBlock),
        'the base card stays neutral white specular');
      assert.ok(/border:\s*1px solid rgba\(201, 168, 76, 0\.16\)/.test(formBlock)
        && /border-color:\s*rgba\(201, 168, 76, 0\.14\)/.test(summaryBlock),
        'Delivery details and Order Summary wear a warm champagne hairline');
      const washes = [...(formBlock + summaryBlock)
        .matchAll(/radial-gradient\([^)]*rgba\(201, 168, 76, (0\.\d+)\)/g)]
        .map((match) => Number(match[1]));
      assert.ok(washes.length >= 2 && washes.every((alpha) => alpha <= 0.08),
        'the champagne wash stays a whisper (8% or less)');
      assert.ok(!/\.checkout-head::after\s*\{[^}]*rgba\(201, 168, 76/.test(css),
        'the rule under the Checkout title is a cool specular, not gold');

      // The pieces line is legible: real size, quiet grey, and a qty chip.
      const metaBlock = (css.match(/\.checkout-item-meta\s*\{([^}]*)\}/) || [])[1] || '';
      assert.ok(/\.checkout-item-name\s*\{[^}]*font-size:\s*14px/.test(css),
        'the piece name is a readable 14px');
      assert.ok(/font-size:\s*11px/.test(metaBlock) && !/text-transform:\s*uppercase/.test(metaBlock),
        'the size/colour line is 11px sentence case, not 9px caps');
      assert.ok(/\.checkout-item-qty\s*\{[^}]*border-radius:\s*999px/.test(css),
        'the quantity reads as its own chip');
      assert.ok(/className="checkout-item-qty"/.test(cart),
        'the summary renders the quantity chip');
    });

    await step('removing a wishlist item is red on the product page', () => {
      assert.ok(/isWished\s*\?\s*'error'\s*:\s*'success'/.test(product),
        'the product page reports a removal as an error toast');
      assert.ok(!/'info'/.test(product),
        'the heart does not use the blue info toast any more');
      assert.ok(/toggleWishlist\(p\.id\)[\s\S]{0,220}isWished \? 'error' : 'success'/.test(product),
        'the colour follows the removal, not the addition');
      assert.ok(!/isWished/.test(card),
        'the card no longer owns a wishlist control');
    });

    await step('the home page shows every product once, whatever its label', () => {
      assert.ok(/curatedIds\.has\(product\.id\)/.test(home),
        'pieces outside Featured/New Arrival fall into The Collection row');
      assert.ok(/hasCuratedSections[\s\S]{0,160}activeProducts[\s\S]{0,40}\.slice\(0, 4\)/.test(home),
        'an unlabelled catalogue still renders a fallback collection');
    });

    await step('product page layout and tabs stay accessible', () => {
      assert.ok(product.includes("aspectRatio: '3 / 4'"), 'the gallery matches the 3:4 catalogue images');
      assert.ok(/objectFit: 'cover', objectPosition: 'center'/.test(product),
        'the main print fills the plate with no black side bars');
      assert.ok(!/Back to Products/.test(product), 'the duplicate back button is gone');
      assert.ok(/role="tablist"/.test(product) && /role="tab"/.test(product) && /role="tabpanel"/.test(product),
        'tabs expose the full ARIA pattern');
      assert.ok(/ArrowRight/.test(product) && /ArrowLeft/.test(product) && /Home/.test(product) && /End/.test(product),
        'arrow/Home/End keys move between tabs');
      assert.ok(/minWidth:\s*44,\s*minHeight:\s*44/.test(product), 'breadcrumb links are 44px');
      assert.ok(/width:\s*44,\s*height:\s*44,\s*borderRadius:\s*'50%'/.test(product),
        'gallery arrows and colour swatches are 44px');
      assert.ok(/const availableTabs = descriptionText \? \['description', 'details', 'care'\] : \['details', 'care'\]/.test(product),
        'an empty description never renders an empty tab');
    });

    await step('the return windows are unified: 7 days, original condition', () => {
      assert.ok(/7-Day Exchanges &amp; Returns/.test(product), 'product page headline states the window');
      assert.ok(/Exchange or return within 7 days of delivery/.test(product), 'product page body states the window');
      assert.ok(/unworn, in their original condition and packaging/.test(product),
        'product page keeps the original-condition requirement');
      assert.ok(/exchange or return within 7 days of receiving your order/.test(app),
        'the policy modal states the same window');
      assert.ok(/original condition/.test(app), 'the policy modal keeps the original-condition requirement');
      assert.ok(!/within 4 days/.test(product) && !/within 4 days/.test(app), 'no 4-day copy is left');
    });

    await step('a refused coupon delete shows the server reason', () => {
      const adminSource = read('src/pages/AdminApp.js');
      const start = adminSource.indexOf('const confirmDelete = async () => {');
      assert.ok(start >= 0, 'the coupon delete handler exists');
      const block = adminSource.slice(start, start + 900);
      assert.ok(/const msg = e && typeof e\.message === 'string' && e\.message/.test(block),
        'the toast prefers the API message');
      assert.ok(/toast\.error\(msg\)/.test(block), 'the API message reaches the toast');
      assert.ok(!/toast\.error\('Could not delete discount code\. Please try again\.'\);/.test(block),
        'the generic retry message is no longer shown unconditionally');
    });

    await step('WhatsApp is the only floating action and stays visible while typing', () => {
      assert.ok(/currentPage === 'home' && !cartOpen && <WhatsAppButton \/>/.test(app),
        'WhatsApp stays for typing and leaves only while the bag is open');
      assert.ok(/useStore\(\(state\) => state\.cartOpen\)/.test(app),
        'the floating-action gate reads the real drawer state');
      assert.ok(!/isEditingField|isSmallScreen|<BackToTop/.test(app),
        'no keyboard-hiding state and no scroll-to-top button remain');
      assert.ok(!/focusin|focusout/.test(app),
        'the removed floating action left no focus listeners behind');
    });

    await step('mobile footer clears the floating actions above the bottom nav', () => {
      assert.ok(/footer\.site-footer\s*\{[^}]*padding-bottom:\s*calc\(12px \+ 128px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(css),
        'footer reserves the full 128px floating-action region plus the safe area');
    });
  }

  console.log('\n[10] performance: only the ZASHM wordmark lights up');
  {
    const css = read('src/index.css');
    const header = read('src/components/shop/Header.js');
    const product = read('src/pages/ProductPage.js');
    const home = read('src/pages/HomePage.js');
    const app = read('src/App.js');
    const entry = read('src/index.js');
    const html = read('index.html');
    const touch = css.slice(css.indexOf('TOUCH SIZES'));

    await step('the ambient room is painted once and never loops', () => {
      assert.ok(!/@keyframes ambient-drift/.test(css) && !/ambient-drift/.test(css),
        'the drifting wall keyframe is gone');
      assert.ok(!/ambient-sheen/.test(css) && !/\.app-shell::after/.test(css),
        'the travelling sheen layer is gone');
      const names = [...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]);
      const allowed = new Set([
        'none',
        'hero-brand-letter-glint',
        'hero-brand-twinkle',
        'hero-dust-twinkle',
        'hero-scroll-cue-bob',
        'app-startup-spin',
        'zshm-photo-shimmer',
      ]);
      assert.ok(names.every((name) => allowed.has(name)),
        'every animation declaration points at a kept keyframe');
    });

    await step('the wordmark metal is frozen and only the letter light moves', () => {
      assert.ok(/\.hero-brand-letter\s*\{[^}]*background-position:\s*50% 0;/.test(css),
        'the hero metal sits on its richest frame');
      assert.ok(/\.footer-wordmark-letter\s*\{[^}]*background-position:\s*50% 0;/.test(css),
        'the footer metal sits on the same frame');
      assert.ok(!/hero-brand-shimmer/.test(css) && !/footer-letter-light/.test(css),
        'neither gradient re-rasterises every frame');
      assert.ok(/\.hero-brand-letter::after\s*\{[^}]*animation:\s*hero-brand-letter-glint 5s ease-in-out infinite/.test(css),
        'the hero letters still catch the light');
      assert.ok(/\.footer-wordmark-letter::after\s*\{[^}]*animation:\s*hero-brand-letter-glint 5s ease-in-out infinite/.test(css),
        'the footer letters light on the same beat');
      assert.ok(/@keyframes hero-brand-letter-glint/.test(css),
        'the one kept keyframe is the letter glint');
    });

    await step('one light travels from letter to letter on every size', () => {
      const heroGlint = /\.hero-brand-letter::after\s*\{[^}]*\}/.exec(css);
      const footerGlint = /\.footer-wordmark-letter::after\s*\{[^}]*\}/.exec(css);
      assert.ok(heroGlint && footerGlint, 'both wordmarks still carry a lit clone');
      assert.ok(/\.hero-brand-letter::after\s*\{[^}]*animation-delay:\s*calc\(var\(--letter-index\) \* 0\.6s\)/.test(css),
        'the hero light is handed from Z to M');
      assert.ok(/\.footer-wordmark-letter::after\s*\{[^}]*animation-delay:\s*calc\(var\(--letter-index\) \* 0\.6s\)/.test(css),
        'the footer light follows the same hand-off');
      assert.ok(!/#fdf0c4|0 0 76px/.test(heroGlint[0] + footerGlint[0]),
        'the old near-white flare and its wide halo are gone');
      const lum = (hex) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const heroLight = /#([0-9a-f]{6})/i.exec(heroGlint[0])[1];
      const footerLight = /#([0-9a-f]{6})/i.exec(footerGlint[0])[1];
      assert.ok(lum(heroLight) > lum('fff0c4') && lum(footerLight) > lum('fff0c4'),
        'the light is paler than the brightest stop in the metal gradient, so it is visible');
      assert.ok(/@keyframes hero-brand-letter-glint\s*\{\s*0%,\s*100%\s*\{\s*opacity:\s*0\.08;\s*\}\s*18%\s*\{\s*opacity:\s*0\.95;\s*\}\s*42%\s*\{\s*opacity:\s*0\.08;/.test(css),
        'one long rise and fall, so neighbours overlap into a moving light');
      assert.ok(0.42 * 5 > 0.6,
        'the fall lasts past the next letter, so the glow never blinks off between glyphs');
      const mobileBlocks = css.match(/@media \(max-width: 768px\) \{[\s\S]*?\n\}/g) || [];
      assert.ok(!mobileBlocks.some((block) => /\.hero-brand-letter::after,\s*\n\s*\.footer-wordmark-letter::after\s*\{\s*display:\s*none/.test(block)),
        'phones keep the travelling light instead of hiding it');
    });

    await step('the wordmark stars and hero dust are tiny and compositor-only', () => {
      assert.ok(!/hero-brand-lockup::before/.test(css), 'the hero cloud behind the word is gone');
      assert.ok(!/\.footer-wordmark::before/.test(css), 'the footer cloud behind the word is gone');
      assert.ok(!/hero-brand-halo/.test(css) && !/hero-brand-letter-sparkle/.test(css),
        'no halo came back; the per-letter stars are static spans, not extra clones');

      const heroLetterStars = (home.match(/hero-brand-letter-star--/g) || []).length;
      assert.equal(heroLetterStars, 2, 'the hero letter template carries two star spans');
      assert.ok(/'ZASHM'\.split\(''\)\.map[\s\S]{0,600}?hero-brand-letter-star--a/.test(home),
        'the stars sit inside the letter loop, so all five letters get them');
      const footerLetterStars = (app.match(/footer-wordmark-letter-star--/g) || []).length;
      assert.equal(footerLetterStars, 3, 'the footer letter template carries three star spans');
      assert.ok(/'ZASHM'\.split\(''\)\.map[\s\S]{0,600}?footer-wordmark-letter-star--a/.test(app),
        'the same loop gives every footer letter its stars');
      assert.ok(/\.hero-brand-letter-stars \{[^}]*animation:\s*hero-dust-twinkle 5s ease-in-out infinite;/.test(css)
        && /\.footer-wordmark-letter-stars \{[^}]*animation:\s*hero-dust-twinkle 5s ease-in-out infinite;/.test(css),
        'one shared opacity loop per letter, no new keyframe');
      assert.ok(/\.hero-brand-letter-stars \{[^}]*opacity:\s*0\.12;/.test(css)
        && /\.footer-wordmark-letter-stars \{[^}]*opacity:\s*0\.12;/.test(css),
        'stars waiting for their turn rest dim, so no letter flashes at load');

      const sparkleCount = (home.match(/hero-brand-sparkle--/g) || []).length;
      assert.equal(sparkleCount, 5, 'five stars sit on the hero wordmark');
      const footerSparkleCount = (app.match(/footer-wordmark-sparkle--/g) || []).length;
      assert.equal(footerSparkleCount, 5, 'five stars sit on the footer wordmark');
      assert.ok(/\.footer-wordmark-sparkle \{[^}]*animation:\s*hero-brand-twinkle 3\.2s ease-in-out infinite;/.test(css),
        'the footer stars reuse the hero twinkle instead of adding a loop');
      const dustCount = (home.match(/left: '\d+%', top: '\d+%', size:/g) || []).length;
      assert.equal(dustCount, 6, 'exactly six dust motes sit in the hero air');
      assert.ok(/className="hero-dust-field"/.test(home) && !/animationDelay/.test(home),
        'one dust field owns a single twinkle instead of six separate animations');

      // The loops may only touch opacity and transform: no gradient, shadow,
      // filter or background-position that would repaint the text every frame.
      const twinkle = css.slice(css.indexOf('@keyframes hero-brand-twinkle'), css.indexOf('.hero-dust-field {'));
      assert.ok(/@keyframes hero-brand-twinkle/.test(twinkle) && !/background|box-shadow|filter/.test(twinkle),
        'the star loop animates opacity/transform only');
      const dustLoop = css.slice(css.indexOf('@keyframes hero-dust-twinkle'));
      assert.ok(/@keyframes hero-dust-twinkle/.test(dustLoop)
        && /opacity/.test(dustLoop.slice(0, 220))
        && !/transform|background|box-shadow|filter/.test(dustLoop.slice(0, 220)),
        'the dust loop animates opacity only');
      assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-brand-sparkle\s*\{\s*animation:\s*none;/.test(css)
        && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-dust-field\s*\{\s*animation:\s*none;/.test(css)
        && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.footer-wordmark-sparkle\s*\{\s*animation:\s*none;/.test(css)
        && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-brand-letter-stars,[\s\S]{0,80}\.footer-wordmark-letter-stars\s*\{\s*animation:\s*none;/.test(css),
        'reduced motion freezes every decoration at a steady glow');
    });

    await step('the home hero is plain markup with no scroll work', () => {
      assert.ok(!/framer-motion/.test(home) && !/<motion\./.test(home),
        'the hero no longer mounts Framer Motion nodes');
      assert.ok(!/useScroll|useTransform|scrollYProgress/.test(home),
        'nothing reads scroll position on the home page');
      assert.ok(/className="hero-brand-letter"[\s\S]{0,160}data-letter=\{letter\}/.test(home),
        'the letters keep their data-letter clone');
      assert.ok(/hero-brand-letter-star--a[\s\S]*?hero-brand-letter-star--b/.test(home),
        'two star spans sit inside every hero letter');
      assert.ok(!/hero-brand-letter-star--c/.test(home),
        'the extra hero star is gone');
      assert.ok(/footer-wordmark-letter-star--a[\s\S]*?footer-wordmark-letter-star--b[\s\S]*?footer-wordmark-letter-star--c/.test(app),
        'the footer letters keep their three stars');
      assert.ok(/hero-brand-sparkle--one[\s\S]*?hero-brand-sparkle--two[\s\S]*?hero-brand-sparkle--three[\s\S]*?hero-brand-sparkle--four[\s\S]*?hero-brand-sparkle--five/.test(home),
        'the five stars are plain spans inside the lockup');
      assert.ok(!/hero-brand-sparkle--six/.test(home) && !/hero-brand-sparkle--seven/.test(home),
        'the two extra ambient stars are gone from the home page only');
      assert.ok(/footer-wordmark-sparkle--one[\s\S]*?footer-wordmark-sparkle--two[\s\S]*?footer-wordmark-sparkle--three[\s\S]*?footer-wordmark-sparkle--four[\s\S]*?footer-wordmark-sparkle--five/.test(app),
        'the footer stars are plain spans too');
    });

    await step('Framer Motion movement is off everywhere; fades only', () => {
      assert.ok(/<MotionConfig reducedMotion="always">/.test(app),
        'transform and layout animations are disabled globally');
      assert.ok(!/behavior:\s*'smooth'/.test(app), 'route changes jump to the top instantly');
      assert.ok(/html \{ scroll-behavior: auto; \}/.test(css), 'smooth scrolling is off');
      assert.ok(!/behavior:\s*'smooth'/.test(read('src/pages/CartPage.js')),
        'checkout does not animate a scroll');
      assert.ok(!/behavior:\s*'smooth'/.test(read('src/components/shop/ProductReviews.js')),
        'review focus does not animate a scroll');
    });

    await step('the search glyph and phone wordmark have no background smudge', () => {
      const search = css.slice(css.indexOf('.zashm-header-search svg {'), css.indexOf('/* The search field:'));
      assert.ok(!/filter:\s*drop-shadow/.test(search) && /filter: none;/.test(search),
        'the search icon has no glow, open or closed');
      const phone = (css.match(/@media \(max-width: 768px\) \{[\s\S]*?\n\}/g) || [])
        .find((block) => /\.hero-brand \{/.test(block)) || '';
      assert.ok(!/\.hero-brand-letter::after,\s*\n\s*\.footer-wordmark-letter::after/.test(phone),
        'phone wordmarks keep the calm gold band without a local override');
    });

    await step('the scroll chevron bobs on the compositor only', () => {
      assert.ok(/className="hero-scroll-cue-arrow"/.test(home),
        'the down arrow is the only animated child of the scroll cue');
      assert.ok(/\.hero-scroll-cue-arrow \{[^}]*animation: hero-scroll-cue-bob 2\.4s ease-in-out infinite;[^}]*will-change: transform;/.test(css),
        'one small transform layer carries the bob');
      const bobStart = css.indexOf('@keyframes hero-scroll-cue-bob');
      const bob = css.slice(bobStart, css.indexOf('\n}', bobStart) + 2);
      assert.ok(/@keyframes hero-scroll-cue-bob/.test(bob) && /translate3d/.test(bob)
        && !/opacity|color|background|box-shadow|filter|width|height|top|left/.test(bob),
        'the loop animates translate only, with no paint or layout work');
      assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.hero-scroll-cue-arrow \{\s*animation: none;\s*transform: none;\s*will-change: auto;/.test(css),
        'reduced motion leaves the chevron still and drops its layer');
    });

    await step('only functional spinners keep a keyframe', () => {
      const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).sort();
      assert.deepEqual(keyframes, [
        'app-startup-spin',
        'hero-brand-letter-glint',
        'hero-brand-twinkle',
        'hero-dust-twinkle',
        'hero-scroll-cue-bob',
        'zshm-photo-shimmer',
      ], 'the kept loops are the wordmark light, two tiny twinkles, the scroll chevron and two busy indicators');
    });

    await step('no backdrop blur on phones where it would sample a moving page', () => {
      assert.ok(/\.label-badge,\s*\.product-card-labels \.label-badge,\s*\.product-card-label-row \.label-badge \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;/.test(touch),
        'badges over photos use solid glass');
      assert.ok(/\.mobile-nav-inner \{\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;\s*background: linear-gradient\(180deg, rgba\(32, 28, 24, 0\.88\) 0%, rgba\(14, 13, 12, 0\.92\) 100%\);/.test(touch),
        'the mobile dock is lighter glass but still opaque enough to read');
      assert.ok(!/backdropFilter: 'blur\(8px\)'/.test(product),
        'the gallery controls no longer blur the photo they sit on');
    });

    await step('the header does not blur or re-render while scrolling on a phone', () => {
      assert.ok(/backdropFilter: scrolled && !lowPower \? 'blur\(22px\) saturate\(140%\)' : 'none'/.test(header),
        'desktop keeps the blur, touch sizes get none');
      assert.ok(/lowPower \? 'rgba\(18,15,12,0\.94\)'/.test(header),
        'the fill is opaque enough to read without the blur');
      assert.ok(/scrolledRef\.current !== next/.test(header),
        'state only changes when the boolean flips');
      assert.ok(/addEventListener\('scroll', handleScroll, \{ passive: true \}\)/.test(header),
        'the scroll listener is passive');
    });

    await step('brand fonts are self-hosted, preloaded and subset', () => {
      // Strip comments so the note explaining *why* Google Fonts was dropped
      // does not trip the "no third-party font host" assertion.
      const css = read('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
      const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((m) => m[1]);
      assert.equal(faces.length, 6, 'two families x roman/italic x latin/latin-ext');
      const files = faces.map((face) => (face.match(/url\('([^']+)'\)/) || [])[1]);
      assert.equal(new Set(files).size, 6, 'every face points at its own file');
      for (const file of files) {
        assert.ok(/^\/fonts\/[a-z0-9-]+\.woff2$/.test(file), `same-origin font path: ${file}`);
        const bytes = readFileSync(path.join(root, 'public', file), 'latin1');
        assert.equal(bytes.slice(0, 4), 'wOF2', `${file} is a real woff2 file`);
      }
      for (const face of faces) {
        assert.ok(/font-display:\s*swap/.test(face), 'swap keeps the fallback readable if a file is slow');
        assert.ok(/font-weight:\s*300 700/.test(face), 'one variable file per style, not nine static weights');
        assert.ok(/unicode-range:/.test(face), 'subsets so a page downloads only what it paints');
      }
      assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(css), 'no third-party font host in the stylesheet');
      assert.ok(!/BRAND_FONTS_HREF/.test(entry), 'the entry point no longer injects a font stylesheet');
      assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), 'index.html has no third-party font origin');
      const preload = html.match(/rel="preload" as="font" type="font\/woff2" href="([^"]+)" crossorigin/);
      assert.ok(preload, 'the largest-contentful-paint face is preloaded');
      assert.equal(preload[1], '/fonts/cormorant-garamond-latin-var.woff2', 'the preload is the roman latin face');
      assert.ok(files.includes(preload[1]), 'the preload matches a declared face byte for byte');
      const csp = JSON.stringify(JSON.parse(read('vercel.json')));
      assert.ok(/font-src 'self'/.test(csp), 'CSP allows same-origin fonts only');
      assert.ok(!/fonts\.gstatic/.test(csp), 'the Google font origin is gone from the CSP');
    });
  }

  console.log('\n[11] admin dashboard: KPI labels match the numbers they describe');
  {
    const admin = read('src/pages/AdminApp.js');
    const analytics = read('src/lib/analytics.js');

    await step('"non-cancelled orders" never counts cancelled orders', () => {
      // The KPI value is the sum of non-cancelled orders, so its sub-label must
      // subtract them too. Using orderCount (all statuses) overstated the count
      // whenever a cancelled order existed.
      assert.ok(/overview\.orderCount - overview\.cancelledCount/.test(admin),
        'the Total Order Value sub-label subtracts cancelled orders');
      assert.ok(/cancelledCount:\s*cancelled\.length/.test(analytics),
        'summarizeOrders still exposes cancelledCount');
    });
  }

  console.log('\n[12] product hover crossfade, checkout warmth, filter type scale');
  {
    const card = read('src/components/shop/ProductCard.js');
    const css = read('src/index.css');
    const shop = read('src/pages/ShopPage.js');
    const product = read('src/pages/ProductPage.js');

    await step('the second product photo crossfades instead of swapping src', () => {
      // Re-sourcing one <img> made the browser paint the new file the moment it
      // arrived, which is the flash the owner saw. Two stacked frames are both
      // decoded up front, so only opacity changes on hover.
      assert.ok(/matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/.test(card),
        'the second frame is gated on a real pointer');
      assert.ok(/data-visible=\{showSecond \? 'true' : 'false'\}/.test(card),
        'the incoming frame stays mounted and only its visibility flips');
      assert.ok(!/motion\.img/.test(card), 'no framer-motion image swap remains');
      assert.ok(/\.product-card-img \{[\s\S]*?opacity 420ms/.test(css),
        'the frames crossfade over 420ms');
      assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\.product-card-img \{ transition: none; \}/.test(css),
        'reduced motion turns the crossfade off');
    });

    await step('product names have a static metal shine and one transform-only sweep', () => {
      assert.ok(/<span className="product-name-shine">\{product\?\.name \|\| 'Product'\}<\/span>/.test(card),
        'the card wraps the name so the line clamp stays on the block');
      assert.ok(/\.product-name-shine,\s*\.product-title \{\s*background-image: linear-gradient\(104deg/.test(css)
        && /-webkit-background-clip: text;/.test(css),
        'both names carry a fixed gradient fill');
      assert.ok(/\.product-card-name::after,\s*\.product-title::after \{[\s\S]*?transform: translateX\(-125%\);/.test(css)
        && /transition: transform 0\.8s ease;/.test(css),
        'the light pass is a transform transition, not a gradient animation');
      assert.ok(!/@keyframes [a-z-]*shine|background-position:[\s\S]{0,80}?product-name/.test(css),
        'no infinite shimmer keyframe or moving gradient repaints the names');
      assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\s*\.product-card-name::after,\s*\.product-title::after \{\s*display: none;/.test(css),
        'reduced motion keeps the static shine and drops the sweep');
      assert.ok(/forced-colors: active[\s\S]{0,240}?\.product-name-shine,\s*\.product-title/.test(css),
        'forced colours fall back to readable text');
    });

    await step('touch gallery swipes drift smoothly and the strip slides sideways', () => {
      const gallery = product.slice(
        product.indexOf('product-gallery-main'),
        product.indexOf('The gallery controls sit directly')
      );
      assert.ok(!/mode="wait"/.test(gallery), 'no outgoing photo blocks the incoming one');
      assert.ok(/className="product-gallery-track" ref=\{galleryTrackRef\}/.test(product)
        && /transform: `translateX\(-\$\{imgIdx \* galleryFrameWidth\}px\)`/.test(product),
        'selecting a photo slides the strip by exactly one measured frame width');
      assert.ok(/getBoundingClientRect\(\)\.width/.test(product)
        && /new ResizeObserver\(measure\)/.test(product),
        'the step is measured, not a percentage that would snap');
      assert.ok(/transition: reduceMotion \? 'none' : 'transform 550ms cubic-bezier\(0\.45, 0, 0\.2, 1\)'/.test(product),
        'the slide is a 550ms ease-in-out like the reference storefront, or instant with reduced motion');
      assert.ok(/\.product-gallery-frame \{[^}]*flex: 0 0 100%/.test(css)
        && /className="product-gallery-frame"/.test(product),
        'each photo owns one full frame, so the incoming print enters from the right');
      assert.ok(!/scale: 1\.05|scale: 0\.95/.test(gallery), 'no scale animation moves the photo under the finger');
      assert.ok(/\.product-gallery-frames \{[^}]*display: flex;[\s\S]{0,80}?width: 100%/.test(css)
        && /\.product-gallery-track \{[^}]*position: absolute;/.test(css),
        'the strip and its plate share the lit box, so a slide never shifts the layout');
      assert.ok(/onPointerMove=\{handleImagePointerMove\}/.test(product),
        'the gallery actually listens for the drag, not just the release');
      assert.ok(/useMotionValue\(0\)/.test(product) &&
         /useSpring\(galleryDragX, \{[\s\S]{0,120}?stiffness: 190, damping: 30, mass: 0\.9, restDelta: 0\.4/.test(product),
        'a low-stiffness spring smooths every pixel of the drag instead of snapping');
      assert.ok(/const limit = Math\.max\(80, Math\.min\(window\.innerWidth \* 0\.35, 140\)\)/.test(product) &&
         /galleryDragX\.set\(Math\.max\(-limit, Math\.min\(limit, deltaX \* 0\.62\)\)\)/.test(product),
        'a gentle share of the drag drifts the plate with the finger, capped inside the frame');
      assert.ok(!/gallerySettleRef|animate\(galleryDragX/.test(product) &&
         /const handleImagePointerDown[\s\S]{0,400}?if \(imageSwipeStartRef\.current\) return;/.test(product),
        'a second finger cannot replace the pointer that owns the drag');
      assert.ok(/const handleImagePointerUp[\s\S]{0,260}?if \(!start \|\| start\.pointerId !== event\.pointerId\) return;[\s\S]{0,160}?imageSwipeStartRef\.current = null;[\s\S]{0,160}?galleryDragX\.set\(0\);/.test(product),
        'an extra finger lifting never clears the active gesture; the owner still eases the plate home');
      assert.ok(/const handleImagePointerCancel[\s\S]{0,220}?start\.pointerId !== event\.pointerId\) return;/.test(product) &&
         /onPointerCancel=\{handleImagePointerCancel\}/.test(product),
        'a cancel from another finger cannot strand the plate off-centre');
      assert.ok(/className="product-gallery-frames" style=\{\{ x: reduceMotion \? 0 : galleryPlateX \}\}/.test(product) &&
         /\.product-gallery-frames\s*\{[^}]*will-change:\s*transform/.test(css),
        'the drag moves a single composited plate, never the controls or the page');
      assert.ok(/Math\.abs\(deltaX\) < 8 \|\| Math\.abs\(deltaX\) <= Math\.abs\(deltaY\)/.test(product) &&
         /Math\.abs\(deltaX\) < 40/.test(product),
        'a vertical scroll still wins until horizontal intent is clear, and a gentle swipe advances');
    });

    await step('Delivery details and Order Summary carry a light champagne wash', () => {
      assert.ok(/\.checkout-form-card \{[\s\S]{0,400}?border: 1px solid rgba\(201, 168, 76, 0\.16\)/.test(css),
        'the form card gets a warm hairline');
      assert.ok(/rgba\(201, 168, 76, 0\.075\), transparent 62%\)/.test(css),
        'the form card gets a 7.5% champagne wash');
      assert.ok(/\.checkout-summary \{[\s\S]{0,400}?border-color: rgba\(201, 168, 76, 0\.14\)/.test(css),
        'the summary card gets a warm hairline');
      assert.ok(/rgba\(201, 168, 76, 0\.07\), transparent 62%\)/.test(css),
        'the summary card gets a 7% champagne wash');
    });

    await step('the label chips are larger and the price hints are smaller', () => {
      assert.ok(/\.shop-label-chip \{[\s\S]{0,200}?font-size: 13px/.test(css),
        'label chips use a 13px type scale');
      assert.ok(/className="shop-chip shop-label-chip"/.test(shop),
        'All / New Arrival / Best Seller / Featured / Limited Edition use the larger class');
      assert.ok(/\.price-input::placeholder \{[\s\S]{0,160}?font-size: 12px/.test(css),
        'the "No minimum"/"No maximum" hint is smaller than the value');
      assert.ok(!/fontSize: 16/.test(shop),
        'the price input no longer hard-codes 16px inline, so the CSS ladder applies');
    });
  }

  console.log('\n[13] bag drawer, receipt and tracking cleanup');
  {
    const drawer = read('src/components/shop/CartDrawer.js');
    const cartPage = read('src/pages/CartPage.js');
    const track = read('src/pages/TrackOrder.js');
    const css = read('src/index.css');

    await step('the bag opens as a side drawer on a phone too', () => {
      // A full-width panel read as a page change, not a drawer. Leaving ~12% of
      // the storefront visible behind the scrim keeps the context.
      assert.ok(/bottom: 0,[\s\S]{0,200}?width: 'min\(88vw, 420px\)'/.test(drawer),
        'the panel keeps a strip of the storefront visible on a phone');
      assert.ok(!/bottom: 0,[\s\S]{0,120}?width: '100%'/.test(drawer),
        'the panel itself is no longer a full-screen page');
    });

    await step('the bag opens with an opaque scrim and one short transform', () => {
      assert.ok(!/backdropFilter/.test(drawer),
        'the scrim never blurs the live storefront behind the drawer');
      assert.ok(/background: 'rgba\(0,0,0,0\.86\)'/.test(drawer),
        'a solid smoked scrim replaces the blur');
      assert.ok(!/type: 'spring'/.test(drawer), 'the panel no longer springs past its resting edge');
      assert.ok(/transition=\{\{ duration: 0\.24, ease: \[0\.22, 1, 0\.36, 1\] \}\}/.test(drawer),
        'the panel slides in on a single short ease-out');
      assert.ok(/transition=\{\{ duration: 0\.18, ease: 'easeOut' \}\}/.test(drawer),
        'the scrim fades faster than the panel moves');
    });

    await step('Cash on Delivery carries no "Available" badge', () => {
      assert.ok(!/checkout-payment-badge/.test(cartPage),
        'the unused availability badge is gone from the checkout summary');
      assert.ok(/Cash on Delivery[\s\S]{0,240}?Pay in cash when it arrives\./.test(cartPage),
        'the payment row still names the method and explains it');
    });

    await step('the receipt opens on the confirmation, not a letterhead', () => {
      assert.ok(!/order-invoice-head|order-invoice-wordmark|order-invoice-perf/.test(cartPage),
        'ZASHM / LUXURY MENSWEAR · EGYPT / INVOICE / order id letterhead removed');
      assert.ok(!/\.order-invoice-head|\.order-invoice-wordmark|\.order-invoice-perf/.test(css),
        'the dead letterhead rules were removed from the stylesheet');
      assert.ok(!/\.order-receipt::before/.test(css),
        'the blurred silhouette that read as a dark rectangle below the receipt is gone');
    });

    await step('the torn receipt edge is clearer with glassy gold zigzag lines', () => {
      const receipt = (css.match(/\.order-receipt \{[\s\S]*?\n\}/) || [])[0] || '';
      const card = (css.match(/\.order-confirmation-card \{[\s\S]*?\n\}/g) || [])
        .find((block) => /drop-shadow/.test(block)) || '';
      assert.ok(/--receipt-tear: 16px;/.test(receipt) && /--receipt-tooth: 22px;/.test(receipt),
        'the teeth are taller and narrower so the tear reads clearly');
      assert.ok(/linear-gradient\(180deg, #fff0c4 0px, #d8bd7a 2px, #a8853d var\(--receipt-tear\), transparent var\(--receipt-tear\)\)/.test(cartPage),
        'the masked top strip paints the torn teeth in champagne gold');
      assert.ok(/drop-shadow\(0 -0\.6px 0 rgba\(255, 246, 214, 0\.92\)\)/.test(card) &&
         /drop-shadow\(0 -1px 0 rgba\(232, 200, 112, 0\.5\)\)/.test(card) &&
         /drop-shadow\(0 0 5px rgba\(201, 168, 76, 0\.28\)\)/.test(card),
        'the triangular zigzag lines carry a bright, glassy gold edge');
      assert.ok(!/\.order-receipt::before/.test(css),
        'no glow layer returns a rectangle behind the paper');
    });

    await step('the invoice figures are centred and "Cash on delivery" stays on one line', () => {
      assert.ok(/\.order-invoice-meta \{[\s\S]{0,700}?text-align: center/.test(css),
        'Issued / Items / Payment / Delivery are centred in their columns');
      assert.ok(/\.order-invoice-meta-payment \{ white-space: nowrap; \}/.test(css),
        'the payment value cannot break after "Cash on"');
      assert.ok(/className="order-invoice-meta-payment"/.test(cartPage),
        'the payment value opts into the nowrap rule');
    });

    await step('a discount is rose, never green, on every surface', () => {
      assert.ok(/\.checkout-total-row \.is-credit \{ color: #e0806b; \}/.test(css),
        'the checkout discount uses the rose tone');
      assert.ok(/\.order-invoice-totals \.is-credit \{ color: #e0806b; \}/.test(css),
        'the invoice discount uses the rose tone');
      assert.ok(/\.track-discount,\s*\.track-discount > span:last-child \{ color: #e0806b; \}/.test(css),
        'the tracking discount uses the rose tone');
      assert.ok(!/\.order-invoice-totals \.is-credit \{ color: #9fbd91/.test(css),
        'no green discount colour is left behind');
    });

    await step('the tracking page shares the receipt styling and stacks on a phone', () => {
      assert.ok(/className="track-page"/.test(track) && /className="track-timeline"/.test(track),
        'the tracking page is class-driven instead of ad-hoc inline styles');
      assert.ok(!/fontFamily: 'sans-serif'/.test(track),
        'the page uses the brand font stack');
      assert.ok(/\.track-timeline \{[\s\S]{0,400}?flex-direction: column/.test(css),
        'the timeline becomes a vertical rail on a phone');
      assert.ok(/\.track-step:not\(:last-child\)::before/.test(css),
        'the vertical rail is drawn between the stacked steps');
      assert.ok(/\.track-page \{[\s\S]{0,200}?box-sizing: border-box/.test(css),
        'the page box includes its padding, so it cannot overflow at 320px');
    });

    await step('the two long tracking explanations are gone but the secure-link rule remains', () => {
      assert.ok(!/Open the secure tracking link sent with your order confirmation/.test(track),
        'the first unread tracking paragraph is removed');
      assert.ok(!/An order number alone cannot be looked up for privacy reasons/.test(track),
        'the second unread tracking paragraph is removed');
      assert.ok(/A secure tracking link is required\./.test(track),
        'the actionable security notice is kept where it belongs');
    });

    await step('the full bag has exactly one Continue shopping control', () => {
      const labels = (cartPage.match(/Continue [Ss]hopping/g) || []).length;
      assert.ok(labels === 1, 'only the arrow-back Continue shopping control remains');
      assert.ok(/className="bag-continue"[\s\S]{0,160}?<ArrowLeft/.test(cartPage),
        'the surviving control is the arrow-back button in the cart list');
      assert.ok(!/bag-shop-btn/.test(cartPage + css),
        'the duplicate outline button and its CSS are removed');
    });

    await step('the purchase CTAs share one restrained metal finish', () => {
      const shared = (css.match(/\.bag-checkout-btn,\s*\n\.checkout-place-order \{[^}]*\}/) || [])[0] || '';
      assert.ok(/linear-gradient\(135deg, #9a7a2e 0%, #c9a84c 44%, #f0d894 100%\)/.test(shared),
        'both buttons get the same deep-to-pale gold bar');
      assert.ok(/inset 0 1px 0 rgba\(255, 255, 255, 0\.34\)/.test(shared),
        'a fine top light gives the bar depth without a filter');
      assert.ok(/\.bag-checkout-btn:hover,[\s\S]{0,220}?transform: translateY\(-1px\)/.test(css),
        'hover is a single-pixel lift, not a growing glow');
    });

    await step('the receipt ends on the same canvas as the footer', () => {
      assert.ok(/\.order-confirmation-page \{ background: transparent; \}/.test(css),
        'the confirmation inherits the page canvas');
      assert.ok(!/radial-gradient\(ellipse at 50% 0%, rgba\(201,168,76,0\.12\), transparent 42%\), #080808/.test(cartPage),
        'the local wash that drew a rectangle above the footer is gone');
    });

    await step('the hero wordmark is struck in richer gold', () => {
      const heroLetter = (css.match(/\.hero-brand-letter \{[\s\S]*?\n\}/) || [])[0] || '';
      assert.ok(/#fff0c4 50%/.test(heroLetter) && /#e9c976 58%/.test(heroLetter),
        'the centre of the wordmark carries a pale champagne highlight');
      assert.ok(/@keyframes hero-brand-letter-glint \{[^}]*0%, 100% \{ opacity: 0\.08; \}/.test(css),
        'the band rests at a quiet gold warmth between passes');
    });

    await step('route changes land at the top without a stale page fading above', () => {
      const app = read('src/App.js');
      const store = read('src/store.js');
      assert.ok(!/AnimatePresence/.test(app),
        'the page-level AnimatePresence that held the old page for 380ms is gone');
      assert.ok(!/exit=\{\{ opacity: 0 \}\}/.test(app),
        'no page exit keeps the previous route mounted');
      assert.ok(/window\.scrollTo\(0, 0\)/.test(app) && /window\.scrollTo\(0, 0\)/.test(store),
        'scroll is reset both in the store action and on the committed route');
    });

    await step('leaving the bag for checkout or the cart keeps the new page at the top', () => {
      const drawer = read('src/components/shop/CartDrawer.js');
      assert.ok(/leaveAtTopRef\.current = true;\s*setCartOpen\(false\);\s*setPage\(page\);/.test(drawer),
        'navigation out of the drawer marks the close as a page change');
      assert.ok(/const restoreY = leaveAtTopRef\.current \? 0 : scrollY;/.test(drawer)
        && /window\.scrollTo\(0, restoreY\)/.test(drawer)
        && /requestAnimationFrame\?\.\(\(\) => window\.scrollTo\(0, restoreY\)\)/.test(drawer),
        'the scroll restore honours the flag on both the immediate and deferred reset');
      assert.ok(/onClick=\{\(\) => goToPage\('checkout'\)\}/.test(drawer)
        && /onClick=\{\(\) => goToPage\('cart'\)\}/.test(drawer),
        'both checkout and view-full-cart leave through the flagged navigation');
      assert.ok(!/setCartOpen\(false\); setPage\('checkout'\)/.test(drawer)
        && !/setCartOpen\(false\); setPage\('cart'\)/.test(drawer),
        'no navigation button bypasses the flagged helper');
    });

    await step('size guides leave as quietly as they arrive', () => {
      const productSource = read('src/pages/ProductPage.js');
      assert.ok(/className="size-guide-overlay"[\s\S]{0,220}?exit=\{\{ opacity: 0 \}\}/.test(productSource),
        'the size-guide scrim now fades through AnimatePresence');
      assert.ok(!/scale: 0\.96, y: 24/.test(productSource),
        'the modal no longer scales and slides out');
      assert.ok(!/backdrop-filter: blur\(10px\)/.test(css.slice(css.indexOf('.size-guide-overlay'), css.indexOf('.size-guide-modal'))),
        'the size-guide scrim does not resample the page on exit');
      assert.ok(!/scale: 0\.985/.test(read('src/components/shop/SizeFinder.js')),
        'the size finder fades without a scale transform');
    });
  }

  console.log('\n[14] low-priority UX: reduced motion, deferred card frame, idle preload, OG cache');
  {
    const product = read('src/pages/ProductPage.js');
    const card = read('src/components/shop/ProductCard.js');
    const app = read('src/App.js');
    const css = read('src/index.css');

    const downBody = product.slice(
      product.indexOf('const handleImagePointerDown = (event) => {'),
      product.indexOf('const handleImagePointerMove = (event) => {')
    );
    const moveBody = product.slice(
      product.indexOf('const handleImagePointerMove = (event) => {'),
      product.indexOf('const handleImagePointerUp = (event) => {')
    );
    const upBody = product.slice(
      product.indexOf('const handleImagePointerUp = (event) => {'),
      product.indexOf('const handleImagePointerCancel = (event) => {')
    );

    await step('a reduced-motion gallery never drifts but still swipes', () => {
      assert.ok(/import \{ motion, AnimatePresence, useMotionValue, useSpring, useReducedMotion \} from 'framer-motion'/.test(product),
        'useReducedMotion is imported from the existing motion dependency');
      assert.ok(/const reduceMotion = useReducedMotion\(\);/.test(product), 'the preference is read in the page');
      const guardAt = moveBody.indexOf('if (reduceMotion) return;');
      const setAt = moveBody.indexOf('galleryDragX.set(');
      assert.ok(guardAt > 0 && setAt > guardAt,
        'the guard sits before the imperative drift, so no pointer move moves the plate');
      assert.ok(/style=\{\{ x: reduceMotion \? 0 : galleryPlateX \}\}/.test(product),
        'the plate reads a fixed zero instead of the spring when motion is reduced');
      assert.ok(/transition: reduceMotion \? 'none' : 'transform 550ms cubic-bezier\(0\.45, 0, 0\.2, 1\)'/.test(product),
        'the sideways slide is instant when motion is reduced');
      assert.ok(!/reduceMotion/.test(upBody) && /changeImage\(deltaX < 0 \? 1 : -1\)/.test(upBody),
        'swipe-to-advance is decided on release, unaffected by the preference');
      assert.ok(downBody.includes('if (imageSwipeStartRef.current) return;') &&
        /start\.pointerId !== event\.pointerId/.test(upBody),
        'the one-finger ownership fix is untouched');
      assert.ok(/useSpring\(galleryDragX, \{[\s\S]{0,120}?stiffness: 190, damping: 30, mass: 0\.9, restDelta: 0\.4/.test(product),
        'the soft spring is still used for everyone else');
      const reducedBlock = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)]
        .map((match) => css.slice(match.index, css.indexOf('\n}', match.index) + 2))
        .find((block) => /\.product-gallery-frames/.test(block)) || '';
      assert.ok(/\.product-gallery-frames \{\s*will-change: auto;\s*\}/.test(reducedBlock),
        'the reduced-motion block drops the plate layer');
      assert.ok(/\.product-gallery-track \{\s*will-change: auto;\s*\}/.test(reducedBlock),
        'the reduced-motion block drops the sliding strip layer too');
    });

    await step('a card defers its second Supabase photo until first hover', () => {
      assert.ok(/const \[secondaryRequested, setSecondaryRequested\] = useState\(false\)/.test(card),
        'the deferred source starts unrequested');
      assert.ok(/const handleImageEnter = \(\) => \{[\s\S]{0,240}?setSecondaryRequested\(true\)/.test(card),
        'first pointer entry requests the source');
      assert.ok(/onMouseEnter=\{handleImageEnter\}/.test(card),
        'the image box uses the deferring handler');
      assert.ok(/src=\{secondaryRequested \? secondary\.src : FALLBACK_IMAGE\}/.test(card),
        'the Supabase URL is withheld until then');
      assert.ok(!/src=\{secondary\.src\}/.test(card), 'no unconditional secondary source remains');
      assert.ok(/const secondary = useImageFallback\(images\[1\] \|\| FALLBACK_IMAGE, FALLBACK_IMAGE\)/.test(card) &&
        /onError=\{secondary\.onError\}/.test(card),
        'the original mirror -> placeholder fallback chain is preserved');
      assert.ok(/\{hasSecondImage && \(\s*<img/.test(card), 'the second frame stays mounted when eligible');
      assert.ok(/const showSecond = hovered && hasSecondImage && secondaryLoaded/.test(card) &&
        /onLoad=\{\(\) => setSecondaryLoaded\(true\)\}/.test(card) &&
        /data-visible=\{showSecond \? 'true' : 'false'\}/.test(card),
        'the mounted second frame still crossfades, only after the real image lands');
    });

    await step('idle preload only warms likely next routes in genuine idle time', () => {
      assert.ok(/const IDLE_PRELOAD_NEXT = \{/.test(app), 'a per-route map replaces the load-everything list');
      assert.ok(!/PUBLIC_PAGE_LOADERS/.test(app), 'the all-public-pages list is gone');
      assert.ok(/home: \[loadShopPage\]/.test(app) &&
        /shop: \[loadProductPage, loadCartPage\]/.test(app) &&
        /product: \[loadCartPage, loadShopPage\]/.test(app),
        'home, shop and product warm only their likely next chunks');
      assert.ok(/const next = IDLE_PRELOAD_NEXT\[currentPage\] \|\| \[\];/.test(app),
        'the map is keyed by the current route');
      assert.ok(/if \(next\.length === 0 \|\| typeof window\.requestIdleCallback !== 'function'\) return undefined;/.test(app),
        'no timer fallback runs outside idle time');
      assert.ok(/requestIdleCallback\(preload\)/.test(app) && !/timeout: 2000/.test(app),
        'no aggressive deadline forces a download');
      assert.ok(/connection\?\.saveData \|\| \['slow-2g', '2g'\]\.includes\(connection\?\.effectiveType\)/.test(app),
        'the saveData / slow-link guard is intact');
      assert.ok(/loadPage\(\)\.catch\(\(error\) => console\.error\('Storefront page preload failed:', error\)\)/.test(app),
        'a failed preload is still caught');
      assert.ok(/\}, \[currentPage\]\);/.test(app), 'the effect re-evaluates on navigation');
    });

    await step('lazy routes still own every page chunk', () => {
      const loaders = ['loadHomePage', 'loadShopPage', 'loadProductPage', 'loadTrackOrderPage',
        'loadCartPage', 'loadAdminPage', 'loadNotFoundPage'];
      for (const loader of loaders) {
        assert.ok(app.includes(`const ${loader} =`), `${loader} is still a lazy chunk loader`);
      }
      const pages = ['home', 'shop', 'product', 'cart', 'checkout', 'wishlist', 'track', 'notfound'];
      for (const page of pages) {
        assert.ok(app.includes(`currentPage === '${page}' &&`), `${page} still renders through its lazy chunk`);
      }
      assert.ok(app.includes("currentPage === 'admin' ?"), 'admin still has its own lazy branch');
    });

    await step('/og-image.jpg has a refreshable, non-immutable cache rule', () => {
      const config = JSON.parse(read('vercel.json'));
      const rule = (config.headers || []).find((entry) => entry.source === '/og-image.jpg');
      assert.ok(rule, 'a dedicated header rule exists for the social image');
      const header = (rule.headers || []).find((entry) => String(entry.key).toLowerCase() === 'cache-control');
      assert.ok(header, 'the rule sets Cache-Control');
      assert.equal(header.value, 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');
      assert.ok(!/immutable/.test(header.value), 'a replaceable image is never marked immutable');
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
