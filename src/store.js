import { create } from 'zustand';
import { db, trackEvent } from './lib/security';
import { supabase } from './lib/supabase'; // ربط سوبابيز الأونلاين
import { api } from './lib/api';
import { pageUrl, resolveRoute, syncLocationToStore } from './lib/routes';

// دالة مساعدة موحدة لحساب تاريخ اليوم بالكامل بناءً على التوقيت المحلي (Local Time) لتجنب مشاكل الـ UTC
function getLocalTodayDate() {
  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  return (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
}

// Safe array reader for persisted state. Malformed or blocked (opaque to JS)
// storage would otherwise throw during module evaluation and crash the whole app
// before it renders anything.
function safeParseArray(key, storage) {
  if (!storage) return [];
  try {
    const src = storage.getItem(key);
    const value = src ? JSON.parse(src) : null;
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

// ─── SANITIZE ORDER DATA ──────────────────────────────────────────────────────
function sanitizeOrderItem(item, products = []) {
  const product = (products || []).find(p => p.id == item?.productId);
  const qty = item?.qty ?? 0;
  const unitPrice = item?.unitPrice ?? (qty > 0 && item?.price != null ? item.price / qty : (product?.salePrice ?? product?.price ?? 0));
  const name = (item?.name || '').trim();
  const safeName = (name && name !== 'Unknown') ? name : ((product?.name || '').trim() || 'Unknown Product');
  const category = (item?.category || product?.category || '').trim() || 'General';

  return {
    productId: item?.productId ?? 0,
    name: safeName,
    category,
    size: item?.size ?? '',
    color: item?.color ?? '',
    qty,
    unitPrice: unitPrice ?? 0,
    price: item?.price ?? (unitPrice ?? 0) * qty,
    image: item?.image ?? (product?.images || [])[0] ?? '',
  };
}

function sanitizeOrder(order, products = []) {
  const status = order?.status ?? 'Pending';
  const { locked: _locked, ...rest } = order || {};

  let safeItems = [];
  if (order?.items) {
    if (typeof order.items === 'string') {
      try {
        safeItems = JSON.parse(order.items);
      } catch (e) {
        console.error("Error parsing items string:", e);
        safeItems = [];
      }
    } else if (Array.isArray(order.items)) {
      safeItems = order.items;
    }
  }

  let safeTimestamps = { created: new Date().toISOString() };
  if (order?.timestamps) {
    if (typeof order.timestamps === 'string') {
      try {
        safeTimestamps = JSON.parse(order.timestamps);
      } catch (e) {
        console.error("Error parsing timestamps string:", e);
      }
    } else if (typeof order.timestamps === 'object') {
      safeTimestamps = order.timestamps;
    }
  }

  return {
    ...rest,
    total: order?.total ?? 0,
    subtotal: order?.subtotal ?? 0,
    discount: order?.discount ?? 0,
    status,
    customer: order?.customer ?? 'Unknown',
    phone: order?.phone ?? '',
    email: order?.email ?? '',
    address: order?.address ?? '',
    city: order?.city ?? '',
    date: order?.date ?? getLocalTodayDate(),
    items: (safeItems || []).map(item => sanitizeOrderItem(item, products)),
    timestamps: safeTimestamps,
    tracking_url: order?.tracking_url || '' // 🎯 تم إضافة الحقل هنا لكي لا يتم حذفه أثناء عملية الـ Sanitize
  };
}

const APPLIED_DISCOUNT_KEY = 'zashm_applied_discount';

function validateDiscountRecord(d) {
  if (!d) return null;
  const discounts = db.getAll('discounts') || [];
  const today = getLocalTodayDate();
  const fresh = discounts.find(
    x => x.id === d.id &&
      x.code === d.code &&
      x.active &&
      x.startDate <= today &&
      x.endDate >= today &&
      (x.usageCount ?? 0) < (x.usageLimit ?? 0)
  );
  return fresh ?? null;
}

function loadAppliedDiscount() {
  try {
    const raw = sessionStorage.getItem(APPLIED_DISCOUNT_KEY);
    if (!raw) return null;
    return validateDiscountRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveAppliedDiscount(discount) {
  if (discount) {
    sessionStorage.setItem(APPLIED_DISCOUNT_KEY, JSON.stringify(discount));
  } else {
    sessionStorage.removeItem(APPLIED_DISCOUNT_KEY);
  }
}

function getSanitizedOrders() {
  const products = db.getAll('products') || [];
  const orders = db.getAll('orders') || [];
  return (Array.isArray(orders) ? orders : []).map(o => sanitizeOrder(o, products));
}

// ─── ORDER NOTIFICATIONS (derived from the live/polled order list) ────────────
// Notifications are computed from the orders the admin polls so every admin
// device sees new orders. The previous implementation only wrote a notification
// on the device that ran checkout, so any other device never received one.
const NOTIF_READ_KEY = 'zashm_notif_read_at';

function orderCreatedMs(o) {
  const t = o && o.timestamps;
  const v = t && (t.created || t.pending || t.Pending);
  const ms = v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function getNotifReadAt() {
  let raw = null;
  try { raw = localStorage.getItem(NOTIF_READ_KEY); } catch (e) { raw = null; }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function computeUnread(orders) {
  const readAt = getNotifReadAt();
  return (orders || []).filter(o => orderCreatedMs(o) > readAt).length;
}

// Order ids seen so far, so a background poll can raise a toast only for orders
// that genuinely just arrived (null = first load → no toast, just baseline).
let knownOrderIds = null;

// ─── SAFE DB INITIALIZATION ──────────────────────────────────────────────────
function initDB() {
  if (!db.getAll('products')) db.setAll('products', []);
  if (!db.getAll('discounts')) db.setAll('discounts', []);
  if (!db.getAll('notifications')) db.setAll('notifications', []);
}
initDB();
const initialRoute = typeof window !== 'undefined' ? resolveRoute() : { page: 'home', productId: null };

// ─── ZUSTAND STORE ──────────────────────────────────────────────────────────
export const useStore = create((set, get) => ({
  products: db.getAll('products') || [],
  productsLoading: false,
  productsLoadStatus: 'idle',
  productsError: null,
  discounts: db.getAll('discounts') || [],
  orders: getSanitizedOrders(),
  ordersLoading: false,
  ordersError: null,

  refreshProducts: async () => {
    set({ productsLoading: true, productsLoadStatus: 'loading', productsError: null });
    try {
      const { data, error } = await supabase.from('products').select('*');
      if (error) {
        set({ productsLoadStatus: 'error', productsError: error.message || 'Could not load products' });
        console.error('Failed to fetch online products:', error);
      } else if (Array.isArray(data)) {
        const secureData = data.map(p => ({
          ...p,
          images: p.images || (p.image ? [p.image] : []),
          colors: p.colors || [],
          sizes: p.sizes || [],
          active: p.active ?? true,
          reservedStock: p.reservedStock || 0,
          rating: p.rating || 0,
          reviews: p.reviews || 0
        }));
        db.setAll('products', secureData);
        set({ products: secureData, productsLoadStatus: 'success', productsError: null });
      } else {
        set({ productsLoadStatus: 'error', productsError: 'No product data returned' });
      }
    } catch (err) {
      set({ productsLoadStatus: 'error', productsError: err.message || 'Could not load products' });
      console.error("Failed to fetch online products:", err);
    } finally {
      set({ productsLoading: false });
    }
  },

  refreshDiscounts: async () => {
    try {
      const { data, error } = await supabase.from('coupons').select('*');
      if (data && !error) {
        db.setAll('discounts', data);
        set({ discounts: data });
      }
    } catch (err) {
      console.error("Failed to fetch online coupons:", err);
    }
  },

  updateProduct: async (id, updates) => {
    try {
      return await api.patch('/admin/products', { id, updates });
    } catch (err) {
      console.error('updateProduct failed:', err.message);
      throw err;
    } finally {
      await get().refreshProducts();
    }
  },

  deleteProduct: async (id) => {
    db.delete('products', id);
    set({ products: db.getAll('products') || [] });
    try {
      return await api.del('/admin/products', { id });
    } finally {
      await get().refreshProducts();
    }
  },

  bulkDeleteProducts: async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    ids.forEach(id => db.delete('products', id));
    set({ products: db.getAll('products') || [] });
    try {
      return await api.del('/admin/products', { ids });
    } finally {
      await get().refreshProducts();
    }
  },

  updateProductImages: async (id, images) => {
    const list = Array.isArray(images) ? images : [images];
    try {
      await api.patch('/admin/products', { id, updates: { images: list, image: list[0] || '' } });
    } catch (err) {
      console.error('updateProductImages failed:', err.message);
    }
    await get().refreshProducts();
  },

  addProduct: async (p) => {
    try {
      const payload = await api.post('/admin/products', { product: p });
      if (!payload || !payload.product) return { success: false, error: 'No product returned' };
      return payload.product;
    } catch (err) {
      console.error('addProduct failed:', err.message);
      throw err;
    } finally {
      await get().refreshProducts();
    }
  },

  // ─── CART ──────────────────────────────────────────────────────────────────
  // Persisted in localStorage so the bag survives tab close / reload.
  cart: safeParseArray('zashm_cart', typeof localStorage !== 'undefined' ? localStorage : null),
  _saveCart: (cart) => {
    try {
      const safeCart = (cart || []).filter(item => item && item.product && item.key);
      localStorage.setItem('zashm_cart', JSON.stringify(safeCart));
      return safeCart;
    } catch(e) {
      console.error('Cart save error:', e);
      return (cart || []);
    }
  },

  addToCart: (product, size, color, qty = 1) => {
    if (!product?.id) return { success: false, error: 'Invalid product / منتج غير صالح' };

    const products = get().products;
    const freshProduct = products.find(p => p.id == product.id) || product;
    const variantKey = `${size}-${color}`;

    let stockAmount = 99;
    const pv = freshProduct.variantStock;
    const hasVariantStock = !!(pv && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length > 0);
    if (hasVariantStock) {
      // موجود متغيرات: المفتاح غير المعرّف = صفر (لا نرجع للمخزون العام = مجموع المتغيرات)
      stockAmount = Number(pv[variantKey]) || 0;
    } else if (freshProduct.stock !== undefined && freshProduct.stock !== null) {
      stockAmount = Number(freshProduct.stock);
    }

    const reservedAmount = Number(freshProduct.reservedStock || 0);
    const available = Math.max(0, stockAmount - reservedAmount);
    const currentInCart = (get().cart || []).find(i => i.product?.id == product.id && i.size === size && i.color === color)?.qty || 0;

    if (currentInCart + qty > available && stockAmount !== 99) {
      const remainingToOrder = Math.max(0, available - currentInCart);
      let errorMsg = "";
      if (remainingToOrder === 0) {
        errorMsg = `This variation (${size} · ${color}) is currently out of stock. You already have ${currentInCart} in your bag.
هذا الخيار (${size} · ${color}) غير متوفر حاليًا. الكمية الموجودة منه في سلتك: ${currentInCart}.`
      } else if (remainingToOrder === 1) {
        errorMsg = `Sorry, only 1 more piece is remaining in stock for this variation (${size} - ${color}).
تبقت قطعة واحدة فقط بالمقاس واللون المحددين (${size} - ${color}).`
      } else {
        errorMsg = `Sorry, only ${remainingToOrder} more pieces are remaining in stock for this variation (${size} - ${color}).
تبقت ${remainingToOrder} قطع فقط بالمقاس واللون المحددين (${size} - ${color}).`
      }
      return { success: false, error: errorMsg };
    }

    set(s => {
      const key = `${product.id}-${size}-${color}`;
      const cart = s.cart || [];
      const exists = cart.find(i => i.key === key);

      const newCart = exists
        ? cart.map(i => i.key === key ? { ...i, qty: (i.qty || 0) + qty } : i)
        : [...cart, { key, product: freshProduct, size, color, qty }];

      const saved = get()._saveCart(newCart);
      return { cart: saved };
    });

    if (typeof trackEvent === 'function') {
      trackEvent('add_to_cart', { productId: product.id, qty });
    }
    return { success: true };
  },

  removeFromCart: (key) => set(s => { const cart = (s.cart || []).filter(i => i.key !== key); const saved = get()._saveCart(cart); return { cart: saved }; }),
  updateCartQty: (key, newQty) => {
    const { cart, products } = get();
    const cartItem = cart.find(item => item.key === key);
    if (!cartItem) return;

    // استخدم بيانات المنتج الحيّة من الليستة، وإلا ارجع لنسخة المنتج المحفوظة
    // داخل عنصر السلة (حتى لو الليستة لم تُحمّل بعد) لمنع تجاوز المخزون بلا نهاية.
    const currentProduct = products.find(p => p.id == cartItem.product.id) || cartItem.product;

    if (currentProduct) {
      const variantKey = `${cartItem.size}-${cartItem.color}`;
      const pv = currentProduct.variantStock;
      const hasVariantStock = !!(pv && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length > 0);
      const availableStock = hasVariantStock ? (Number(pv[variantKey]) || 0) : currentProduct.stock;

      if (availableStock !== undefined && availableStock !== null && newQty > Number(availableStock)) {
        return;
      }
    }

    const newCart = cart.map(item => item.key === key ? { ...item, qty: newQty } : item);
    const saved = get()._saveCart(newCart);
    set({ cart: saved });
  },

  // ضبط تلقائي للكميات بعد رد السيرفر: يقلل الكميات المتاحة أو يشيل
  // المنتجات غير المتوفرة، ويرجع ملخص التغييرات لعرض تنبيه ثنائي اللغة.
  reduceCartForStockIssues: (stockIssues) => {
    if (!Array.isArray(stockIssues) || stockIssues.length === 0) return { reduced: [], removed: [] };
    const cart = get().cart || [];
    const reduced = [];
    const removed = [];
    const kept = [];

    for (const item of cart) {
      const issue = stockIssues.find(si => {
        if (Number(si.productId) !== Number(item.product?.id)) return false;
        if (si.missing) return true;
        return (si.size || '') === (item.size || '') && (si.color || '') === (item.color || '');
      });

      if (!issue) { kept.push(item); continue; }

      const label = item.product?.name || 'this item';
      if (issue.missing || Number(issue.available) <= 0) {
        removed.push({ name: label, size: item.size || '', color: item.color || '' });
        continue;
      }

      const avail = Math.max(1, Math.floor(Number(issue.available)));
      if (Number(item.qty) > avail) {
        reduced.push({ name: label, size: item.size || '', color: item.color || '', from: Number(item.qty), to: avail });
        kept.push({ ...item, qty: avail });
      } else {
        kept.push(item);
      }
    }

    const saved = get()._saveCart(kept);
    set({ cart: saved });
    return { reduced, removed };
  },

  clearCart: () => { localStorage.removeItem('zashm_cart'); set({ cart: [] }); },
  cartTotal: () => {
    const sub = get().cartSubtotal();
    if (!get().appliedDiscount) return sub;
    if (get().appliedDiscount.type === 'percentage') {
      return Math.max(0, Math.round(sub * (1 - (get().appliedDiscount.value ?? 0) / 100)));
    }
    return Math.max(0, sub - (get().appliedDiscount.value ?? 0));
  },
  cartSubtotal: () => (get().cart || []).reduce((sum, i) => sum + (((i.product?.salePrice || i.product?.price) ?? 0) * (i.qty ?? 0)), 0),
  cartDiscountAmount: () => Math.max(0, get().cartSubtotal() - get().cartTotal()),

  wishlist: safeParseArray('zashm_wishlist', typeof localStorage !== 'undefined' ? localStorage : null),
  toggleWishlist: (productId) => set(s => { const wishlist = s.wishlist.includes(productId) ? s.wishlist.filter(id => id !== productId) : [...s.wishlist, productId]; localStorage.setItem('zashm_wishlist', JSON.stringify(wishlist)); return { wishlist }; }),

  recentlyViewed: safeParseArray('zashm_recently', typeof sessionStorage !== 'undefined' ? sessionStorage : null),
  addRecentlyViewed: (id) => set(s => { const recentlyViewed = [id, ...s.recentlyViewed.filter(i => i !== id)].slice(0, 8); sessionStorage.setItem('zashm_recently', JSON.stringify(recentlyViewed)); return { recentlyViewed }; }),

  // ─── ORDERS & NOTIFICATIONS ────────────────────────────────────────────────
  refreshOrders: async (silent = false) => {
    const isSilent = silent === true;
    if (!isSilent) set({ ordersLoading: true, ordersError: null });
    try {
      const payload = await api.get('/admin/orders');
      const data = Array.isArray(payload.orders) ? payload.orders : [];
      const sanitized = data.map(o => sanitizeOrder(o, get().products));
      const firstLoad = knownOrderIds === null;
      const fresh = firstLoad
        ? []
        : sanitized.filter(o => !knownOrderIds.has(String(o.id)));
      knownOrderIds = new Set(sanitized.map(o => String(o.id)));
      if (firstLoad) {
        // On the very first poll, mark the current backlog as already seen so the
        // bell doesn't report every historical order as unread.
        try {
          if (localStorage.getItem(NOTIF_READ_KEY) === null) {
            localStorage.setItem(NOTIF_READ_KEY, String(Date.now()));
          }
        } catch (e) { /* ignore */ }
      }
      const newest = fresh.length
        ? fresh.reduce((a, b) => (orderCreatedMs(b) > orderCreatedMs(a) ? b : a))
        : null;
      set({
        orders: sanitized,
        ordersLoading: false,
        unreadOrderCount: computeUnread(sanitized),
        ...(newest ? { newOrderNotification: { order: newest, timestamp: Date.now() } } : {}),
      });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        set({ ordersLoading: false });
        return;
      }
      console.error("Unexpected error in refreshOrders:", err && err.message);
      // Background polls fail quietly; manual refreshes surface the error.
      if (!isSilent) set({ ordersError: (err && err.message) || 'Could not load orders' });
      set({ ordersLoading: false });
    }
  },

  placeOrder: async (orderData, idempotencyKey = null) => {
    const { cart, appliedDiscount, clearCart } = get();
    const products = get().products;

    // المرور عبر السيرفر: الأسعار والمخزون والكوبون والشحن قبل إنشاء الطلب.
    const items = cart.map(i => ({
      productId: i.product?.id ?? 0,
      qty: i.qty ?? 1,
      size: i.size ?? '',
      color: i.color ?? '',
    }));

    let payload;
    try {
      payload = await api.post('/orders', {
        items,
        idempotencyKey,
        couponCode: appliedDiscount?.code || '',
        customer: {
          name: orderData?.customer || '',
          phone: orderData?.phone || '',
          phoneAlt: orderData?.phoneAlt || '',
          email: orderData?.email || '',
          address: orderData?.address || '',
          city: orderData?.city || '',
          notes: orderData?.notes || '',
          date: getLocalTodayDate(),
        },
        client: {
          shippingCost: Number(orderData?.shippingCost || 0),
          total: Number(orderData?.total || 0),
        },
      });
    } catch (err) {
      const errors = (err && Array.isArray(err.payload?.errors) && err.payload.errors.length)
        ? err.payload.errors
        : [err && err.message ? err.message : 'Order failed. Please try again.\nفشل تنفيذ الطلب، يرجى المحاولة مرة أخرى.'];
      const stockIssues = (err && Array.isArray(err.payload?.stockIssues)) ? err.payload.stockIssues : [];
      return { success: false, error: errors[0], errors, stockIssues };
    }

    const order = payload.order;

    clearCart();
    if (appliedDiscount) {
      saveAppliedDiscount(null);
      set({ appliedDiscount: null });
    }
    await get().refreshProducts();

    set({
      newOrderNotification: { order: sanitizeOrder(order, products), timestamp: Date.now() },
    });

    return { success: true, order: sanitizeOrder(order, products), duplicate: payload.duplicate === true };
  },

  updateOrderStatus: async (id, newStatus) => {
    const orders = get().orders;
    const order = orders.find(o => o.id === id);
    if (!order) return { success: false, error: 'Order not found' };

    const timestamps = { ...(order.timestamps || {}), [newStatus.toLowerCase()]: new Date().toISOString() };

    // تحديث محلي فوري ثم مزامنة السيرفر (السيرفر يعالج المخزون عند الإلغاء/الرجوع)
    set({ orders: orders.map(o => o.id === id ? { ...o, status: newStatus, timestamps } : o) });

    try {
      await api.patch('/admin/orders', { id, status: newStatus });
    } catch (err) {
      console.error('updateOrderStatus failed:', err.message);
      // Revert the optimistic change to server truth and report the failure.
      await get().refreshOrders();
      return { success: false, error: (err && err.message) || 'Could not update order status' };
    }

    await get().refreshProducts();
    await get().refreshOrders();
    return { success: true };
  },

  deleteOrder: async (id) => {
    set({ orders: get().orders.filter(o => String(o.id) !== String(id)) });
    try {
      await api.del('/admin/orders', { id });
    } catch (err) {
      console.error('deleteOrder failed:', err.message);
      await get().refreshOrders();
      return { success: false, error: (err && err.message) || 'Could not delete order' };
    }
    await get().refreshProducts();
    return { success: true };
  },

  newOrderNotification: null,
  unreadOrderCount: computeUnread(getSanitizedOrders()),
  clearOrderNotification: () => set({ newOrderNotification: null }),
  markNotificationsRead: () => {
    try { localStorage.setItem(NOTIF_READ_KEY, String(Date.now())); } catch (e) { /* ignore */ }
    set({ unreadOrderCount: 0 });
  },
  getNotifications: () => (get().orders || [])
    .map(o => ({ id: o.id, type: 'new_order', orderId: o.id, customer: o.customer, total: o.total, timestamp: orderCreatedMs(o) }))
    .sort((a, b) => b.timestamp - a.timestamp),

  // ─── DISCOUNTS (COUPONS) ────────────────────────────────────────────────────
  appliedDiscount: loadAppliedDiscount(),

  refreshAppliedDiscount: () => {
    const currentDiscount = get().appliedDiscount;
    if (!currentDiscount) return;
    const validated = validateDiscountRecord(currentDiscount);
    if (!validated) {
      get().removeAppliedDiscount();
    } else {
      set({ appliedDiscount: validated });
    }
  },

  addDiscount: async (d) => {
    const id = Date.now();
    const discount = { ...d, id, usageCount: 0, createdAt: new Date().toISOString() };
    db.insert('discounts', discount);
    set({ discounts: db.getAll('discounts') || [] });

    try {
      const payload = await api.post('/admin/coupons', { coupon: { ...discount } });
      if (payload && payload.discount) {
        db.update('discounts', id, payload.discount);
        set({ discounts: db.getAll('discounts') || [] });
        return payload.discount;
      }
      throw new Error('Failed to create discount');
    } catch (err) {
      console.error('addDiscount failed:', err.message);
      db.delete('discounts', id);
      set({ discounts: db.getAll('discounts') || [] });
      await get().refreshDiscounts();
      throw err;
    }
  },

  updateDiscount: async (id, updates) => {
    const discounts = get().discounts;
    const current = discounts.find(d => String(d.id) === String(id));
    if (!current) throw new Error('Discount not found');

    const next = discounts.map(d => String(d.id) === String(id) ? { ...d, ...updates } : d);
    db.setAll('discounts', next);
    set({ discounts: next });

    try {
      const payload = await api.patch('/admin/coupons', { id, updates });
      if (payload && payload.discount) {
        const merged = get().discounts.map(d => String(d.id) === String(id) ? { ...d, ...payload.discount } : d);
        db.setAll('discounts', merged);
        set({ discounts: merged });
        return payload.discount;
      }
      return { ...current, ...updates };
    } catch (err) {
      console.error('updateDiscount failed:', err.message);
      db.setAll('discounts', discounts);
      set({ discounts });
      await get().refreshDiscounts();
      throw err;
    }
  },

  deleteDiscount: async (id) => {
    const discounts = get().discounts;
    const current = discounts.find(d => String(d.id) === String(id));
    if (!current) throw new Error('Discount not found');

    db.delete('discounts', id);
    set({ discounts: db.getAll('discounts') || [] });
    try {
      await api.del('/admin/coupons', { id });
      return true;
    } catch (err) {
      console.error('deleteDiscount failed:', err.message);
      db.setAll('discounts', discounts);
      set({ discounts });
      await get().refreshDiscounts();
      throw err;
    }
  },

  importProducts: async (list) => {
    if (!Array.isArray(list) || list.length === 0) return { success: false, error: 'No products to import' };
    const requested = list.length;
    try {
      const payload = await api.post('/admin/products', { items: list });
      await get().refreshProducts();
      const count = payload && typeof payload.count === 'number' ? payload.count : requested;
      return { success: true, count, requested, truncated: count < requested };
    } catch (err) {
      console.error('importProducts failed:', err.message);
      return { success: false, error: err.message || 'Import failed' };
    }
  },

  applyDiscount: (code) => {
    const normalized = (code ?? '').trim().toUpperCase();
    if (!normalized) return { success: false, error: 'Please enter a discount code / يرجى إدخال كود الخصم' };

    const discounts = get().discounts;
    const today = getLocalTodayDate();

    const d = discounts.find(
      x => (x.code || '').trim().toUpperCase() === normalized &&
        x.active &&
        x.startDate <= today &&
        x.endDate >= today &&
        Number(x.usageCount || 0) < Number(x.usageLimit || 0)
    );

    if (d) {
      saveAppliedDiscount(d);
      set({ appliedDiscount: d });
      return { success: true, discount: d };
    }
    return { success: false, error: 'Invalid or expired discount code / كود خصم غير صالح أو منتهي الصلاحية' };
  },
  removeAppliedDiscount: () => {
    saveAppliedDiscount(null);
    set({ appliedDiscount: null });
  },

  // Global UI States
  currentPage: initialRoute.page,
  setPage: (page) => {
    const url = pageUrl(page, get().selectedProduct);
    if (typeof window !== 'undefined' && `${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({ page }, '', url);
    }
    set({ currentPage: page });
  },
  syncPageFromLocation: () => syncLocationToStore(set),
  language: 'en',
  setLanguage: () => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
    }
    set({ language: 'en' });
  },
  selectedProduct: null,
  setSelectedProduct: (p) => set({ selectedProduct: p }),
  adminPage: 'dashboard',
  setAdminPage: (p) => set({ adminPage: p }),
  cartOpen: false,
  setCartOpen: (v) => set({ cartOpen: v }),
  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  filterCategory: 'ALL',
  setFilterCategory: (c) => set({ filterCategory: c }),
  shopPage: 1,
  setShopPage: (p) => set({ shopPage: p }),
  shopPerPage: 12,
}));