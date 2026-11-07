import { create } from 'zustand';
import { db, trackEvent } from './lib/security';
import { supabase } from './lib/supabase'; // ربط سوبابيز الأونلاين
import { api } from './lib/api';
import { pageUrl, resolveRoute, syncLocationToStore } from './lib/routes';
import { clearOrderConfirmation } from './lib/orderConfirmation.mjs';
import { effectivePrice, hasInvalidVariantConfig, hasVariantStock, isSellableVariant, sellableStockFor } from './lib/pricing';

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
  const unitPrice = item?.unitPrice ?? (qty > 0 && item?.price != null ? item.price / qty : effectivePrice(product));
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

// The bag only ever keeps the three fields it needs to render/price the
// discount. The coupon table (dates, usage counters, other codes) stays on the
// server; api/orders.js is the authority when the order is placed.
function normalizeClientDiscount(d) {
  if (!d) return null;
  const code = String(d.code || '').trim().toUpperCase();
  // Mirror api/orders.js: only 'percentage' is a percentage discount.
  const type = d.type === 'percentage' ? 'percentage' : 'fixed';
  const value = Number(d.value);
  if (!code || !Number.isFinite(value) || value < 0) return null;
  const maxRaw = Number(d.maxDiscount);
  const minRaw = Number(d.minOrderAmount);
  return {
    code,
    type,
    value,
    // Optional server-side constraints, mirrored so the bag total matches the
    // order total. api/orders.js remains the authority.
    maxDiscount: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null,
    minOrderAmount: Number.isFinite(minRaw) && minRaw > 0 ? minRaw : 0,
  };
}

// The exact discount the server will compute for this subtotal.
function discountAmountFor(subtotal, d) {
  const sub = Number(subtotal) || 0;
  if (!d || sub <= 0) return 0;
  const min = Number(d.minOrderAmount) || 0;
  if (min > 0 && sub < min) return 0;
  let amount = d.type === 'percentage'
    ? Math.round(sub * (Number(d.value) || 0) / 100)
    : (Number(d.value) || 0);
  const cap = Number(d.maxDiscount);
  if (Number.isFinite(cap) && cap > 0) amount = Math.min(amount, cap);
  amount = Math.min(amount, sub);
  return Math.max(0, Math.round(amount));
}

function loadAppliedDiscount() {
  try {
    const raw = sessionStorage.getItem(APPLIED_DISCOUNT_KEY);
    if (!raw) return null;
    const clean = normalizeClientDiscount(JSON.parse(raw));
    if (clean) {
      // Drop legacy copies that still carried usage/date metadata.
      sessionStorage.setItem(APPLIED_DISCOUNT_KEY, JSON.stringify(clean));
    } else {
      sessionStorage.removeItem(APPLIED_DISCOUNT_KEY);
    }
    return clean;
  } catch {
    return null;
  }
}

