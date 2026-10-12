/** Derived analytics — computed from orders, never stored in state.
 *
 * Conventions:
 *  - "Total Order Value" = sum of `total` of every non-cancelled order
 *    (Pending/Confirmed/Processing/Shipped/Delivered). It is an order-VALUE
 *    metric, NOT collected cash — this is a COD store and payment collection
 *    is not tracked.
 *  - "Delivered Sales" = sum of `total` where status === 'Delivered'.
 *  - Order `date` is a 'YYYY-MM-DD' wall-date string (written by the browser
 *    in shop-local time). All day bucketing matches those strings using the
 *    Africa/Cairo timezone so midnight/day boundaries are handled correctly
 *    regardless of the viewer's clock.
 *  - Malformed totals are clamped to >= 0; malformed dates fall back to the
 *    order created timestamp, then to today (documented limitation).
 */

export const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

// Statuses considered "awaiting confirmation / processing" for the Pending metric.
export const IN_FULFILLMENT_STATUSES = ['Pending', 'Confirmed', 'Processing'];

export const CAIRO_TZ = 'Africa/Cairo';

// ─── NUMBER & DATE SAFETY ─────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function utcYMD(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function cairoYMD(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => (p.find((x) => x.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Wall-date (YYYY-MM-DD) in Egypt regardless of the runtime clock. */
export function todayCairoStr(now = new Date()) {
  return cairoYMD(now);
}

/** Shift a YYYY-MM-DD wall date by whole days (integer) → YYYY-MM-DD. */
export function cairoDatePlus(dateStr, delta) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return utcYMD(new Date(Date.UTC(y, m - 1, d + delta, 12)));
}

/** Normalise any order/date field into a YYYY-MM-DD wall date in Egypt. */
export function orderDateKey(order, now = new Date()) {
  const raw = order && (order.date || order.timestamps?.created);
  if (raw === undefined || raw === null) return todayCairoStr(now);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '') return todayCairoStr(now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const t = new Date(s);
    if (!Number.isFinite(t.getTime())) return todayCairoStr(now);
    return cairoYMD(t);
  }
  const t = new Date(Number(raw) || 0);
  if (!Number.isFinite(t.getTime())) return todayCairoStr(now);
  return cairoYMD(t);
}

// ─── RANGES ───────────────────────────────────────────────────────────────────

export const RANGE_OPTIONS = [
  { key: 'today', labelEn: 'Today', labelAr: 'اليوم' },
  { key: '7d', labelEn: 'Last 7 days', labelAr: 'آخر 7 أيام' },
  { key: '30d', labelEn: 'Last 30 days', labelAr: 'آخر 30 يوم' },
  { key: 'month', labelEn: 'This month', labelAr: 'هذا الشهر' },
  { key: 'all', labelEn: 'All time', labelAr: 'كل الفترة' },
];

const RANGE_DAYS = { '7d': 7, '30d': 30 };

function rangeStartDate(rangeKey, now) {
  const today = todayCairoStr(now);
  if (rangeKey === 'today' || rangeKey === '7d' || rangeKey === '30d') {
    return cairoDatePlus(today, -1 * Math.max(0, (RANGE_DAYS[rangeKey] || 1) - 1));
  }
  if (rangeKey === 'month') return `${today.slice(0, 7)}-01`;
  return null; // 'all'
}

function previousPeriod(rangeKey, now) {
  const today = todayCairoStr(now);
  const days = RANGE_DAYS[rangeKey];
  if (rangeKey === 'today') {
    return { start: cairoDatePlus(today, -1), end: cairoDatePlus(today, -1), label: 'Yesterday' };
  }
  if (rangeKey === '7d' || rangeKey === '30d') {
    const curStart = rangeStartDate(rangeKey, now);
    return { start: cairoDatePlus(curStart, -days), end: cairoDatePlus(curStart, -1), label: 'previous' };
  }
  if (rangeKey === 'month') {
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const end = cairoDatePlus(firstOfMonth, -1);
    const [y, m] = today.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, 12));
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const start = utcYMD(prev).slice(0, 7).concat('-01');
    return { start, end, label: 'previous month' };
  }
  return null; // 'all' has no comparable previous period
}

function dateInRange(key, start, end) {
  if (!start || !end) return false;
  return key >= start && key <= end;
}

export function orderInRange(order, rangeKey, now = new Date()) {
  const today = todayCairoStr(now);
  const key = orderDateKey(order, now);
  if (rangeKey === 'all') return true;
  if (rangeKey === 'month') return key.slice(0, 7) === today.slice(0, 7) && key <= today;
  const start = rangeStartDate(rangeKey, now);
  const end = today;
  return dateInRange(key, start, end);
}

