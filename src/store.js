import { create } from 'zustand';
import { db, generateOrderId, trackEvent } from './lib/security';
import { supabase } from './lib/supabase'; // ربط سوبابيز الأونلاين

// ─── HELPER TO GET FILE PATH FROM SUPABASE URL ──────────────────────────────
// دالة مساعدة لقص الرابط واستخراج اسم الملف الصافي داخل الـ bucket
function getFilePathFromUrl(url) {
  if (!url) return null;
  const parts = url.split('/products/');
  return parts.length > 1 ? parts[1] : null;
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

  // 🎯 ذكاء اصطناعي لفك تشفير حقل الـ items بأمان لو راجع كـ نص (String) من Supabase
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

  // 🎯 ذكاء اصطناعي لفك تشفير حقل الـ timestamps بأمان لو راجع كـ نص
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
    date: order?.date ?? new Date().toISOString().split('T')[0],
    items: (safeItems || []).map(item => sanitizeOrderItem(item, products)),
    timestamps: safeTimestamps
  };
}

const APPLIED_DISCOUNT_KEY = 'zashm_applied_discount';

function validateDiscountRecord(d) {
  if (!d) return null;
  const discounts = db.getAll('discounts') || [];
  const today = new Date().toISOString().split('T')[0];
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
  if (!db.getAll('orders')) db.setAll('orders', []);
  if (!db.getAll('notifications')) db.setAll('notifications', []);
}
initDB();

