/**
 * Admin async-state + dialog keyboard regressions.
 *
 *   node scripts/test-admin-dialog-state-fixes.mjs
 *
 * Static assertions for six concrete bugs:
 *   1. OrdersPanel showed "No orders yet" even when /api/admin/orders failed.
 *   2. AnalyticsPanel showed zero KPIs / "No data" during load and after errors.
 *   3. The order editor let Escape unmount it while a save was in flight.
 *   4. The terminal-status confirmation focused the destructive action first.
 *   5. The mobile navigation drawer was not a keyboard-modal dialog.
 *   6. useAdminDialog could not restore focus to an explicit trigger ref.
 *
 * No dependencies, no network, no database, no production data.
 */
import { readFileSync } from 'node:fs';

const source = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const admin = source('../src/pages/AdminApp.js');
const hook = source('../src/components/admin/useAdminDialog.js');

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
function section(n, title) { console.log(`[${n}] ${title}`); }
function between(text, start, end) {
  const from = text.indexOf(start);
  if (from < 0) return '';
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? '' : text.slice(from, to);
}

const root = between(admin, 'export default function AdminApp()', '// ─── DASHBOARD');
const orderEdit = between(admin, 'function OrderEditModal(', 'function OrdersPanel(');
const ordersPanel = between(admin, 'function OrdersPanel(', 'function parseOptionList(');
const analytics = between(admin, 'function AnalyticsPanel()', 'function ReviewsPanel(');