// ─── AGGREGATION ──────────────────────────────────────────────────────────────

function summarizeOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const orderCount = list.length;
  const cancelled = list.filter((o) => String(o.status || 'Pending') === 'Cancelled');
  const active = list.filter((o) => String(o.status || 'Pending') !== 'Cancelled');
  const delivered = active.filter((o) => String(o.status) === 'Delivered');
  const inFulfillment = active.filter((o) => IN_FULFILLMENT_STATUSES.includes(String(o.status)));
  const shipped = active.filter((o) => String(o.status) === 'Shipped');

  const sum = (arr) => arr.reduce((s, o) => s + num(o.total), 0);

  const totalValue = sum(active);
  return {
    orderCount,
    cancelledCount: cancelled.length,
    cancelledValue: sum(cancelled),
    totalValue,
    deliveredCount: delivered.length,
    deliveredSales: sum(delivered),
    pendingCount: inFulfillment.length,
    pendingValue: sum(inFulfillment),
    shippedCount: shipped.length,
    shippedValue: sum(shipped),
    aov: active.length ? Math.round(totalValue / active.length) : 0,
  };
}

function pctDelta(cur, prev) {
  if (prev > 0) return Math.round((cur - prev) / prev * 100);
  if (cur > 0 && prev === 0) return null; // "new" — no meaningful percentage
  return null;
}

/** Full overview for a time range: KPIs + previous-period deltas + series. */
export function computeSalesOverview(orders, rangeKey = '7d', now = new Date()) {
  const list = Array.isArray(orders) ? orders : [];
  const current = summarizeOrders(list.filter((o) => orderInRange(o, rangeKey, now)));

  const prev = previousPeriod(rangeKey, now);
  let prevTotalValue = null;
  let prevOrderCount = null;
  let prevLabel = null;
  if (prev) {
    const prevSummary = summarizeOrders(list.filter((o) => {
      const k = orderDateKey(o, now);
      return rangeKey === 'all' ? false : dateInRange(k, prev.start, prev.end);
    }));
    prevTotalValue = prevSummary.totalValue;
    prevOrderCount = prevSummary.orderCount;
    prevLabel = prev.label;
  }

  return {
    rangeKey,
    ...current,
    prevLabel,
    prevTotalValue,
    prevOrderCount,
    totalDeltaPct: prevTotalValue === null ? null : pctDelta(current.totalValue, prevTotalValue),
    orderDeltaPct: prevOrderCount === null ? null : pctDelta(current.orderCount, prevOrderCount),
    series: computeSeries(list, rangeKey, now),
  };
}

function computeSeries(list, rangeKey, now) {
  if (rangeKey === 'all') {
    const buckets = new Map();
    list
      .filter((o) => String(o.status || 'Pending') !== 'Cancelled')
      .forEach((o) => {
        const key = orderDateKey(o, now).slice(0, 7);
        const b = buckets.get(key) || { key, label: key, value: 0, orders: 0 };
        b.value += num(o.total);
        b.orders += 1;
        buckets.set(key, b);
      });
    const months = [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    return months.map((b) => ({ ...b, label: monthShortLabel(b.key) }));
  }

  const today = todayCairoStr(now);
  const days = rangeKey === 'today' ? 1 : (RANGE_DAYS[rangeKey] || (rangeKey === 'month' ? Number(today.slice(8)) : 7));
  const active = list.filter((o) => String(o.status || 'Pending') !== 'Cancelled');

  const dates = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(cairoDatePlus(today, -i));

  const byKey = new Map();
  active.forEach((o) => {
    const k = orderDateKey(o, now);
    const b = byKey.get(k) || { value: 0, orders: 0 };
    b.value += num(o.total);
    b.orders += 1;
    byKey.set(k, b);
  });

  return dates
    .filter((d) => rangeKey !== 'month' || d <= today)
    .map((d) => {
      const b = byKey.get(d) || { value: 0, orders: 0 };
      return {
        key: d,
        label: rangeKey === 'today' ? 'Today' : weekdayShort(d),
        value: Math.round(b.value),
        orders: b.orders,
      };
    });
}

function weekdayShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en', { weekday: 'short' });
}

function monthShortLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1, 12)).toLocaleDateString('en', { month: 'short' });
}

// ─── MARKETING / MISC HELPERS ────────────────────────────────────────────────

export function fmtEGP(n) {
  return `EGP ${Math.round(num(n)).toLocaleString('en-US')}`;
}

