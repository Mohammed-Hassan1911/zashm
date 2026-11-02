import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { JSDOM } from 'jsdom';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const envDir = await mkdtemp(path.join(tmpdir(), 'zashm-admin-test-env-'));
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
});

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
globalThis.AbortController = dom.window.AbortController;
globalThis.AbortSignal = dom.window.AbortSignal;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storeMock = `
  import React from 'react';
  const product = {
    id: 'test-product', name: 'Isolated Test Product', category: 'Test',
    price: 100, stock: 5, variantStock: {}, sizes: [], colors: [],
    images: [], sku: 'TEST-001', active: true,
  };
  let state;
  const listeners = new Set();
  const refresh = () => {};
  const addProduct = () => { globalThis.__zashmAdminTest.addProductCalls += 1; };
  const updateProduct = () => {};
  const deleteProduct = () => {};
  const setAdminPage = (adminPage) => {
    if (state.adminPage === adminPage) return;
    state = { ...state, adminPage };
    for (const listener of listeners) listener();
  };
  const initialState = () => ({
    adminPage: 'dashboard',
    setAdminPage,
    setPage: () => {},
    orders: [],
    products: [product],
    adminProducts: [product],
    productsLoading: false,
    productsLoadStatus: 'success',
    productsError: null,
    adminProductsLoading: false,
    adminProductsLoadStatus: 'success',
    adminProductsError: null,
    ordersLoading: false,
    ordersError: null,
    unreadOrderCount: 0,
    newOrderNotification: null,
    markNotificationsRead: () => {},
    getNotifications: () => [],
    refreshOrders: refresh,
    refreshDiscounts: refresh,
    refreshProducts: refresh,
    refreshAdminProducts: refresh,
    addProduct,
    updateProduct,
    deleteProduct,
    bulkDeleteProducts: refresh,
  });
  state = initialState();
  globalThis.__zashmAdminTest = { addProductCalls: 0 };
  function useStore() {
    return React.useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      () => state,
      () => state,
    );
  }
  useStore.setState = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    for (const listener of listeners) listener();
  };
  export { useStore };
`;

const mockSources = new Map([
  ['../store', storeMock],
  ['../lib/auth', `
    export function useAuth() {
      return {
        session: { userId: 'isolated-admin', name: 'Test Admin', role: 'admin' },
        logout: () => {},
        canAccess: () => true,
        loading: false,
      };
    }
  `],
  ['../lib/security', `
    export const setPageMeta = () => {};
    export const sanitizeInput = (value) => value;
    export const validateProductForm = () => ({ valid: true, errors: {} });
    export const paginate = (items, page, perPage) => ({
      items: items.slice((page - 1) * perPage, page * perPage),
      page,
      total: items.length,
      totalPages: Math.max(1, Math.ceil(items.length / perPage)),
      hasPrev: page > 1,
      hasNext: page * perPage < items.length,
    });
  `],
  ['../lib/analytics', `
    export const RANGE_OPTIONS = [{ key: '7d', labelAr: '7 أيام', labelEn: '7 days' }];
    export const fmtEGP = (value) => String(value ?? 0);
    export const compactEGP = (value) => String(value ?? 0);
    export const computeSalesOverview = () => ({
      orderCount: 0, totalValue: 0, deliveredSales: 0, deliveredCount: 0,
      pendingValue: 0, pendingCount: 0, shippedValue: 0, aov: 0,
      cancelledValue: 0, cancelledCount: 0, totalDeltaPct: null,
      orderDeltaPct: null, series: [],
    });
    export const classifyInventory = () => ({
      outOfStock: [], lowStock: [], variantOutOfStock: [], variantLowStock: [],
      productStock: [],
    });
    export const computeAnalyticsReport = () => ({});
  `],
  ['../components/admin/AdminLogin', 'export default function AdminLogin() { return null; }'],
  ['../components/admin/ImageUploader', `
    export default function ImageUploader() { return null; }
    export const storagePathFromUrl = () => null;
  `],
  ['../components/admin/CSVImport', 'export default function CSVImport() { return null; }'],
  ['../components/admin/UsersPanel', 'export default function UsersPanel() { return null; }'],
  ['../lib/api', 'export const deleteStorageFile = async () => ({});'],
  ['../components/ui/BackToTop', 'export const toast = { error() {}, success() {} };'],
  ['recharts', `
    import React from 'react';
    const Container = ({ children }) => React.createElement('div', null, children);
    export const ComposedChart = Container;
    export const Bar = () => null;
    export const XAxis = () => null;
    export const YAxis = () => null;
    export const CartesianGrid = () => null;
    export const Tooltip = () => null;
    export const ResponsiveContainer = Container;
    export const Area = () => null;
    export const Legend = () => null;
  `],
  ['framer-motion', `
    import React from 'react';
    const omit = new Set([
      'initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap',
      'whileInView', 'layout', 'layoutId', 'variants', 'drag',
    ]);
    export const motion = new Proxy({}, {
      get(_target, tag) {
        return React.forwardRef(({ children, ...props }, ref) => {
          for (const key of omit) delete props[key];
          return React.createElement(tag, { ...props, ref }, children);
        });
      },
    });
    export const AnimatePresence = ({ children }) => React.createElement(React.Fragment, null, children);
  `],
]);