// ─── ZUSTAND STORE ──────────────────────────────────────────────────────────
export const useStore = create((set, get) => ({
  products: db.getAll('products') || [],
  discounts: db.getAll('discounts') || [],
  orders: getSanitizedOrders(),

  // جلب المنتجات من Supabase أونلاين وتأمين الحقول للـ UI
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

  // جلب الكوبونات من جدول coupons أونلاين
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
    const updatedFields = { ...updates, updatedAt: new Date().toISOString() };
    db.update('products', id, updatedFields);
    set({ products: db.getAll('products') || [] });

    const { active, createdAt, updatedAt, reservedStock, rating, reviews, ...cleanUpdates } = updatedFields;
    
    if (updates.colors) cleanUpdates.colors = Array.isArray(updates.colors) ? updates.colors : [];
    if (updates.sizes) cleanUpdates.sizes = Array.isArray(updates.sizes) ? updates.sizes : [];
    if (updates.images) cleanUpdates.images = Array.isArray(updates.images) ? updates.images : [];
    if (updates.sku !== undefined) cleanUpdates.sku = updates.sku;

    await supabase.from('products').update(cleanUpdates).eq('id', id);
  },
  
  // 🔥 تعديل دالة مسح المنتج لمسح الصور من الـ Bucket أولاً 🚀
  deleteProduct: async (id) => { 
    try {
      // 1. جلب بيانات المنتج من الداتا بيز المحلية أو سوبابيز لمعرفة روابط الصور
      const products = get().products;
      const product = products.find(p => p.id === id);

      if (product) {
        const filesToDelete = [];

        // استخراج مسارات جميع صور المنتج
        if (Array.isArray(product.images)) {
          product.images.forEach(url => {
            const path = getFilePathFromUrl(url);
            if (path) filesToDelete.push(path);
          });
        } else if (product.image) {
          const path = getFilePathFromUrl(product.image);
          if (path) filesToDelete.push(path);
        }

        // استخراج مسار صورة الـ size guide بالاسم المطابق لـ Supabase
         if (product.sizeGuide) {
          const path = getFilePathFromUrl(product.sizeGuide);
         if (path) filesToDelete.push(path);
      }

        // 2. مسح الملفات من الـ Bucket المسمى products في Supabase
        if (filesToDelete.length > 0) {
          const { error: storageError } = await supabase
            .storage
            .from('products')
            .remove(filesToDelete);

          if (storageError) {
            console.error("❌ فشل مسح صور المنتج من الـ Bucket:", storageError);
          } else {
            console.log("✅ تم مسح صور المنتج والـ size guide بنجاح من الـ Bucket");
          }
        }
      }

      // 3. مسح المنتج نهائياً من الـ Local DB وسوبابيز
      db.delete('products', id); 
      set({ products: db.getAll('products') || [] }); 
      await supabase.from('products').delete().eq('id', id);

    } catch (err) {
      console.error("حدث خطأ غير متوقع أثناء عملية الحذف بالكامل:", err);
    }
  },
  
  bulkDeleteProducts: async (ids) => { 
    // يمكنك لاحقاً تطبيق نفس منطق الحذف الجماعي هنا للصور لو احتجت
    ids.forEach(id => db.delete('products', id)); 
    set({ products: db.getAll('products') || [] }); 
    await supabase.from('products').delete().in('id', ids);
  },
  
  updateProductImages: async (id, images) => { 
    const updatedFields = { images, updatedAt: new Date().toISOString() };
    db.update('products', id, updatedFields); 
    set({ products: db.getAll('products') || [] }); 
    
    const singleImage = Array.isArray(images) ? images[0] : images;
    await supabase.from('products').update({ image: singleImage, images: Array.isArray(images) ? images : [images] }).eq('id', id);
  },
  
  // إضافة منتج أونلاين مع توليد ID رقمي نقي ليناسب نوع bigint في سوبابيز 🚀
  addProduct: async (p) => {
    const generatedNumericId = Number(`${Date.now()}${Math.floor(100 + Math.random() * 900)}`);

    const supabasePayload = {
      id: generatedNumericId,
      name: p.name,
      category: p.category,
      price: Number(p.price || 0),
      salePrice: p.salePrice ? Number(p.salePrice) : null,
      description: p.description || '',
      stock: parseInt(p.stock ?? 0, 10),
      variantStock: p.variantStock || {},
      sku: p.sku || '',
      colors: Array.isArray(p.colors) ? p.colors : [],
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      images: Array.isArray(p.images) ? p.images : [],
      image: p.image || (Array.isArray(p.images) && p.images.length > 0 ? p.images[0] : ''),
      sizeGuide: p.sizeGuide || null // مطابق لاسم العمود في الجدول
    };

    try {
      const { data, error } = await supabase
        .from('products')
        .insert([supabasePayload])
        .select()
        .single();

      if (error) {
        console.error("Supabase Products Insert Error:", error);
        return { success: false, error };
      }

      const finalProduct = {
        ...data,
        reservedStock: 0, 
        rating: 0, 
        reviews: 0, 
        active: data.active ?? true, 
        createdAt: data.created_at || new Date().toISOString(), 
        updatedAt: data.updated_at || new Date().toISOString() 
      };

      db.insert('products', finalProduct);
      set({ products: db.getAll('products') || [] });

      console.log("🚀 PRODUCT SUCCESSFULLY ADDED & SYNCED TO BIGINT ID!");
      return finalProduct;

    } catch (err) {
      console.error("Unexpected error in addProduct:", err);
      return { success: false, error: err };
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

  removeFromCart: (key) => set(s => { 
    const cart = (s.cart || []).filter(i => i.key !== key); 
    const saved = get()._saveCart(cart); 
    return { cart: saved }; 
  }),

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
        if (availableStock === 0) {
          alert(`Sorry, this item variation (${cartItem.size} - ${cartItem.color}) is completely out of stock.`);
        } else if (availableStock === 1) {
          alert(`Sorry, only 1 piece is remaining in stock for this variation.`);
        } else {
          alert(`Sorry, only ${availableStock} pieces are remaining in stock for this variation.`);
        }
        return; 
      }
    }

    const newCart = cart.map(item => item.key === key ? { ...item, qty: newQty } : item);
    const saved = get()._saveCart(newCart);
    set({ cart: saved });
  },

  clearCart: () => { 
    sessionStorage.removeItem('zashm_cart'); 
    set({ cart: [] }); 
  },

  cartTotal: () => {
    const sub = get().cartSubtotal();
    if (!get().appliedDiscount) return sub;
    if (get().appliedDiscount.type === 'percentage') {
      return Math.max(0, Math.round(sub * (1 - (get().appliedDiscount.value ?? 0) / 100)));
    }
    return Math.max(0, sub - (get().appliedDiscount.value ?? 0));
  },

  cartSubtotal: () => (get().cart || []).reduce(
    (sum, i) => sum + (((i.product?.salePrice || i.product?.price) ?? 0) * (i.qty ?? 0)),
    0
  ),

  cartDiscountAmount: () => Math.max(0, get().cartSubtotal() - get().cartTotal()),

  wishlist: JSON.parse(localStorage.getItem('zashm_wishlist') || '[]'),
  toggleWishlist: (productId) => set(s => { const wishlist = s.wishlist.includes(productId) ? s.wishlist.filter(id => id !== productId) : [...s.wishlist, productId]; localStorage.setItem('zashm_wishlist', JSON.stringify(wishlist)); return { wishlist }; }),

  recentlyViewed: JSON.parse(sessionStorage.getItem('zashm_recently') || '[]'),
  addRecentlyViewed: (id) => set(s => { const recentlyViewed = [id, ...s.recentlyViewed.filter(i => i !== id)].slice(0, 8); sessionStorage.setItem('zashm_recently', JSON.stringify(recentlyViewed)); return { recentlyViewed }; }),
  
  // ─── ORDERS & NOTIFICATIONS ────────────────────────────────────────────────
  refreshOrders: async () => {
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('date', { ascending: false });

      if (data && !error) {
        db.setAll('orders', data);
        const sanitized = data.map(o => sanitizeOrder(o, get().products));
        set({ orders: sanitized });
      } else if (error) {
        console.error("Error refreshing orders from Supabase:", error);
      }
    } catch(err) {
      console.error("Unexpected error in refreshOrders:", err);
    }
  },

      placeOrder: async (orderData) => {
    const { cart, appliedDiscount, cartTotal, cartSubtotal, clearCart } = get();
    const products = get().products;
    
    // 1. تحديث المخزون محلياً وفي سوبابيز
    for (const item of cart) {
      const product = products.find(p => p.id == item.product.id);
      if (product) {
        const currentStock = product.stock ? Number(product.stock) : 0;
        const newStock = Math.max(0, currentStock - item.qty);
        
        const variantKey = `${item.size}-${item.color}`;
        const updatedVariantStock = { ...(product.variantStock || {}) };
        
        if (updatedVariantStock[variantKey] !== undefined) {
          const currentVariantQty = Number(updatedVariantStock[variantKey]);
          updatedVariantStock[variantKey] = Math.max(0, currentVariantQty - item.qty);
        }

        db.update('products', product.id, { 
          stock: newStock, 
          variantStock: updatedVariantStock, 
          updatedAt: new Date().toISOString() 
        });

        await supabase.from('products').update({ 
          stock: newStock, 
          variantStock: updatedVariantStock 
        }).eq('id', product.id);
      }
    }

    const subtotal = cartSubtotal() ?? 0;
    const total = cartTotal() ?? 0;
    const discount = Math.max(0, subtotal - total);
    
    const orderId = generateOrderId();
    const customerName = orderData?.name || orderData?.customer || 'Unknown Customer';

    const order = {
      id: orderId,
      ...orderData,
      items: cart.map(i => ({
        productId: i.product?.id ?? 0,
        name: i.product?.name ?? 'Unknown Product',
        category: (i.product?.category || '').trim() || 'General',
        size: i.size ?? '',
        color: i.color ?? '',
        qty: i.qty ?? 0,
        price: ((i.product?.salePrice || i.product?.price) ?? 0) * (i.qty ?? 0),
        unitPrice: (i.product?.salePrice || i.product?.price) ?? 0,
        image: (i.product?.images || [])[0] ?? '',
      })),
      subtotal,
      discount,
      total,
      discountCode: appliedDiscount?.code || null,
      status: 'Pending',
      date: new Date().toISOString().split('T')[0],
      timestamps: { created: new Date().toISOString() },
      customer: customerName,
      phone: orderData?.phone || '',
      phoneAlt: orderData?.phoneAlt || '', 
      email: orderData?.email || '',
      address: orderData?.address || '',
      city: orderData?.city || '',
      notes: orderData?.notes || '',
    };

    db.insert('orders', order);
    
    const supabaseOrderPayload = {
      id: order.id,
      subtotal: order.subtotal,
      discount: order.discount,
      total: order.total,
      discountCode: order.discountCode,
      status: order.status,
      date: order.date,
      customer: order.customer,
      phone: order.phone,
      phoneAlt: order.phoneAlt, 
      email: order.email,
      address: order.address,
      city: order.city,
      notes: order.notes,
      items: JSON.stringify(order.items),
      timestamps: JSON.stringify(order.timestamps)
    };

    // إرسال الأوردر لـ Supabase
    const { error: orderError } = await supabase.from('orders').insert([supabaseOrderPayload]);
    
    // 🎯 التعديل الجوهري هنا: حماية السلة والأوردر في حال الفشل
    if (orderError) {
      console.error("❌ خطأ حرج أثناء إرسال الأوردر لـ Supabase:", orderError);
      alert(`فشل حفظ الأوردر أونلاين: ${orderError.message}`);
      return { success: false, error: orderError.message }; // ⬅️ يوقف الدالة فوراً ويمنع مسح السلة وفتح واتساب
    }

    console.log("🚀 ORDER SUCCESSFULLY SAVED TO SUPABASE!");

    // تسييف الإشعارات المحلية
    const notifications = db.getAll('notifications') || [];
    notifications.unshift({ id: Date.now(), type: 'new_order', orderId: order.id, customer: order.customer, total: order.total, read: false, timestamp: new Date().toISOString() });
    db.setAll('notifications', notifications.slice(0, 50));

    if (appliedDiscount) {
      const newCount = (appliedDiscount.usageCount ?? 0) + 1;
      db.update('discounts', appliedDiscount.id, { usageCount: newCount });
      await supabase.from('coupons').update({ usageCount: newCount }).eq('id', appliedDiscount.id);
      saveAppliedDiscount(null);
      set({ appliedDiscount: null });
    }

    // فتح محادثة الواتساب الفورية
    try {
      let itemsText = order.items.map(item => {
        const details = [];
        if (item.size) details.push(item.size);
        if (item.color) details.push(item.color);
        const detailsStr = details.length > 0 ? ` (${details.join('/')})` : '';
        return `• ${item.name}${detailsStr} ×${item.qty} — EGP ${item.price}`;
      }).join('\n');

      let discountLine = '';
      if (order.discountCode && order.discount > 0) {
        discountLine = `\n🎁 Discount (${order.discountCode}): -EGP ${order.discount.toLocaleString()}`;
      }

      const whatsappMessage = 
        `🛍️ New Order — ${order.id}\n\n` +
        `👤 Customer: ${order.customer}\n` +
        `📞 Phone: ${order.phone}\n` +
        `📞 Alternative Phone: ${order.phoneAlt || 'None'}\n` +
        `📧 Email: ${order.email}\n` +
        `📍 Address: ${order.address}${order.city ? ', ' + order.city : ''}\n\n` +
        `Items:\n${itemsText}\n${discountLine}\n` +
        `💰 Total: EGP ${order.total.toLocaleString()}\n\n` +
        `📝 Notes: ${order.notes || 'None'}`;

      const phoneNumber = "201013380313"; 
      const whatsappUrl = `https://api.whatsapp.com/send/?phone=${phoneNumber}&text=${encodeURIComponent(whatsappMessage)}&type=phone_number&app_absent=0`;

      window.open(whatsappUrl, '_blank');
    } catch (wsErr) {
      console.error("Failed to open WhatsApp:", wsErr);
    }
    
    // مسح السلة وتحديث البيانات فقط بعد التأكد من نجاح العملية 
    clearCart();
    get().refreshProducts();
    get().refreshOrders();
    
    set({ 
      unreadOrderCount: notifications.filter(n => !n.read).length, 
      newOrderNotification: { order: sanitizeOrder(order, products), timestamp: Date.now() } 
    });

    return { success: true, order: sanitizeOrder(order, products) };
  },
  
  updateOrderStatus: async (id, newStatus) => {
    const order = db.findById('orders', id);
    if (!order) return { success: false, error: 'Order not found' };
    
    const oldStatus = order.status;
    const timestamps = { ...(order.timestamps || {}), [newStatus.toLowerCase()]: new Date().toISOString() };
    
    let orderItems = [];
    if (order.items) {
      if (typeof order.items === 'string') {
        try {
          orderItems = JSON.parse(order.items);
        } catch (e) {
          console.error("Error parsing order items in updateOrderStatus:", e);
          orderItems = [];
        }
      } else if (Array.isArray(order.items)) {
        orderItems = order.items;
      }
    }

    if (newStatus.toLowerCase() === 'cancelled' && oldStatus.toLowerCase() !== 'cancelled') {
      const products = get().products;
      for (const item of orderItems) {
        const product = products.find(p => p.id == item.productId);
        if (product) {
          const newStock = (product.stock || 0) + Number(item.qty);
          const variantKey = `${item.size}-${item.color}`;
          const updatedVariantStock = { ...(product.variantStock || {}) };
          if (updatedVariantStock[variantKey] !== undefined) {
            updatedVariantStock[variantKey] = Number(updatedVariantStock[variantKey]) + Number(item.qty);
          }
          db.update('products', product.id, { stock: newStock, variantStock: updatedVariantStock, updatedAt: new Date().toISOString() });
          await supabase.from('products').update({ stock: newStock, variantStock: updatedVariantStock }).eq('id', product.id);
        }
      }
    }
    else if (oldStatus.toLowerCase() === 'cancelled' && newStatus.toLowerCase() !== 'cancelled') {
      const products = get().products;
      for (const item of orderItems) {
        const product = products.find(p => p.id == item.productId);
        if (product) {
          const newStock = Math.max(0, (product.stock || 0) - Number(item.qty));
          const variantKey = `${item.size}-${item.color}`;
          const updatedVariantStock = { ...(product.variantStock || {}) };
          if (updatedVariantStock[variantKey] !== undefined) {
            updatedVariantStock[variantKey] = Math.max(0, Number(updatedVariantStock[variantKey]) - Number(item.qty));
          }
          db.update('products', product.id, { stock: newStock, variantStock: updatedVariantStock });
          await supabase.from('products').update({ stock: newStock, variantStock: updatedVariantStock }).eq('id', product.id);
        }
      }
    }

    db.update('orders', id, { status: newStatus, timestamps });
    set({ orders: getSanitizedOrders() });
    await supabase.from('orders').update({ status: newStatus }).eq('id', id);
    get().refreshProducts();
    return { success: true };
  },

  deleteOrder: async (id) => {
    db.delete('orders', id);
    set({ orders: getSanitizedOrders() });
    await supabase.from('orders').delete().eq('id', id);
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

    const supabaseCouponPayload = {
      id: discount.id,
      code: discount.code ? discount.code.trim().toUpperCase() : '',
      type: discount.type || 'percentage',
      value: discount.value || 0,
      active: discount.active ?? true,
      description: discount.description || '',
      startDate: discount.startDate,
      endDate: discount.endDate,
      usageLimit: discount.usageLimit || 0,
      usageCount: discount.usageCount || 0,
      createdAt: discount.createdAt
    };

    const { error } = await supabase.from('coupons').insert([supabaseCouponPayload]);
    if (error) console.error("Supabase Coupons Insert Error:", error);
    return discount; 
  },
  
  updateDiscount: async (id, updates) => { 
    db.update('discounts', id, updates); 
    set({ discounts: db.getAll('discounts') || [] }); 
    await supabase.from('coupons').update(updates).eq('id', id);
  },
  deleteDiscount: async (id) => { 
    db.delete('discounts', id); 
    set({ discounts: db.getAll('discounts') || [] }); 
    await supabase.from('coupons').delete().eq('id', id);
  },
  applyDiscount: (code) => {
    const normalized = (code ?? '').trim().toUpperCase();
    if (!normalized) return { success: false, error: 'Please enter a discount code' };
    const discounts = get().discounts;
    const today = new Date().toISOString().split('T')[0];
    const d = discounts.find(
      x => x.code === normalized &&
        x.active &&
        x.startDate <= today &&
        x.endDate >= today &&
        (x.usageCount ?? 0) < (x.usageLimit ?? 0)
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
  setPage: (p) => set({ currentPage: p }),
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