export function fmtEGPAr(n) {
  return `${Math.round(num(n)).toLocaleString('en-US')} ج.م`;
}

export function compactEGP(n) {
  const v = num(n);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return `${Math.round(v)}`;
}

// ─── INVENTORY HEALTH ────────────────────────────────────────────────────────

/** Classifies products for the dashboard Store Health panel. */
export function classifyInventory(products = []) {
  const outOfStock = [];
  const lowStock = [];
  (Array.isArray(products) ? products : []).forEach((p) => {
    const stock = num(p.stock);
    if (stock <= 0) outOfStock.push(p);
    else if (stock <= 5) lowStock.push(p);
  });
  return { outOfStock, lowStock };
}

// ─── LEGACY HELPERS (kept for AnalyticsPanel + compatibility) ────────────────

export function getValidOrders(orders) {
  return (orders || []).filter(o => o?.status !== 'Cancelled');
}

export function getDeliveredOrders(orders) {
  return (orders || []).filter(o => o?.status === 'Delivered');
}

export function getOrderRevenue(order) {
  if (!order || order.status !== 'Delivered') return 0;
  return order.total ?? 0;
}

export function resolveItemCategory(item, products = []) {
  const fromItem = (item?.category || '').trim();
  if (fromItem) return fromItem;
  const product = (products || []).find(p => p.id === item?.productId);
  return (product?.category || '').trim() || 'General';
}

export function resolveItemName(item, products = []) {
  const fromItem = (item?.name || '').trim();
  if (fromItem && fromItem !== 'Unknown') return fromItem;
  const product = (products || []).find(p => p.id === item?.productId);
  return (product?.name || '').trim() || 'Unknown Product';
}

export function getItemLineRevenue(item) {
  if (!item) return 0;
  const qty = item.qty ?? 0;
  if (qty <= 0) return 0;
  const unitPrice = item.unitPrice ?? (item.price != null && qty > 0 ? item.price / qty : 0);
  return (unitPrice ?? 0) * qty;
}

/** Old 7-day chart data — timezone fix: buckets use Egypt wall dates, matching
 * how order.date is written. `revenue` keeps the legacy "Delivered only" rule
 * but no longer lets the chart look empty when pending orders exist
 * (`orders` column is returned for callers that draw it). */
export function computeLast7Days(orders) {
  const now = new Date();
  return computeSeries(orders || [], '7d', now).map((p) => {
    const dayOrders = (orders || []).filter((o) => orderDateKey(o, now) === p.key);
    const dayDelivered = dayOrders.filter((o) => String(o.status) === 'Delivered');
    return {
      day: p.label,
      orders: dayOrders.filter((o) => String(o.status || 'Pending') !== 'Cancelled').length,
      revenue: dayDelivered.reduce((s, o) => s + num(o.total), 0),
    };
  });
}

export function computeDashboardStats(orders) {
  const safe = orders || [];
  const today = todayCairoStr();
  const todayOrders = safe.filter((o) => orderDateKey(o) === today);
  const todayDelivered = todayOrders.filter((o) => String(o.status) === 'Delivered');
  return {
    totalRevenue: safe.filter((o) => String(o.status) === 'Delivered').reduce((s, o) => s + num(o.total), 0),
    todayRevenue: todayDelivered.reduce((s, o) => s + num(o.total), 0),
    todayOrders,
    pending: safe.filter((o) => String(o.status || 'Pending') === 'Pending').length,
    delivered: safe.filter((o) => String(o.status) === 'Delivered').length,
    orderCount: safe.length,
  };
}

export function computeMonthlyPerformance(orders) {
  const delivered = getDeliveredOrders(orders);
  const map = {};

  delivered.forEach(o => {
    const key = orderDateKey(o);
    const m = new Date(`${key}T12:00:00Z`).toLocaleString('en', { month: 'short' });
    if (!map[m]) {
      map[m] = { m, orders: 0, revenue: 0, customers: new Set() };
    }
    map[m].orders += 1;
    map[m].revenue += num(o.total);
    map[m].customers.add(o.phone || o.customer || 'Guest');
  });

  return Object.values(map).map(x => ({
    m: x.m,
    orders: x.orders,
    revenue: x.revenue,
    customers: x.customers.size,
  }));
}

