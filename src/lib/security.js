import { supabase } from './supabase';

// ─── ZASHM SECURITY LAYER ─────────────────────────────────────────────────────
// Connected directly to Supabase cloud database with your specific tables

// ─── HASHING ──────────────────────────────────────────────────────────────────
export async function hashPassword(password) {
  if (!password) return '';
  
  // تنظيف صارم: يمسح الـ " والـ ' والـ \ نهائياً من أي مكان في النص لمنع تداخل رموز JSON
  const cleanPassword = password.toString().replace(/[\"\'\\]/g, '').trim();
  
  const encoder = new TextEncoder();
  const data = encoder.encode(cleanPassword + 'zashm_salt_2024');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  
  // تنظيف صارم للطرفين من كل أنواع علامات التنصيص الملتصقة بالنص الممرر
  const cleanPassword = password.toString().replace(/[\"\'\\]/g, '').trim();
  const cleanHash = hash.toString().replace(/[\"\'\\]/g, '').trim();
  
  console.log("📥 الباسورد الصافي تماماً الحين:", `_${cleanPassword}_`);
  console.log("🗄️ الـ Hash الصافي تماماً الحين:", `_${cleanHash}_`);
  
  const computed = await hashPassword(cleanPassword);
  const isSHA256 = /^[a-f0-9]{64}$/i.test(cleanHash);
  
  if (!isSHA256) {
    const isMatch = cleanPassword === cleanHash;
    console.log("🔄 نتيجة المقارنة كنص عادي:", isMatch);
    return isMatch;
  }
  
  const isMatch = computed === cleanHash;
  console.log("🔄 نتيجة المقارنة كـ كود متشفر:", isMatch);
  return isMatch;
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
const SESSION_KEY = 'zashm_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 hours

export function createSession(user) {
  const session = {
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    token: generateToken(),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION,
    lastActive: Date.now(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (Date.now() > session.expiresAt) {
      destroySession();
      return null;
    }
    session.lastActive = Date.now();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  } catch {
    return null;
  }
}

export function destroySession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function hasPermission(session, permission) {
  if (!session) return false;
  const PERMISSIONS = {
    admin: ['*'],
    manager: ['products.read', 'products.write', 'orders.read', 'orders.write', 'discounts.read', 'discounts.write', 'analytics.read'],
    support: ['orders.read'],
  };
  const perms = PERMISSIONS[session.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const rateLimitStore = new Map();

export function checkRateLimit(key, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const entry = rateLimitStore.get(key) || { attempts: 0, firstAttempt: now, blocked: false, blockedUntil: 0 };

  if (entry.blocked) {
    if (now < entry.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        resetIn: Math.ceil((entry.blockedUntil - now) / 1000),
        blocked: true,
      };
    }
    entry.blocked = false;
    entry.attempts = 0;
    entry.firstAttempt = now;
  }

  if (now - entry.firstAttempt > windowMs) {
    entry.attempts = 0;
    entry.firstAttempt = now;
  }

  entry.attempts++;
  rateLimitStore.set(key, entry);

  if (entry.attempts > maxAttempts) {
    entry.blocked = true;
    entry.blockedUntil = now + windowMs;
    rateLimitStore.set(key, entry);
    return { allowed: false, remaining: 0, resetIn: Math.ceil(windowMs / 1000), blocked: true };
  }

  return { allowed: true, remaining: maxAttempts - entry.attempts, resetIn: null, blocked: false };
}

export function resetRateLimit(key) {
  rateLimitStore.delete(key);
}

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────
export const validators = {
  required: (v, field) => (!v || String(v).trim() === '') ? `${field} is required` : null,
  minLength: (v, min, field) => String(v).length < min ? `${field} must be at least ${min} characters` : null,
  maxLength: (v, max, field) => String(v).length > max ? `${field} must be at most ${max} characters` : null,
  email: (v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'Invalid email address' : null,
  phone: (v) => !/^[\+]?[\d\s\-\(\)]{7,15}$/.test(v) ? 'Invalid phone number' : null,
  numeric: (v, field) => isNaN(Number(v)) ? `${field} must be a number` : null,
  positive: (v, field) => Number(v) <= 0 ? `${field} must be positive` : null,
  url: (v) => {
    try { new URL(v); return null; } catch { return 'Invalid URL'; }
  },
};

export function sanitizeInput(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim();
}

export function validateOrderForm(form) {
  const errors = {};
  const checks = [
    ['name', validators.required(form.name, 'Name')],
    ['name', validators.minLength(form.name, 2, 'Name')],
    ['phone', validators.required(form.phone, 'Phone')],
    ['phone', validators.phone(form.phone)],
    ['address', validators.required(form.address, 'Address')],
    ['address', validators.minLength(form.address, 5, 'Address')],
  ];
  checks.forEach(([field, err]) => { if (err && !errors[field]) errors[field] = err; });
  return errors;
}

export function validateProductForm(form) {
  const errors = {};
  const checks = [
    ['name', validators.required(form.name, 'Name')],
    ['category', validators.required(form.category, 'Category')],
    ['price', validators.required(form.price, 'Price')],
    ['price', validators.positive(form.price, 'Price')],
    ['stock', validators.required(form.stock, 'Stock')],
    ['stock', form.stock < 0 ? 'Stock cannot be negative' : null],
  ];
  checks.forEach(([field, err]) => { if (err && !errors[field]) errors[field] = err; });
  return errors;
}

export function validateLoginForm(form) {
  const errors = {};
  if (!form.email) errors.email = 'Email is required';
  else if (validators.email(form.email)) errors.email = validators.email(form.email);
  if (!form.password) errors.password = 'Password is required';
  else if (form.password.length < 6) errors.password = 'Password must be at least 6 characters';
  return errors;
}

// ─── CSRF TOKEN ───────────────────────────────────────────────────────────────
export function generateCSRFToken() {
  const token = generateToken();
  sessionStorage.setItem('csrf_token', token);
  return token;
}

export function getCSRFToken() {
  return sessionStorage.getItem('csrf_token') || generateCSRFToken();
}

// ─── ORDER ID GENERATOR ───────────────────────────────────────────────────────
export function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ZSH-${timestamp}-${random}`;
}

// ─── PAGINATION ───────────────────────────────────────────────────────────────
export function paginate(items, page, perPage) {
  const total = items.length;
  const totalPages = Math.ceil(total / perPage);
  const start = (page - 1) * perPage;
  const end = start + perPage;
  return {
    items: items.slice(start, end),
    total,
    totalPages,
    page,
    perPage,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// ─── SUPABASE LIVE DB (MAPPED TO YOUR EXACT TABLES) ──────────────────────────
class LocalDB {
  constructor() {
    this.prefix = 'zashm_db_';
    this.syncFromServer();
  }

  _getKey(store) {
    const map = { 'discounts': 'coupons', 'Coupons': 'coupons', 'coupons': 'coupons' };
    const actualStore = map[store] || store.toLowerCase();
    return `${this.prefix}${actualStore}`;
  }

  _getRealTableName(store) {
    const map = { 'discounts': 'coupons', 'Coupons': 'coupons', 'coupons': 'coupons' };
    return map[store] || store.toLowerCase();
  }

  getAll(store) {
    try {
      const raw = localStorage.getItem(this._getKey(store));
      return raw ? JSON.parse(raw) : []; 
    } catch { 
      return []; 
    }
  }

  setAll(store, data) {
    try {
      localStorage.setItem(this._getKey(store), JSON.stringify(data));
      if (store === 'discounts' || store === 'Coupons' || store === 'coupons') {
        localStorage.setItem(`${this.prefix}Coupons`, JSON.stringify(data));
        localStorage.setItem(`${this.prefix}discounts`, JSON.stringify(data));
        localStorage.setItem(`${this.prefix}coupons`, JSON.stringify(data));
      }
      this._uploadToServer(store, data);
      return true;
    } catch (e) {
      console.error("❌ Error inside setAll:", e);
      return false; 
    }
  }

   async syncFromServer() {
    const stores = ['users', 'coupons', 'products', 'orders'];
    
    try {
      for (const store of stores) {
        try {
          const { data, error } = await supabase.from(store).select('*');
          
          if (error) {
            console.warn(`⚠️ [SYNC] Skipping table [${store}] due to error/RLS:`, error.message);
            continue;
          }

          if (data) {
            let formattedData = data;
            
            if (store === 'users') {
              formattedData = data.map(u => ({
                id: u.id || u.Id,
                name: u.name,
                email: u.email ? u.email.trim().toLowerCase() : '',
                role: u.role,
                passwordHash: u.passwordhash,
                createdAt: u.createdate || u.creatdat || u.createdat || u.created_at,
                lastLogin: u.lastlogin || u['last login'] || u.last_login
              }));
            } else if (store === 'orders') {
              formattedData = data.map(o => ({
                id: o.id || o.Id,
                customer: o.customer || o.customername || o.name || '',
                phone: o.phone || o.customerphone || o.customer_phone || '',
                email: o.email || o.customeremail || '',
                address: o.address || '',
                city: o.city || '',
                subtotal: Number(o.subtotal || o.sub_total || 0),
                discount: Number(o.discount || 0),
                total: Number(o.total || o.totalprice || o.total_price || 0),
                discountCode: o.discountcode || o.discountCode || o.coupon || '',
                status: o.status || 'pending',
                date: o.date || o.createdate || o.created_at || new Date().toISOString(),
                items: typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []),
                shippingMethod: o.shippingmethod || o.shippingMethod || '',
                notes: o.notes || '',
                timestamps: o.timestamps || o.updated_at || new Date().toISOString()
              }));
            }

            localStorage.setItem(`${this.prefix}${store}`, JSON.stringify(formattedData));
            if (store === 'coupons') {
              localStorage.setItem(`${this.prefix}Coupons`, JSON.stringify(formattedData));
              localStorage.setItem(`${this.prefix}discounts`, JSON.stringify(formattedData));
            }
          }
        } catch (tableErr) {
          console.error(`💥 Unexpected error syncing [${store}]:`, tableErr);
        }
      }
    } catch (err) {
      console.warn(`Error parallel syncing from server:`, err);
    }
  }

  async _uploadToServer(store, data) {
    const table = this._getRealTableName(store);
    // منع الرفع التلقائي للمنتجات والأوردرات من دالة setAll لأن الـ Store يتعامل معها بشكل منفصل ومخصص لمنع الـ Double Sync
    if (table === 'products' || table === 'orders') return; 

    try {
      if (data && data.length > 0) {
        const payload = table === 'users' 
          ? data.map(u => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              passwordhash: u.passwordHash,
              createdate: u.createdAt,
              lastlogin: u.lastLogin
            }))
          : data;
        
        await supabase.from(table).upsert(payload);
      }
    } catch (err) {
      console.error(`❌ Error uploading to server table [${table}]:`, err.message);
    }
  }

  async insert(store, record) {
    const data = this.getAll(store);
    data.unshift(record);
    localStorage.setItem(this._getKey(store), JSON.stringify(data));
    if (store === 'discounts' || store === 'Coupons' || store === 'coupons') {
      localStorage.setItem(`${this.prefix}Coupons`, JSON.stringify(data));
      localStorage.setItem(`${this.prefix}discounts`, JSON.stringify(data));
      localStorage.setItem(`${this.prefix}coupons`, JSON.stringify(data));
    }

    const table = this._getRealTableName(store);
    
    // 🌟 تحديث ذكي: لو المنتج أو الأوردر مضافين بالفعل من الـ Store أونلاين، نكتفي بالحفظ المحلي فقط هنا وننهي العملية لمنع خطأ 409
    if (table === 'products' || table === 'orders') {
      console.log(`✅ [LocalDB] Record locally saved for [${table}]`);
      return true;
    }

    try {
      const nowISO = record.createdAt || new Date().toISOString();
      const recordToInsert = table === 'users'
        ? {
            id: record.id,
            name: record.name,
            email: record.email.trim().toLowerCase(),
            role: record.role,
            passwordhash: record.passwordHash, 
            lastlogin: record.lastLogin || null,
            createdate: nowISO
          }
        : record;

      const { error } = await supabase.from(table).upsert([recordToInsert]);
      if (error) throw error;
      
      console.log(`✅ [LocalDB] Record successfully created & synced permanently to table [${table}]`);
      return true;
    } catch (err) { 
      console.error(`❌ [LocalDB] فشل المزامنة المباشرة للسيرفر لجدول [${table}]:`, err.message);
      return false; 
    }
  }

  async update(store, id, updates) {
    const data = this.getAll(store);
    // 🌟 تحويل المقارنة لـ مرنة (==) لعدم تضارب الـ Types بين String و Number
    const idx = data.findIndex(r => r.id == id);
    if (idx === -1) return false;
    
    data[idx] = { ...data[idx], ...updates, updatedAt: new Date().toISOString() };
    localStorage.setItem(this._getKey(store), JSON.stringify(data));

    const table = this._getRealTableName(store);
    
    // لو التحديث جاي لمنتج أو أوردر، الـ Store بيحدث أونلاين بنفسه، فنكتفي بالتحديث المحلي هنا لمنع التكرار
    if (table === 'products' || table === 'orders') {
      console.log(`✅ [LocalDB] Local Update Success for [${table}] ID: ${id}`);
      return true;
    }

    try {
      let dbUpdates = { ...updates };
      
      if (table === 'users') {
        if (dbUpdates.passwordHash) { dbUpdates.passwordhash = dbUpdates.passwordHash; delete dbUpdates.passwordHash; }
        if (dbUpdates.createdAt) { dbUpdates.createdate = dbUpdates.createdAt; delete dbUpdates.createdAt; }
        if (dbUpdates.lastLogin) { dbUpdates.lastlogin = dbUpdates.lastLogin; delete dbUpdates.lastLogin; }
        if (dbUpdates.role) { dbUpdates.role = dbUpdates.role.toLowerCase(); } 
      }
      
      console.log(`🔄 [LocalDB] Attempting Permanent Server Update for [${table}] ID: ${id}`, dbUpdates);
      
      const { error } = await supabase.from(table).update(dbUpdates).eq('id', id);
      
      if (error) {
        console.error(`❌ [Supabase Update Error] في جدول ${table}:`, error.message);
        return false;
      }
      
      console.log(`✅ [LocalDB] Permanent Server Update Success for [${table}]`);
      return true;
    } catch (err) { 
      console.error("💥 Crash in DB Update:", err);
      return false; 
    }
  }

  async delete(store, id) {
    // 🌟 مقارنة مرنة هنا أيضاً لحذف آمن
    const data = this.getAll(store).filter(r => r.id != id);
    localStorage.setItem(this._getKey(store), JSON.stringify(data));

    try {
      await supabase.from(this._getRealTableName(store)).delete().eq('id', id);
      return true;
    } catch { return false; }
  }

  findById(store, id) {
    return this.getAll(store).find(r => r.id == id) || null;
  }

  query(store, predicate) {
    return this.getAll(store).filter(predicate);
  }
}

export const db = new LocalDB();

// ─── SEO META MANAGEMENT ─────────────────────────────────────────────────────
export function setPageMeta({ title, description, image, type = 'website' }) {
  document.title = `${title} | ZASHM Luxury Fashion`;

  const setMeta = (name, content, property = false) => {
    const selector = property ? `meta[property="${name}"]` : `meta[name="${name}"]`;
    let el = document.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      if (property) el.setAttribute('property', name);
      else el.setAttribute('name', name);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  };

  if (description) {
    setMeta('description', description);
    setMeta('og:description', description, true);
    setMeta('twitter:description', description);
  }
  setMeta('og:title', `${title} | ZASHM Luxury Fashion`, true);
  setMeta('og:type', type, true);
  setMeta('twitter:card', 'summary_large_image');
  setMeta('twitter:title', `${title} | ZASHM`);
  if (image) {
    setMeta('og:image', image, true);
    setMeta('twitter:image', image);
  }
}

export function generateStructuredData(product) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    image: product.images,
    brand: { '@type': 'Brand', name: 'ZASHM' },
    offers: {
      '@type': 'Offer',
      price: product.salePrice || product.price,
      priceCurrency: 'EGP',
      availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: product.rating,
      reviewCount: product.reviews,
    },
  };
}

// ─── IMAGE OPTIMIZATION ───────────────────────────────────────────────────────
export function getOptimizedImageUrl(url, { width = 600, quality = 80, format = 'webp' } = {}) {
  if (url && url.includes('unsplash.com')) {
    return `${url.split('?')[0]}?w=${width}&q=${quality}&fm=${format}&fit=crop&auto=format`;
  }
  if (url && url.includes('cloudinary.com')) {
    return url.replace('/upload/', `/upload/w_${width},q_${quality},f_${format}/`);
  }
  return url;
}

export function generateSrcSet(url) {
  const widths = [400, 600, 800, 1200];
  return widths.map(w => `${getOptimizedImageUrl(url, { width: w })} ${w}w`).join(', ');
}

// ─── ANALYTICS HELPERS ───────────────────────────────────────────────────────
export function trackEvent(event, data = {}) {
  if (window.gtag) {
    window.gtag('event', event, data);
  }
  const events = JSON.parse(localStorage.getItem('zashm_events') || '[]');
  events.push({ event, data, timestamp: new Date().toISOString() });
  localStorage.setItem('zashm_events', JSON.stringify(events.slice(-1000)));
}