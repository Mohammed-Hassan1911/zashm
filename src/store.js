import { create } from 'zustand';
import { db, trackEvent } from './lib/security';
import { supabase } from './lib/supabase'; // ربط سوبابيز الأونلاين
import { api } from './lib/api';

// دالة مساعدة موحدة لحساب تاريخ اليوم بالكامل بناءً على التوقيت المحلي (Local Time) لتجنب مشاكل الـ UTC
function getLocalTodayDate() {
  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  return (new Date(Date.now() - tzOffset)).toISOString().split('T')[0];
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

// ─── SAFE DB INITIALIZATION ──────────────────────────────────────────────────
function initDB() {
  if (!db.getAll('products')) db.setAll('products', []);
  if (!db.getAll('discounts')) db.setAll('discounts', []);
  if (!db.getAll('notifications')) db.setAll('notifications', []);
}
initDB();

// ─── ZUSTAND STORE ──────────────────────────────────────────────────────────
export const useStore = create((set, get) => ({
  products: db.getAll('products') || [],
  discounts: db.getAll('discounts') || [],
  orders: getSanitizedOrders(),

  refreshProducts: async () => {
    try {
      const { data, error } = await supabase.from('products').select('*');
      if (data && !error) {
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
        set({ products: secureData });
      }
    } catch (err) {
      console.error("Failed to fetch online products:", err);
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
      await api.patch('/admin/products', { id, updates });
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
      await api.del('/admin/products', { id });
    } catch (err) {
      console.error('deleteProduct failed:', err.message);
    }
    await get().refreshProducts();
  },
  
  bulkDeleteProducts: async (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return;
    ids.forEach(id => db.delete('products', id));
    set({ products: db.getAll('products') || [] });
    try {
      await api.del('/admin/products', { ids });
    } catch (err) {
      console.error('bulkDeleteProducts failed:', err.message);
    }
    await get().refreshProducts();
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
  cart: JSON.parse(sessionStorage.getItem('zashm_cart') || '[]') ?? [],
  _saveCart: (cart) => { 
    try {
      const safeCart = (cart || []).filter(item => item && item.product && item.key);
      sessionStorage.setItem('zashm_cart', JSON.stringify(safeCart)); 
      return safeCart;
    } catch(e) {
      console.error('Cart save error:', e);
      return (cart || []);
    }
  },
  
  addToCart: (product, size, color, qty = 1) => {
    if (!product?.id) return { success: false, error: 'Invalid product' };
    
    const products = get().products;
    const freshProduct = products.find(p => p.id == product.id) || product;
    const variantKey = `${size}-${color}`;
    
    let stockAmount = 99;
    if (freshProduct.variantStock && freshProduct.variantStock[variantKey] !== undefined) {
      stockAmount = Number(freshProduct.variantStock[variantKey]);
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
        errorMsg = `Sorry, this piece is out of stock in this variation (${size} - ${color}). You already have ${currentInCart} in your bag.`;
      } else if (remainingToOrder === 1) {
        errorMsg = `Sorry, only 1 more piece is remaining in stock for this variation (${size} - ${color}).`;
      } else {
        errorMsg = `Sorry, only ${remainingToOrder} more pieces are remaining in stock for this variation (${size} - ${color}).`;
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

    const currentProduct = products.find(p => p.id === cartItem.product.id);
    
    if (currentProduct) {
      const variantKey = `${cartItem.size}-${cartItem.color}`;
      let availableStock = currentProduct.stock;
      if (currentProduct.variantStock && currentProduct.variantStock[variantKey] !== undefined) {
        availableStock = Number(currentProduct.variantStock[variantKey]);
      }

      if (newQty > availableStock && availableStock !== undefined) {
        return; 
      }
    }

    const newCart = cart.map(item => item.key === key ? { ...item, qty: newQty } : item);
    const saved = get()._saveCart(newCart);
    set({ cart: saved });
  },

  clearCart: () => { sessionStorage.removeItem('zashm_cart'); set({ cart: [] }); },
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

  wishlist: JSON.parse(localStorage.getItem('zashm_wishlist') || '[]'),
  toggleWishlist: (productId) => set(s => { const wishlist = s.wishlist.includes(productId) ? s.wishlist.filter(id => id !== productId) : [...s.wishlist, productId]; localStorage.setItem('zashm_wishlist', JSON.stringify(wishlist)); return { wishlist }; }),

  recentlyViewed: JSON.parse(sessionStorage.getItem('zashm_recently') || '[]'),
  addRecentlyViewed: (id) => set(s => { const recentlyViewed = [id, ...s.recentlyViewed.filter(i => i !== id)].slice(0, 8); sessionStorage.setItem('zashm_recently', JSON.stringify(recentlyViewed)); return { recentlyViewed }; }),
  
  // ─── ORDERS & NOTIFICATIONS ────────────────────────────────────────────────
  refreshOrders: async () => {
    try {
      const payload = await api.get('/admin/orders');
      const data = Array.isArray(payload.orders) ? payload.orders : [];
      const sanitized = data.map(o => sanitizeOrder(o, get().products));
      set({ orders: sanitized });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) return;
      console.error("Unexpected error in refreshOrders:", err && err.message);
    }
  },

  placeOrder: async (orderData) => {
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
      return { success: false, error: errors[0], errors };
    }

    const order = payload.order;

    const notifications = db.getAll('notifications') || [];
    notifications.unshift({ id: Date.now(), type: 'new_order', orderId: order.id, customer: order.customer, total: order.total, read: false, timestamp: Date.now() });
    db.setAll('notifications', notifications.slice(0, 50));

    clearCart();
    if (appliedDiscount) {
      saveAppliedDiscount(null);
      set({ appliedDiscount: null });
    }
    await get().refreshProducts();

    set({
      unreadOrderCount: notifications.filter(n => !n.read).length,
      newOrderNotification: { order: sanitizeOrder(order, products), timestamp: Date.now() },
    });

    return { success: true, order: sanitizeOrder(order, products) };
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
    }
    return { success: true };
  },

  newOrderNotification: null,
  unreadOrderCount: (db.getAll('notifications') || []).filter(n => !n.read).length,
  clearOrderNotification: () => set({ newOrderNotification: null }),
  markNotificationsRead: () => { const n = (db.getAll('notifications') || []).map(x => ({ ...x, read: true })); db.setAll('notifications', n); set({ unreadOrderCount: 0 }); },
  getNotifications: () => db.getAll('notifications') || [],
  
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
      }
    } catch (err) {
      console.error('addDiscount failed:', err.message);
      await get().refreshDiscounts();
    }
    return discount;
  },

  updateDiscount: async (id, updates) => {
    const discounts = get().discounts;
    const current = discounts.find(d => String(d.id) === String(id));
    set({ discounts: discounts.map(d => String(d.id) === String(id) ? { ...d, ...updates } : d) });

    if (current) {
      try {
        const payload = await api.patch('/admin/coupons', { id, updates });
        if (payload && payload.discount) {
          set({ discounts: get().discounts.map(d => String(d.id) === String(id) ? { ...d, ...payload.discount } : d) });
        }
      } catch (err) {
        console.error('updateDiscount failed:', err.message);
        await get().refreshDiscounts();
      }
    }
  },

  deleteDiscount: async (id) => {
    set({ discounts: get().discounts.filter(d => String(d.id) !== String(id)) });
    try {
      await api.del('/admin/coupons', { id });
    } catch (err) {
      console.error('deleteDiscount failed:', err.message);
      await get().refreshDiscounts();
    }
  },

  importProducts: async (list) => {
    if (!Array.isArray(list) || list.length === 0) return { success: false, error: 'No products to import' };
    try {
      const payload = await api.post('/admin/products', { items: list.slice(0, 500) });
      await get().refreshProducts();
      return { success: true, count: payload && payload.count ? payload.count : list.length };
    } catch (err) {
      console.error('importProducts failed:', err.message);
      return { success: false, error: err.message || 'Import failed' };
    }
  },
  
  applyDiscount: (code) => {
    const normalized = (code ?? '').trim().toUpperCase();
    if (!normalized) return { success: false, error: 'Please enter a discount code' };
    
    const discounts = get().discounts;
    const today = getLocalTodayDate(); 
    
    const d = discounts.find(
      x => x.code.trim().toUpperCase() === normalized &&
        x.active &&
        x.startDate <= today &&
        x.endDate >= today &&
        (Number(x.usageCount) ?? 0) < (Number(x.usageLimit) ?? 0)
    );
    
    if (d) {
      saveAppliedDiscount(d);
      set({ appliedDiscount: d });
      return { success: true, discount: d };
    }
    return { success: false, error: 'Invalid or expired discount code' };
  },
  removeAppliedDiscount: () => {
    saveAppliedDiscount(null);
    set({ appliedDiscount: null });
  },

  // Global UI States
  currentPage: 'home',
  prevPage: null,
  setPage: (p) => set(state => ({ currentPage: p, prevPage: p === state.currentPage ? state.prevPage : state.currentPage })),
  goBack: () => {
    const { currentPage, prevPage } = get();
    const target = (prevPage && prevPage !== currentPage && prevPage !== 'admin') ? prevPage : 'shop';
    get().setPage(target);
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