export function computeAnalyticsKPIs(orders) {
  const deliveredOrders = getDeliveredOrders(orders);
  const validOrders = getValidOrders(orders);
  const totalRevenue = deliveredOrders.reduce((s, o) => s + num(o.total), 0);

  return {
    totalRevenue,
    avgOrderValue: deliveredOrders.length
      ? Math.round(totalRevenue / deliveredOrders.length)
      : 0,
    uniqueCustomers: new Set(
      validOrders.map(o => o.phone || o.customer).filter(Boolean)
    ).size,
    convRate: validOrders.length
      ? Math.round((deliveredOrders.length / validOrders.length) * 100)
      : 0,
  };
}

export function computeTopProducts(orders, products = []) {
  const map = {};

  getValidOrders(orders).forEach(o => {
    (o.items || []).forEach(item => {
      const qty = item?.qty ?? 0;
      if (qty <= 0) return;

      const revenue = getItemLineRevenue(item);
      const productId = item?.productId ?? 0;
      const key = productId || resolveItemName(item, products);

      if (!map[key]) {
        map[key] = {
          name: resolveItemName(item, products),
          category: resolveItemCategory(item, products),
          revenue: 0,
          count: 0,
        };
      }

      map[key].revenue += revenue;
      map[key].count += qty;
    });
  });

  return Object.values(map)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6);
}

export function computeCategoryRevenue(orders, products = []) {
  const map = {};

  getValidOrders(orders).forEach(o => {
    (o.items || []).forEach(item => {
      const qty = item?.qty ?? 0;
      if (qty <= 0) return;

      const cat = resolveItemCategory(item, products);
      const revenue = getItemLineRevenue(item);

      if (!map[cat]) {
        map[cat] = { name: cat, revenue: 0 };
      }
      map[cat].revenue += revenue;
    });
  });

  return Object.values(map).sort((a, b) => b.revenue - a.revenue);
}

// ─── RANGE-AWARE ANALYTICS (Analytics panel) ─────────────────────────────────

/** Orders that fall inside a range key (uses the Egypt wall-date rules). */
export function filterOrdersInRange(orders, rangeKey = '7d', now = new Date()) {
  return (Array.isArray(orders) ? orders : []).filter((o) => orderInRange(o, rangeKey, now));
}

/** Units sold across all non-cancelled orders (line qty totals). */
export function computeItemsSold(orders) {
  return getValidOrders(orders).reduce(
    (sum, o) => sum + (o.items || []).reduce((t, it) => t + num(it?.qty), 0),
    0,
  );
}

/** Unique + returning customers (keyed by phone, falling back to name). */
export function computeCustomerStats(orders) {
  const counts = new Map();
  getValidOrders(orders).forEach((o) => {
    const key = String(o?.phone || o?.customer || '').trim();
    if (!key || key === 'Unknown') return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const uniqueCustomers = counts.size;
  const returningCustomers = [...counts.values()].filter((c) => c > 1).length;
  return {
    uniqueCustomers,
    returningCustomers,
    returningRate: uniqueCustomers ? Math.round((returningCustomers / uniqueCustomers) * 100) : 0,
  };
}

/** Delivery + cancellation rates over ALL orders (cancelled included). */
export function computeFulfillment(orders) {
  const all = Array.isArray(orders) ? orders : [];
  const total = all.length;
  const delivered = all.filter((o) => String(o.status) === 'Delivered').length;
  const cancelled = all.filter((o) => String(o.status || 'Pending') === 'Cancelled').length;
  return {
    fulfilledCount: delivered,
    cancelledCount: cancelled,
    fulfilmentRate: total ? Math.round((delivered / total) * 100) : 0,
    cancellationRate: total ? Math.round((cancelled / total) * 100) : 0,
  };
}

/** Count + value per status for the orders funnel. */
export function computeStatusBreakdown(orders) {
  const all = Array.isArray(orders) ? orders : [];
  return ORDER_STATUSES.map((status) => {
    const items = all.filter((o) => String(o.status || 'Pending') === status);
    return {
      status,
      count: items.length,
      value: items.reduce((s, o) => s + num(o.total), 0),
    };
  });
}

/** One bundle for the Analytics panel: KPIs + deltas + series + breakdowns. */
export function computeAnalyticsReport(orders, products = [], rangeKey = '7d', now = new Date()) {
  const overview = computeSalesOverview(orders, rangeKey, now);
  const ranged = filterOrdersInRange(orders, rangeKey, now);
  return {
    ...overview,
    itemsSold: computeItemsSold(ranged),
    ...computeCustomerStats(ranged),
    ...computeFulfillment(ranged),
    statusBreakdown: computeStatusBreakdown(ranged),
    topProducts: computeTopProducts(ranged, products),
    categoryRevenue: computeCategoryRevenue(ranged, products),
  };
}