import { supabase } from './supabase';

// ─── ZASHM SECURITY LAYER ─────────────────────────────────────────────────────
// Client-side hardening layer. All authentication, password verification,
// order writes and admin mutations now happen on the server (/api/*).
// This module keeps its public interface intact for existing components.

// ─── HASHING (compatibility helpers — server uses scrypt) ────────────────────
// Kept exported for interface compatibility. Random per-password salt via
// WebCrypto PBKDF2; never logs secrets; never compares plaintext.

export async function hashPassword(password) {
  if (!password) return '';
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const iterations = 100000;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2$${iterations}$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password, stored) {
  if (!password || !stored) return false;
  const value = String(stored).trim();

  if (value.startsWith('pbkdf2$')) {
    try {
      const [, iterations, saltHex, hashHex] = value.split('$');
      const salt = new Uint8Array(
        saltHex.match(/.{2}/g).map(h => parseInt(h, 16))
      );
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: parseInt(iterations, 10), hash: 'SHA-256' },
        key,
        256
      );
      const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
      return computed === hashHex;
    } catch {
      return false;
    }
  }

  // Legacy SHA-256 rows (verified without ever printing secrets).
  if (/^[a-f0-9]{64}$/i.test(value)) {
    const cleanPassword = String(password).replace(/["'\\]/g, '').trim();
    const data = new TextEncoder().encode(cleanPassword + 'zashm_salt_2024');
    const digest = await crypto.subtle.digest('SHA-256', data);
    const computed = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === value.toLowerCase();
  }

  // Plaintext rows are no longer accepted client-side (server upgrades them
  // transparently on the next successful login).
  return false;
}

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
const SESSION_KEY = 'zashm_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 hours (matches server TTL)

export function createSession(user, serverToken) {
  const session = {
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    token: serverToken || generateToken(),
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

// ─── RATE LIMITING (UX only — the server enforces the real limits) ───────────
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

// ─── CSRF TOKEN (kept for interface compatibility) ────────────────────────────
export function generateCSRFToken() {
  const token = generateToken();
  sessionStorage.setItem('csrf_token', token);
  return token;
}

export function getCSRFToken() {
  return sessionStorage.getItem('csrf_token') || generateCSRFToken();
}

// ─── ORDER ID GENERATOR (server generates real order ids) ─────────────────────
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
  const end = page * perPage;
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

// ─── LOCAL CACHE (localStorage) — local-only, never holds credentials ────────
// users / orders are NEVER stored here anymore (they contain password hashes
// and customer PII). Legacy copies are purged on load. Server reads/writes go
// through /api/* with the server session token.

const FORBIDDEN_STORES = new Set(['users', 'orders']);

class LocalDB {
  constructor() {
    this.prefix = 'zashm_db_';
    this._purgeSensitive();
  }

  _purgeSensitive() {
    try {
      // Legacy keys that may contain password hashes / customer PII.
      localStorage.removeItem('zashm_db_users');
      localStorage.removeItem('zashm_db_orders');
      // Legacy plaintext-ish session side channels.
      localStorage.removeItem('csrf_token');

      // Notifications move to sessionStorage (short-lived, tab-scoped).
      const legacyNotifications = localStorage.getItem('zashm_db_notifications');
      if (legacyNotifications && !sessionStorage.getItem('zashm_notifications')) {
        sessionStorage.setItem('zashm_notifications', legacyNotifications);
      }
      if (legacyNotifications) localStorage.removeItem('zashm_db_notifications');
    } catch {
      /* storage may be unavailable */
    }
  }

  _isForbidden(store) {
    return FORBIDDEN_STORES.has(String(store || '').toLowerCase());
  }

  _getKey(store) {
    const name = String(store || '').toLowerCase();
    if (name === 'notifications') return { key: 'zashm_notifications', storage: sessionStorage };
    const map = { 'discounts': 'coupons', 'coupons': 'coupons' };
    const actualStore = map[name] || name;
    return { key: `${this.prefix}${actualStore}`, storage: localStorage };
  }

  _getRealTableName(store) {
    const name = String(store || '').toLowerCase();
    const map = { 'discounts': 'coupons', 'coupons': 'coupons' };
    return map[name] || name;
  }

  getAll(store) {
    if (this._isForbidden(store)) return [];
    try {
      const { key, storage } = this._getKey(store);
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  setAll(store, data) {
    if (this._isForbidden(store)) return false;
    try {
      const { key, storage } = this._getKey(store);
      storage.setItem(key, JSON.stringify(data));
      const name = String(store || '').toLowerCase();
      if (name === 'discounts' || name === 'coupons') {
        localStorage.setItem(`${this.prefix}Coupons`, JSON.stringify(data));
        localStorage.setItem(`${this.prefix}discounts`, JSON.stringify(data));
        localStorage.setItem(`${this.prefix}coupons`, JSON.stringify(data));
      }
      return true;
    } catch (e) {
      console.error('Error inside setAll:', e);
      return false;
    }
  }

  // Refreshes the local cache with PUBLIC data only (products, active coupons).
  async syncFromServer() {
    try {
      const stores = ['products', 'coupons'];
      for (const store of stores) {
        try {
          const { data, error } = await supabase.from(store).select('*');
          if (error || !data) continue;
          let formatted = data;
          if (store === 'products') {
            formatted = data.map(p => ({
              ...p,
              images: p.images || (p.image ? [p.image] : []),
              colors: p.colors || [],
              sizes: p.sizes || [],
              active: p.active ?? true,
              reservedStock: p.reservedStock || 0,
              rating: p.rating || 0,
              reviews: p.reviews || 0,
            }));
          }
          this.setAll(store, formatted);
        } catch (tableErr) {
          console.error(`Unexpected error syncing [${store}]:`, tableErr);
        }
      }
    } catch (err) {
      console.warn('Error syncing from server:', err);
    }
  }

  async insert(store, record) {
    if (this._isForbidden(store)) return false;
    const data = this.getAll(store);
    data.unshift(record);
    return this.setAll(store, data);
  }

  async update(store, id, updates) {
    if (this._isForbidden(store)) return false;
    const data = this.getAll(store);
    const idx = data.findIndex(r => r.id == id);
    if (idx === -1) return false;
    data[idx] = { ...data[idx], ...updates, updatedAt: new Date().toISOString() };
    return this.setAll(store, data);
  }

  async delete(store, id) {
    if (this._isForbidden(store)) return false;
    const data = this.getAll(store).filter(r => r.id != id);
    return this.setAll(store, data);
  }

  findById(store, id) {
    if (this._isForbidden(store)) return null;
    return this.getAll(store).find(r => r.id == id) || null;
  }

  query(store, predicate) {
    if (this._isForbidden(store)) return [];
    return this.getAll(store).filter(predicate);
  }
}

export const db = new LocalDB();

// ─── SEO META MANAGEMENT ───────────────────────────────────────────────────────
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

// ─── ANALYTICS HELPERS ────────────────────────────────────────────────────────
export function trackEvent(event, data = {}) {
  if (window.gtag) {
    window.gtag('event', event, data);
  }
  const events = JSON.parse(localStorage.getItem('zashm_events') || '[]');
  events.push({ event, data, timestamp: new Date().toISOString() });
  localStorage.setItem('zashm_events', JSON.stringify(events.slice(-1000)));
}