function saveAppliedDiscount(discount) {
  const clean = normalizeClientDiscount(discount);
  if (clean) {
    sessionStorage.setItem(APPLIED_DISCOUNT_KEY, JSON.stringify(clean));
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
  if (!db.getAll('notifications')) db.setAll('notifications', []);
}
initDB();
const initialRoute = typeof window !== 'undefined' ? resolveRoute() : { page: 'home', productId: null };

// Shared row normalization for storefront (`products_public`) and admin
// (`products`) rows. Admin rows also carry `tags` and inactive rows.
function normalizeProductRow(p) {
  const row = p || {};
  return {
    ...row,
    images: Array.isArray(row.images) && row.images.length
      ? row.images
      : (row.image ? [row.image] : []),
    colors: Array.isArray(row.colors) ? row.colors : [],
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    tags: row.tags || '',
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    rating: row.rating || 0,
    reviews: row.reviews || 0
  };
}

// ─── ZUSTAND STORE ──────────────────────────────────────────────────────────
export const useStore = create((set, get) => ({
  products: db.getAll('products') || [],
  productsLoading: false,
  productsLoadStatus: 'idle',
  productsError: null,
  // Admin-only copy read from /api/admin/products. It is intentionally kept
  // separate from `products`: the storefront must stay on the sanitized public
  // view, while the admin panel needs inactive rows and `tags`.
  adminProducts: [],
  adminProductsLoading: false,
  adminProductsLoadStatus: 'idle',
  adminProductsError: null,
  discounts: [],
  orders: getSanitizedOrders(),
  ordersLoading: false,
  ordersError: null,

  refreshProducts: async () => {
    set({ productsLoading: true, productsLoadStatus: 'loading', productsError: null });
    try {
      // SEC-27: read the sanitized view (no reservedStock). The server is the
      // single source of truth for availability at checkout.
      const { data, error } = await supabase.from('products_public').select('*');
      if (error) {
        set({ productsLoadStatus: 'error', productsError: error.message || 'Could not load products' });
        console.error('Failed to fetch online products:', error);
      } else if (Array.isArray(data)) {
        const secureData = data.map(normalizeProductRow);
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

  // Admin-only: full rows (inactive + tags) through the authenticated API.
  // Never writes to the local `products` cache used by the storefront.
  refreshAdminProducts: async () => {
    set({ adminProductsLoading: true, adminProductsLoadStatus: 'loading', adminProductsError: null });
    try {
      const payload = await api.get('/admin/products');
      const rows = Array.isArray(payload && payload.products) ? payload.products : [];
      const normalized = rows.map(normalizeProductRow);
      set({ adminProducts: normalized, adminProductsLoadStatus: 'success', adminProductsError: null });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        set({
          adminProducts: [],
          adminProductsLoadStatus: 'error',
          adminProductsError: 'Not authorized to load admin products'
        });
        return;
      }
      set({
        adminProductsLoadStatus: 'error',
        adminProductsError: (err && err.message) || 'Could not load products'
      });
      console.error('Failed to fetch admin products:', err && err.message);
    } finally {
      set({ adminProductsLoading: false });
    }
  },

  // Admin-only: requires a signed session with discounts.read. Visitors never
  // call this, so no coupon rows are pulled into the storefront.
  refreshDiscounts: async () => {
    try {
      const payload = await api.get('/admin/coupons');
      const data = Array.isArray(payload.discounts) ? payload.discounts : [];
      set({ discounts: data });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        set({ discounts: [] });
        return;
      }
      console.error('Failed to fetch discounts:', err && err.message);
    }
  },

  updateProduct: async (id, updates) => {
    try {
      return await api.patch('/admin/products', { id, updates });
    } catch (err) {
      console.error('updateProduct failed:', err.message);
      throw err;
    } finally {
      await Promise.all([get().refreshProducts(), get().refreshAdminProducts()]);
    }
  },

  deleteProduct: async (id) => {
    db.delete('products', id);
    set({ products: db.getAll('products') || [] });
    try {
      return await api.del('/admin/products', { id });
    } finally {
      await Promise.all([get().refreshProducts(), get().refreshAdminProducts()]);
    }
  },

  bulkDeleteProducts: async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    ids.forEach(id => db.delete('products', id));
    set({ products: db.getAll('products') || [] });
    try {
      return await api.del('/admin/products', { ids });
    } finally {
      await Promise.all([get().refreshProducts(), get().refreshAdminProducts()]);
    }
  },

  updateProductImages: async (id, images) => {
    const list = Array.isArray(images) ? images : [images];
    try {
      await api.patch('/admin/products', { id, updates: { images: list, image: list[0] || '' } });
    } catch (err) {
      console.error('updateProductImages failed:', err.message);
      throw err;
    } finally {
      await Promise.all([get().refreshProducts(), get().refreshAdminProducts()]);
    }
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
      await Promise.all([get().refreshProducts(), get().refreshAdminProducts()]);
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
    if (!product?.id) return { success: false, error: 'Invalid product.' };

    const products = get().products;
    const freshProduct = products.find(p => p.id == product.id) || product;

    // One rule for the whole storefront (src/lib/pricing.js): a variation is only
    // sellable while its size AND colour are still declared on the product. A
    // leftover variantStock key is not permission to add it to the bag.
    if (!isSellableVariant(freshProduct, size, color)) {
      return {
        success: false,
        error: hasInvalidVariantConfig(freshProduct)
          ? 'This product is not available to order right now.'
          : `This variation (${size || '—'} · ${color || '—'}) is no longer available.`,
      };
    }
    // reservedStock is not part of availability (nothing writes or expires it),
    // and the server re-checks inside atomic_place_order — this is the friendly
    // early warning, not the gate.
    const stockKnown = hasVariantStock(freshProduct)
      ? true
      : (freshProduct.stock !== undefined && freshProduct.stock !== null
        && Number.isFinite(Number(freshProduct.stock)));
    const available = sellableStockFor(freshProduct, size, color);
    const currentInCart = (get().cart || []).find(i => i.product?.id == product.id && i.size === size && i.color === color)?.qty || 0;

    if (stockKnown && currentInCart + qty > available) {
      const remainingToOrder = Math.max(0, available - currentInCart);
      let errorMsg = "";
      if (remainingToOrder === 0) {
        errorMsg = `This variation (${size} · ${color}) is currently out of stock. You already have ${currentInCart} in your bag.`
      } else if (remainingToOrder === 1) {
        errorMsg = `Sorry, only 1 more piece is remaining in stock for this variation (${size} - ${color}).`
      } else {
        errorMsg = `Sorry, only ${remainingToOrder} more pieces are remaining in stock for this variation (${size} - ${color}).`
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
    if (!cartItem) return { success: false, error: 'This item is no longer in your bag.' };

    // استخدم بيانات المنتج الحيّة من الليستة، وإلا ارجع لنسخة المنتج المحفوظة
    // داخل عنصر السلة (حتى لو الليستة لم تُحمّل بعد) لمنع تجاوز المخزون بلا نهاية.
    const currentProduct = products.find(p => p.id == cartItem.product.id) || cartItem.product;

    if (currentProduct) {
      if (!isSellableVariant(currentProduct, cartItem.size, cartItem.color)) {
        return {
          success: false,
          error: hasInvalidVariantConfig(currentProduct)
            ? 'This product is not available to order right now.'
            : `This variation (${cartItem.size || '—'} · ${cartItem.color || '—'}) is no longer available.`,
        };
      }
      const available = sellableStockFor(currentProduct, cartItem.size, cartItem.color);
      if (newQty > available) {
        return {
          success: false,
          error: available > 0
            ? `Only ${available} piece${available === 1 ? '' : 's'} available for this selection.`
            : 'This selection is out of stock.',
        };
      }
    }

    const newCart = cart.map(item => item.key === key ? { ...item, qty: newQty } : item);
    const saved = get()._saveCart(newCart);
    set({ cart: saved });
    return { success: true };
  },

  // ─── PROACTIVE BAG CHECK (never mutates the cart) ────────────────────────────
  // Every bag line is measured against the LIVE product row before the shopper
  // reaches the server: an undeclared variation, an out-of-stock variation or an
  // invalid variant configuration. blocking: true means the order cannot succeed,
  // so the line is marked and offers Remove — the bag is never edited silently.
  // Lines whose product is missing from the catalogue are skipped: when the list
  // has not loaded (or failed), the server stays the only authority.
  cartLineIssues: () => {
    const cart = get().cart || [];
    const products = get().products || [];
    if (cart.length === 0 || products.length === 0) return [];

    const issues = [];
    for (const item of cart) {
      const live = products.find(p => p.id == item.product?.id);
      if (!live) continue;

      const size = item.size || '';
      const color = item.color || '';
      const requested = Number(item.qty) || 0;
      const base = { key: item.key, productId: live.id, name: live.name || 'this item', size, color };
      const variationText = (size || color) ? ` (${size} - ${color})` : '';

      if (hasInvalidVariantConfig(live)) {
        issues.push({ ...base, requested, available: 0, blocking: true, productWide: true,
          reason: 'invalid_config',
          message: 'This product is not available to order right now — its size and color options are not set up.' });
        continue;
      }
      if (!isSellableVariant(live, size, color)) {
        issues.push({ ...base, requested, available: 0, blocking: true, productWide: false,
          reason: 'undefined_variant',
          message: `This piece is no longer available in the selected size or color${variationText}.` });
        continue;
      }
      const available = sellableStockFor(live, size, color);
      // Wording is deliberately identical to api/orders.js, so the checkout can
      // show one sentence per problem instead of a client copy and a server copy.
      const scope = hasVariantStock(live) ? ' for this variation' : '';
      if (available <= 0) {
        issues.push({ ...base, requested, available: 0, blocking: true, productWide: false,
          reason: 'out_of_stock',
          message: `Sorry, this piece is out of stock${scope}${variationText}.` });
      } else if (requested > available) {
        issues.push({ ...base, requested, available, blocking: false, productWide: false,
          reason: 'oversold',
          message: `Only ${available} piece${available === 1 ? '' : 's'} remaining in stock${scope}${variationText}.` });
      }
    }
    return issues;
  },

  // Reconciliation after the server refused the order. Quantities that the server
  // says are too high are lowered (announced in the notice). Lines that cannot be
  // ordered at all are NOT deleted — they are returned as `unavailable` so the
  // bag marks them and the shopper removes them (owner decision, 2026-11-04: no
  // silent removals).
  reduceCartForStockIssues: (stockIssues) => {
    if (!Array.isArray(stockIssues) || stockIssues.length === 0) return { reduced: [], unavailable: [] };
    const cart = get().cart || [];
    const reduced = [];
    const unavailable = [];
    const kept = [];
    let changed = false;

    const issueFor = (item) => stockIssues.find(si => {
      if (Number(si.productId) !== Number(item.product?.id)) return false;
      // A product-wide refusal (gone, deactivated, invalid configuration) marks
      // every line of that product; a variation refusal marks only its line.
      if (si.missing || si.productWide) return true;
      return (si.size || '') === (item.size || '') && (si.color || '') === (item.color || '');
    });

    for (const item of cart) {
      const issue = issueFor(item);
      if (!issue) { kept.push(item); continue; }

      const label = item.product?.name || 'this item';
      const entry = { key: item.key, name: label, size: item.size || '', color: item.color || '',
        available: Number(issue.available) || 0 };

      if (issue.missing || issue.productWide || !(Number(issue.available) > 0)) {
        unavailable.push(entry);
        kept.push(item);
        continue;
      }

      const avail = Math.floor(Number(issue.available));
      if (Number(item.qty) > avail) {
        reduced.push({ ...entry, from: Number(item.qty), to: avail });
        kept.push({ ...item, qty: avail });
        changed = true;
      } else {
        kept.push(item);
      }
    }

    if (changed) {
      const saved = get()._saveCart(kept);
      set({ cart: saved });
    }
    return { reduced, unavailable };
  },

  clearCart: () => {
    try { localStorage.removeItem('zashm_cart'); } catch (e) { /* storage may be blocked */ }
    set({ cart: [] });
  },
  cartTotal: () => {
    const sub = get().cartSubtotal();
    if (!get().appliedDiscount) return sub;
    return Math.max(0, sub - discountAmountFor(sub, get().appliedDiscount));
  },
  cartSubtotal: () => (get().cart || []).reduce((sum, i) => sum + (effectivePrice(i.product) * (i.qty ?? 0)), 0),
  cartDiscountAmount: () => Math.max(0, get().cartSubtotal() - get().cartTotal()),

  wishlist: safeParseArray('zashm_wishlist', typeof localStorage !== 'undefined' ? localStorage : null),
  toggleWishlist: (productId) => set(s => {
    const wishlist = s.wishlist.includes(productId) ? s.wishlist.filter(id => id !== productId) : [...s.wishlist, productId];
    try { localStorage.setItem('zashm_wishlist', JSON.stringify(wishlist)); } catch (e) { /* storage may be blocked */ }
    return { wishlist };
  }),

  recentlyViewed: safeParseArray('zashm_recently', typeof sessionStorage !== 'undefined' ? sessionStorage : null),
  addRecentlyViewed: (id) => set(s => {
    const recentlyViewed = [id, ...s.recentlyViewed.filter(i => i !== id)].slice(0, 8);
    try { sessionStorage.setItem('zashm_recently', JSON.stringify(recentlyViewed)); } catch (e) { /* storage may be blocked */ }
    return { recentlyViewed };
  }),

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

    // Proactive gate: never submit a bag the live catalogue already says cannot
    // be ordered. The server stays authoritative (this only saves the shopper a
    // rejected round-trip), and the same issues shape are returned so the UI has
    // one rendering path.
    const blockingIssues = get().cartLineIssues().filter(i => i.blocking);
    if (blockingIssues.length > 0) {
      const errors = [];
      for (const issue of blockingIssues) {
        if (!errors.includes(issue.message)) errors.push(issue.message);
      }
      return {
        success: false,
        blockedLocally: true,
        error: errors[0],
        errors,
        stockIssues: blockingIssues.map(i => ({
          productId: i.productId, size: i.size, color: i.color,
          requested: i.requested, available: 0,
          missing: false, productWide: i.productWide === true,
        })),
      };
    }

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
        : [err && err.message ? err.message : 'Order failed. Please try again.'];
      const stockIssues = (err && Array.isArray(err.payload?.stockIssues)) ? err.payload.stockIssues : [];
      return { success: false, error: errors[0], errors, stockIssues };
    }

    const order = payload.order;

    clearCart();
    if (appliedDiscount) {
      saveAppliedDiscount(null);
      set({ appliedDiscount: null });
    }
    // The order is already committed by the server; refresh inventory without
    // making the customer wait before seeing the confirmation screen.
    void get().refreshProducts();

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

  editOrder: async (id, changes) => {
    const order = get().orders.find(o => String(o.id) === String(id));
    if (!order) return { success: false, error: 'Order not found' };

    // Optimistic revision: the server rejects the edit if another admin saved
    // first, instead of silently overwriting their change.
    const expectedRev = Number(order.timestamps && order.timestamps.rev) || 0;

    try {
      const payload = await api.patch('/admin/orders', {
        id,
        action: 'edit',
        expectedRev,
        ...changes,
      });
      await get().refreshProducts();
      await get().refreshOrders();
      return { success: true, order: payload.order, rev: payload.rev, warnings: payload.warnings || [] };
    } catch (err) {
      console.error('editOrder failed:', err.message);
      // Always resync so the drawer shows the server's current revision.
      await get().refreshOrders();
      return {
        success: false,
        error: (err && err.message) || 'Could not update order',
        code: err && err.payload && err.payload.code,
        rev: err && err.payload && err.payload.rev,
        errors: err && err.payload && Array.isArray(err.payload.errors) ? err.payload.errors : [],
      };
    }
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

  refreshAppliedDiscount: async () => {
    const currentDiscount = get().appliedDiscount;
    if (!currentDiscount || !currentDiscount.code) return;
    try {
      const payload = await api.post('/coupons/validate', {
        code: currentDiscount.code,
        subtotal: get().cartSubtotal(),
      });
      const fresh = payload && payload.valid ? normalizeClientDiscount(payload.discount) : null;
      if (fresh) {
        saveAppliedDiscount(fresh);
        set({ appliedDiscount: fresh });
        return;
      }
      get().removeAppliedDiscount();
    } catch (err) {
      // A network/timeout/rate-limit error is not proof of expiry. Keep the code
      // in the bag; placing the order still re-validates it server-side.
      if (!err || err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500) return;
      get().removeAppliedDiscount();
    }
  },

  addDiscount: async (d) => {
    const discount = { ...d, id: Date.now(), usageCount: 0, createdAt: new Date().toISOString() };
    try {
      const payload = await api.post('/admin/coupons', { coupon: discount });
      if (!payload || !payload.discount) throw new Error('Failed to create discount');
      set({ discounts: [payload.discount, ...get().discounts.filter(x => String(x.id) !== String(payload.discount.id))] });
      return payload.discount;
    } catch (err) {
      console.error('addDiscount failed:', err.message);
      throw err;
    }
  },

  updateDiscount: async (id, updates) => {
    const previous = get().discounts;
    const current = previous.find(d => String(d.id) === String(id));
    if (!current) throw new Error('Discount not found');

    set({ discounts: previous.map(d => String(d.id) === String(id) ? { ...d, ...updates } : d) });

    try {
      const payload = await api.patch('/admin/coupons', { id, updates });
      if (payload && payload.discount) {
        set({ discounts: get().discounts.map(d => String(d.id) === String(id) ? { ...d, ...payload.discount } : d) });
        return payload.discount;
      }
      return { ...current, ...updates };
    } catch (err) {
      console.error('updateDiscount failed:', err.message);
      set({ discounts: previous });
      await get().refreshDiscounts();
      throw err;
    }
  },

  deleteDiscount: async (id) => {
    const previous = get().discounts;
    if (!previous.some(d => String(d.id) === String(id))) throw new Error('Discount not found');

    set({ discounts: previous.filter(d => String(d.id) !== String(id)) });
    try {
      await api.del('/admin/coupons', { id });
      return true;
    } catch (err) {
      console.error('deleteDiscount failed:', err.message);
      set({ discounts: previous });
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

  applyDiscount: async (code) => {
    const normalized = (code ?? '').trim().toUpperCase();
    if (!normalized) return { success: false, error: 'Please enter a discount code.' };

    try {
      const payload = await api.post('/coupons/validate', {
        code: normalized,
        subtotal: get().cartSubtotal(),
      }, { timeoutMs: 15000 });
      const discount = payload && payload.valid ? normalizeClientDiscount(payload.discount) : null;
      if (!discount) {
        return {
          success: false,
          error: (payload && payload.error) || 'Invalid or expired discount code.',
        };
      }
      saveAppliedDiscount(discount);
      set({ appliedDiscount: discount });
      return { success: true, discount };
    } catch (err) {
      if (err && err.status === 429) {
        return { success: false, error: 'Too many attempts. Please wait a minute and try again.' };
      }
      if (err && err.status === 400 && err.message) {
        return { success: false, error: err.message };
      }
      return { success: false, error: 'Could not validate the discount code. Please try again.' };
    }
  },
  removeAppliedDiscount: () => {
    saveAppliedDiscount(null);
    set({ appliedDiscount: null });
  },

  // Global UI States
  currentPage: initialRoute.page,
  setPage: (page) => {
    if (get().currentPage === 'checkout' && page !== 'checkout') {
      clearOrderConfirmation();
    }
    const url = pageUrl(page, get().selectedProduct);
    if (typeof window !== 'undefined' && `${window.location.pathname}${window.location.search}` !== url) {
      window.history.pushState({ page }, '', url);
    }
    set({ currentPage: page });
  },
  syncPageFromLocation: () => {
    const previousPage = get().currentPage;
    const route = syncLocationToStore(set);
    if (previousPage === 'checkout' && route.page !== 'checkout') {
      clearOrderConfirmation();
    }
    return route;
  },
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