const mocksPlugin = {
  name: 'admin-ui-test-mocks',
  enforce: 'pre',
  resolveId(source) {
    if (!mockSources.has(source)) return null;
    return `\0admin-test:${source}`;
  },
  load(id) {
    if (!id.startsWith('\0admin-test:')) return null;
    return mockSources.get(id.slice('\0admin-test:'.length));
  },
};

let server;
let rootNode;
let reactRoot;

function buttonByText(text) {
  const button = [...document.querySelectorAll('button')]
    .find((item) => item.textContent.trim() === text);
  assert.ok(button, `expected button "${text}" to be rendered`);
  return button;
}

async function click(element) {
  const { act } = await import('react');
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

function pageHeading() {
  return document.querySelector('main h1')?.textContent.trim();
}

try {
  server = await createServer({
    configFile: false,
    root,
    envDir,
    plugins: [react(), mocksPlugin],
    esbuild: {
      loader: 'jsx',
      include: /src\/.*\.js$/,
      exclude: [],
    },
    optimizeDeps: { noDiscovery: true, entries: [] },
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });

  const { default: AdminApp } = await server.ssrLoadModule('/src/pages/AdminApp.js');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  rootNode = document.getElementById('root');
  reactRoot = createRoot(rootNode);

  console.log('\n[1] dashboard to products navigation');
  await act(async () => reactRoot.render(React.createElement(AdminApp)));
  assert.equal(pageHeading(), 'dashboard');
  const adminContainer = document.querySelector('.admin-container');
  const adminMain = document.querySelector('main');
  const adminContent = adminMain?.firstElementChild?.nextElementSibling;
  assert.ok(adminContainer, 'the admin layout is a viewport-bounded container');
  assert.equal(adminContainer.style.minHeight, '0');
  assert.equal(adminMain?.style.minHeight, '0');
  assert.equal(adminContent?.style.minHeight, '0');
  assert.equal(adminContent?.style.overflowY, 'auto');
  assert.ok(document.body.textContent.includes('Overview ·'));
  await click(buttonByText('Products'));
  assert.equal(pageHeading(), 'products');
  assert.ok(document.querySelector('input[placeholder="Search products..."]'));
  assert.ok(document.body.textContent.includes('Isolated Test Product'));
  assert.ok(!document.body.textContent.includes('Overview ·'));
  console.log('  PASS dashboard → products displays the products panel');

  console.log('\n[2] products to orders navigation');
  await click(buttonByText('Orders'));
  assert.equal(pageHeading(), 'orders');
  assert.ok(document.querySelector('input[placeholder="Search..."]'));
  assert.ok(!document.querySelector('input[placeholder="Search products..."]'));
  console.log('  PASS orders heading and content update together');

  console.log('\n[3] return to dashboard');
  await click(buttonByText('Dashboard'));
  assert.equal(pageHeading(), 'dashboard');
  assert.ok(document.body.textContent.includes('Overview ·'));
  console.log('  PASS dashboard content is restored');

  console.log('\n[4] dashboard opens the new-product form without creating a product');
  await click(buttonByText('إضافة منتج'));
  assert.equal(pageHeading(), 'products');
  assert.ok(document.querySelector('[role="dialog"][aria-label="New Product"]'));
  assert.equal(globalThis.__zashmAdminTest.addProductCalls, 0);
  console.log('  PASS add-product opens the form and does not create a product');

  console.log('\n[5] close and reopen the form from the products page');
  await click(buttonByText('Cancel'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await click(buttonByText('Add Product'));
  assert.ok(document.querySelector('[role="dialog"][aria-label="New Product"]'));
  assert.equal(globalThis.__zashmAdminTest.addProductCalls, 0);
  console.log('  PASS form closes and reopens without a create request');
  console.log('\nadmin-navigation: 5 passed, 0 failed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (reactRoot) {
    const { act } = await import('react');
    await act(async () => reactRoot.unmount());
  }
  if (server) await server.close();
  dom.window.close();
  await rm(envDir, { recursive: true, force: true });
}