// ─── 1. OrdersPanel: failure/loading before empty state ──────────────────────
section(1, 'OrdersPanel consumes load/error state before the empty row');
ok(ordersPanel.length > 0, 'OrdersPanel source extracted');
const ordersHead = between(ordersPanel, 'const {', 'const [ordersAttempted');
ok(/\bordersLoading\b/.test(ordersHead), 'OrdersPanel subscribes to ordersLoading');
ok(/\bordersError\b/.test(ordersHead), 'OrdersPanel subscribes to ordersError');
ok(/\brefreshOrders\b/.test(ordersHead), 'OrdersPanel subscribes to refreshOrders');
ok(/Promise\.resolve\(refreshOrders\(\)\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ if \(!cancelled\) setOrdersAttempted\(true\); \}\)/.test(ordersPanel), 'full snapshot load marks a settled attempt without unhandled rejections');
ok(/const ordersFailed = Boolean\(ordersError\) \|\| ordersLiveStatus === 'unauthorized'/.test(ordersPanel), 'failure includes API error and unauthorized statuses');
ok(/const showOrderError = !ordersLoading && ordersFailed/.test(ordersPanel), 'error banner waits for the in-flight load to settle');
ok(/const ordersReady = ordersAttempted && !ordersLoading && !ordersFailed/.test(ordersPanel), 'empty state requires a settled successful load');
const orderBanner = between(ordersPanel, '{showOrderError && (', '{!ordersReady && !showOrderError');
ok(/role="alert"/.test(orderBanner), 'orders failure is announced as an alert');
ok(/Could not load orders — \{ordersError \|\|/.test(orderBanner), 'orders error message comes from the store');
ok(/onClick=\{refreshOrders\}/.test(orderBanner), 'orders error offers a Retry wired to refreshOrders');
ok(/>Retry</.test(orderBanner.replace(/\s+/g, '')), 'orders error Retry is a labelled button');
ok(/role="status"[\s\S]{0,100}Loading orders…/.test(ordersPanel), 'pending orders state is announced');
ok(/\{paginated\.items\.length === 0 && ordersReady && \(/.test(ordersPanel), 'empty row is gated on settled success');
const emptyRow = between(ordersPanel, 'paginated.items.length === 0 && ordersReady', '{paginated.items.map');
ok(/'No orders yet'/.test(emptyRow), 'No orders yet only exists inside the empty gate');
ok(/'No matching orders'/.test(emptyRow), 'No matching orders only exists inside the empty gate');
eq((ordersPanel.match(/No orders yet/g) || []).length, 1, 'No orders yet appears once in OrdersPanel');
eq((ordersPanel.match(/No matching orders/g) || []).length, 1, 'No matching orders appears once in OrdersPanel');
ok(ordersPanel.indexOf('{showOrderError && (') < ordersPanel.indexOf('No orders yet'), 'error banner precedes empty copy');

// ─── 2. AnalyticsPanel: no zero KPIs during load or after failure ────────────
section(2, 'AnalyticsPanel gates KPIs and charts on both loaded snapshots');
ok(analytics.length > 0, 'AnalyticsPanel source extracted');
const analyticsHead = between(analytics, 'const {', 'const [analyticsAttempted');
ok(/\brefreshOrders\b/.test(analyticsHead), 'AnalyticsPanel subscribes to refreshOrders');
ok(/\bordersLoading\b/.test(analyticsHead), 'AnalyticsPanel subscribes to ordersLoading');
ok(/\bordersError\b/.test(analyticsHead), 'AnalyticsPanel subscribes to ordersError');
ok(/\brefreshProducts\b/.test(analyticsHead), 'AnalyticsPanel subscribes to refreshProducts');
ok(/\bproductsLoadStatus\b/.test(analyticsHead), 'AnalyticsPanel subscribes to productsLoadStatus');
ok(/Promise\.all\(\[refreshProducts\(\), refreshOrders\(\)\]\)\s*\.catch\(\(\) => \{\}\)\s*\.finally\(\(\) => \{ if \(!cancelled\) setAnalyticsAttempted\(true\); \}\)/.test(analytics), 'both refreshes are awaited before data is trusted, with rejections handled');
ok(/const ordersFailed = Boolean\(ordersError\) \|\| ordersLiveStatus === 'unauthorized'/.test(analytics), 'analytics detects orders failure');
ok(/const productsFailed = productsLoadStatus === 'error'/.test(analytics), 'analytics detects products failure via productsLoadStatus');
ok(/const analyticsLoading = !analyticsAttempted \|\| ordersLoading[\s\S]{0,120}productsLoadStatus === 'idle'/.test(analytics), 'analytics loading covers idle/in-flight loads');
ok(/const showAnalyticsError = !analyticsLoading && \(ordersFailed \|\| productsFailed\)/.test(analytics), 'analytics error only after loading settles');
ok(/\{analyticsLoading \? \(\s*<div role="status"[\s\S]{0,300}Loading orders and products…/.test(analytics), 'analytics loading state is announced before KPIs');
const analyticsError = between(analytics, ': showAnalyticsError ? (', ') : (\n        <>');
ok(/role="alert"/.test(analyticsError), 'analytics failure state is announced');
ok(/Could not load orders — \{ordersError \|\|/.test(analyticsError), 'analytics shows the orders error');
ok(/Could not load products — \{productsError \|\|/.test(analyticsError), 'analytics shows the products error');
ok(/onClick=\{refreshOrders\}/.test(analyticsError), 'analytics orders Retry calls refreshOrders');
ok(/onClick=\{refreshProducts\}/.test(analyticsError), 'analytics products Retry calls refreshProducts');
eq((analyticsError.match(/>Retry</g) || []).length, 2, 'both analytics failures have a Retry button');
ok(analytics.indexOf('analyticsLoading ? (') < analytics.indexOf('{kpis.map'), 'loading/error branch precedes the KPI grid');
ok(analytics.indexOf(') : (\n        <>') < analytics.indexOf('{kpis.map'), 'KPI grid is inside the success branch');
ok(/<\/>\s*\)\}\s*<\/div>/.test(analytics), 'success branch is closed after the charts');

// ─── 3. Order editor: Escape disabled while saving ──────────────────────────
section(3, 'Order editor blocks Escape during a save');
ok(orderEdit.length > 0, 'OrderEditModal source extracted');
ok(/const \[saving, setSaving\] = useState\(false\);/.test(orderEdit), 'order editor has a saving state');
ok(orderEdit.indexOf('const [saving, setSaving]') < orderEdit.indexOf('useAdminDialog('), 'saving state is declared before the dialog hook');
ok(/useAdminDialog\(\{ onClose, disabled: saving \}\)/.test(orderEdit), 'dialog receives disabled: saving');
ok(!/disabled:\s*false/.test(orderEdit), 'order editor no longer hard-codes disabled: false');
ok(/onClick=\{saving \? undefined : onClose\}/.test(orderEdit), 'backdrop close remains guarded while saving');

// ─── 4. Terminal status confirm: safe button takes initial focus ─────────────
section(4, 'Destructive status confirmation focuses the safe action');
ok(/const statusKeepRef = useRef\(null\);/.test(ordersPanel), 'status dialog has an explicit safe-action ref');
ok(/useAdminDialog\(\{[^\n]*disabled: statusSaving, initialFocusRef: statusKeepRef[^\n]*\}\)/.test(ordersPanel), 'status dialog passes initialFocusRef to the shared hook');
const confirmBlock = between(ordersPanel, '{statusConfirm && (', '{selected && (');
ok(confirmBlock.length > 0, 'status confirmation markup extracted');
const keepButton = between(confirmBlock, 'ref={statusKeepRef}', '</button>');
ok(/Keep as is/.test(keepButton), 'initialFocusRef is attached to Keep as is');
ok(confirmBlock.indexOf('Yes, mark') < confirmBlock.indexOf('ref={statusKeepRef}'), 'visual order still puts confirmation first');
ok(!/autoFocus/.test(confirmBlock), 'no autoFocus overrides the dialog hook focus target');

// ─── 5. Admin mobile drawer: keyboard-modal ──────────────────────────────────
section(5, 'Admin mobile navigation drawer is a keyboard modal');
ok(root.length > 0, 'AdminApp root source extracted');
ok(/const mobileMenuTriggerRef = useRef\(null\);/.test(root), 'menu trigger ref captured for focus restore');
ok(/const mobileMenuDialog = useAdminDialog\(\{[\s\S]{0,200}open: mobileMenuOpen[\s\S]{0,200}openerRef: mobileMenuTriggerRef[\s\S]{0,80}\}\);/.test(root), 'drawer uses the shared dialog hook with the trigger as opener');
ok(/ref=\{mobileMenuTriggerRef\}/.test(root), 'menu button holds the opener ref');
const drawer = between(root, '{mobileMenuOpen && (', '</AnimatePresence>');
ok(drawer.length > 0, 'drawer markup extracted');
ok(/\{\.\.\.mobileMenuDialog\.dialogProps\}/.test(drawer), 'drawer receives role/aria-modal and focus trap from dialogProps');
ok(/aria-label="Navigation menu"/.test(drawer), 'dialog has an accessible name');
ok(/initial=\{\{ x: '-100%' \}\} animate=\{\{ x: 0 \}\} exit=\{\{ x: '-100%' \}\}/.test(drawer), 'drawer animation unchanged');
ok(/<SidebarContent isMobile=\{true\}/.test(drawer), 'drawer content unchanged');

// ─── 6. Hook contract retained and extended ─────────────────────────────────
section(6, 'useAdminDialog supports openerRef without weakening Escape/focus');
ok(/export function useAdminDialog\(\{ open = true, onClose, disabled = false, initialFocusRef, openerRef \} = \{\}\)/.test(hook), 'hook accepts openerRef with existing defaults');
ok(/const opener = \(openerRef && openerRef\.current\) \|\| document\.activeElement;/.test(hook), 'explicit opener ref wins, existing behaviour is the fallback');
ok(/const firstTarget = \(initialFocusRef && initialFocusRef\.current\) \|\| focusable\(\)\[0\] \|\| root;/.test(hook), 'initialFocusRef still controls first focus');
ok(/if \(!disabledRef\.current && typeof closeRef\.current === 'function'\) closeRef\.current\(\);/.test(hook), 'disabled still blocks Escape');
ok(/if \(opener && typeof opener\.focus === 'function' && document\.contains\(opener\)\) opener\.focus\(\);/.test(hook), 'focus is still restored on close');
ok(/role: 'dialog', 'aria-modal': 'true'/.test(hook), 'dialog semantics retained');
ok(/\}, \[open, initialFocusRef, openerRef\]\);/.test(hook), 'hook re-runs when openerRef changes');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
