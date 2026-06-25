/** Derived analytics — computed from orders, never stored in state. */

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

export function computeLast7Days(orders) {
  const validOrders = getValidOrders(orders);
  const deliveredOrders = getDeliveredOrders(orders);

  return [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const dateStr = d.toISOString().split('T')[0];

    const dayOrders = validOrders.filter(o => o.date === dateStr);
    const dayDelivered = deliveredOrders.filter(o => o.date === dateStr);

    return {
      day: d.toLocaleDateString('en', { weekday: 'short' }),
      orders: dayOrders.length,
      revenue: dayDelivered.reduce((s, o) => s + (o.total ?? 0), 0),
    };
  });
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

export function computeMonthlyPerformance(orders) {
  const delivered = getDeliveredOrders(orders);
  const map = {};

  delivered.forEach(o => {
    const date = new Date(o.date || o.timestamps?.created || Date.now());
    const m = date.toLocaleString('en', { month: 'short' });

    if (!map[m]) {
      map[m] = { m, orders: 0, revenue: 0, customers: new Set() };
    }

    map[m].orders += 1;
    map[m].revenue += o.total ?? 0;
    map[m].customers.add(o.phone || o.customer || 'Guest');
  });

  return Object.values(map).map(x => ({
    m: x.m,
    orders: x.orders,
    revenue: x.revenue,
    customers: x.customers.size,
  }));
}

export function computeDashboardStats(orders) {
  const safeOrders = orders || [];
  const deliveredOrders = getDeliveredOrders(safeOrders);
  const todayStr = new Date().toISOString().split('T')[0];
  const todayOrders = safeOrders.filter(o => o.date === todayStr);
  const todayDelivered = deliveredOrders.filter(o => o.date === todayStr);

  return {
    totalRevenue: deliveredOrders.reduce((s, o) => s + (o.total ?? 0), 0),
    todayRevenue: todayDelivered.reduce((s, o) => s + (o.total ?? 0), 0),
    todayOrders,
    pending: safeOrders.filter(o => o.status === 'Pending').length,
    delivered: deliveredOrders.length,
    orderCount: safeOrders.length,
  };
}

export function computeAnalyticsKPIs(orders) {
  const deliveredOrders = getDeliveredOrders(orders);
  const validOrders = getValidOrders(orders);
  const totalRevenue = deliveredOrders.reduce((s, o) => s + (o.total ?? 0), 0);

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
