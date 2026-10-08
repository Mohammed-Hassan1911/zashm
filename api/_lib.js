'use strict';

/**
 * ZASHM server-side security library (Vercel serverless functions).
 *
 * Server secrets (never sent to the browser):
 *   SUPABASE_SERVICE_ROLE_KEY  - database admin access (service role)
 *   SESSION_SECRET             - HMAC secret for session + tracking tokens
 *   TELEGRAM_BOT_TOKEN         - Telegram bot token (rotated; old one is compromised)
 *   TELEGRAM_CHAT_ID           - Telegram chat that receives order notifications
 *   ALLOWED_ORIGINS            - optional CSV of allowed browser origins for CORS
 *
 * Public (safe to expose): SUPABASE_URL / REACT_APP_SUPABASE_URL, anon key (client only).
 */

const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

function getSupabaseUrl() {
  return env('SUPABASE_URL') || env('REACT_APP_SUPABASE_URL');
}

function requireSecret(name) {
  const v = env(name);
  if (!v) throw new Error(`Server is not configured: missing ${name}`);
  return v;
}

const PUBLIC_BASE_URL = () => env('PUBLIC_BASE_URL') || 'https://zashm-mo.vercel.app';

// ─── SUPABASE (SERVICE ROLE) ────────────────────────────────────────────────

let _supabaseAdmin = null;
function supabaseAdmin() {
  if (_supabaseAdmin) return _supabaseAdmin;
  const { createClient } = require('@supabase/supabase-js');
  const url = getSupabaseUrl();
  const key = requireSecret('SUPABASE_SERVICE_ROLE_KEY');
  if (!url) throw new Error('Server is not configured: missing SUPABASE URL');
  _supabaseAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabaseAdmin;
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────────────

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = (
    env('ALLOWED_ORIGINS') ||
    'https://zashm-mo.vercel.app,http://localhost:3000,http://127.0.0.1:3000'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function applyCors(req, res) {
  const origin = getAllowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function handleOptions(req, res) {
  applyCors(req, res);
  res.statusCode = 204;
  res.end();
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ─── SERVER-SIDE RATE LIMITING (per warm instance) ──────────────────────────

const rateBuckets = new Map();
let rateSweepAt = 0;

function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  if (now > rateSweepAt) {
    rateSweepAt = now + 5 * 60 * 1000;
    for (const [k, b] of rateBuckets) {
      if (b.resetAt < now) rateBuckets.delete(k);
    }
  }
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  const allowed = bucket.count <= maxAttempts;
  return {
    allowed,
    remaining: Math.max(0, maxAttempts - bucket.count),
    resetIn: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

function resetRateLimit(key) {
  rateBuckets.delete(key);
}

function tooMany(res, resetIn, extra) {
  return json(res, 429, Object.assign({
    error: `Too many attempts. Try again in ${Math.ceil((resetIn || 60) / 60)} minute(s).`,
    rateLimited: true,
  }, extra || {}));
}

// ─── SESSION TOKENS (HMAC signed, stateless) ────────────────────────────────

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours — matches client session

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64');
}

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest();
}

function signSession(user) {
  const secret = requireSecret('SESSION_SECRET');
  const now = Date.now();
  const payload = {
    sub: String(user.id),
    role: String(user.role || ''),
    name: String(user.name || ''),
    email: String(user.email || ''),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const encoded = b64url(JSON.stringify(payload));
  const sig = hmac(encoded, secret).toString('hex');
  return `${encoded}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  try {
    const secret = requireSecret('SESSION_SECRET');
    const idx = token.lastIndexOf('.');
    const encoded = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = hmac(encoded, secret).toString('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(encoded).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (!payload.sub) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function readBearer(req) {
  const h = req.headers.authorization || '';
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  return verifySession(h.slice(7).trim());
}

// ─── PERMISSIONS (server-side, authoritative) ───────────────────────────────

const PERMISSIONS = {
  admin: ['*'],
  manager: [
    'products.read', 'products.write',
    'orders.read', 'orders.write',
    'discounts.read', 'discounts.write',
    'analytics.read', 'dashboard.read',
  ],
  support: ['orders.read', 'dashboard.read'],
};

function can(session, permission) {
  if (!session) return false;
  const perms = PERMISSIONS[session.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

/** Returns the verified session or sends an error response and returns null. */
function requirePerm(req, res, permission) {
  const session = readBearer(req);
  if (!session) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }
  if (!can(session, permission)) {
    json(res, 403, { error: 'Forbidden' });
    return null;
  }
  return session;
}

// ─── PASSWORD HASHING (scrypt, server-side only) ────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function legacyClean(password) {
  // exact transformation used by the legacy client-side SHA-256 hashes
  return String(password).replace(/["'\\]/g, '').trim();
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(legacyClean(password) + 'zashm_salt_2024', 'utf8').digest('hex');
}

function safeEqualHex(aHex, bHex) {
  try {
    const a = Buffer.from(String(aHex), 'utf8');
    const b = Buffer.from(String(bHex), 'utf8');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Verifies a password against the stored value.
 * Returns { valid, needsRehash }.
 *  - scrypt$...   -> current scheme
 *  - 64-hex       -> legacy SHA-256 + static salt (upgraded on next login)
 *  - anything else-> legacy plaintext row (verified once, then upgraded to scrypt;
 *                     no plaintext is ever stored, logged or returned from now on)
 */
async function verifyPassword(password, stored) {
  const value = String(stored || '');
  if (!value) return { valid: false, needsRehash: false };

  if (value.startsWith('scrypt$')) {
    const parts = value.split('$');
    if (parts.length !== 6) return { valid: false, needsRehash: false };
    const [, N, r, p, saltHex, hashHex] = parts;
    try {
      const derived = await new Promise((resolve, reject) => {
        crypto.scrypt(
          String(password),
          Buffer.from(saltHex, 'hex'),
          parseInt(hashHex.length / 2, 10) || SCRYPT.keylen,
          { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10) },
          (err, dk) => (err ? reject(err) : resolve(dk))
        );
      });
      return { valid: safeEqualHex(derived.toString('hex'), hashHex), needsRehash: false };
    } catch (e) {
      return { valid: false, needsRehash: false };
    }
  }

  if (/^[a-f0-9]{64}$/i.test(value)) {
    return { valid: safeEqualHex(legacySha256(password), value.toLowerCase()), needsRehash: true };
  }

  const clean = legacyClean(password);
  const valid = safeEqualHex(
    crypto.createHash('sha256').update(clean, 'utf8').digest('hex'),
    crypto.createHash('sha256').update(value, 'utf8').digest('hex')
  );
  return { valid, needsRehash: true };
}

// ─── TRACKING TOKENS (stateless, no schema change) ──────────────────────────

function trackToken(orderId) {
  const secret = requireSecret('SESSION_SECRET');
  return hmac(`track:${orderId}`, secret).toString('hex').slice(0, 32);
}

function verifyTrackToken(orderId, token) {
  if (!orderId || !token || typeof token !== 'string') return false;
  return safeEqualHex(trackToken(orderId), token);
}

function trackingUrlFor(orderId) {
  return `${PUBLIC_BASE_URL()}/?track=${encodeURIComponent(orderId)}&tk=${trackToken(orderId)}`;
}

// ─── VALIDATION HELPERS ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EGYPT_PHONE_RE = /^01[0125][0-9]{8}$/;
const COUPON_CODE_RE = /^[A-Za-z0-9_-]{3,30}$/;

const EGYPT_GOVERNORATES = [
  'Cairo', 'Giza', 'Alexandria', 'Dakahlia', 'Sharqia', 'Qalyubia', 'Monufia',
  'Beheira', 'Kafr El Sheikh', 'Gharbia', 'Fayoum', 'Beni Suef', 'Minya',
  'Assiut', 'Sohag', 'Qena', 'Luxor', 'Aswan', 'Red Sea', 'North Sinai',
  'South Sinai', 'Ismailia', 'Suez', 'Port Said', 'Damietta', 'Matrouh',
  'New Valley',
];

// NOTE: must stay in sync with src/lib/egyptCities.js (kept as separate copies
// because CRA cannot import files outside src/ and api/ cannot import ESM).
const REMOTE_CITIES = [
  'Assiut', 'Sohag', 'Qena', 'Luxor', 'Aswan', 'Red Sea', 'North Sinai',
  'South Sinai', 'Matrouh', 'New Valley',
];

function getShippingCost(city) {
  if (!city) return 0;
  return REMOTE_CITIES.includes(city) ? 100 : 65;
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function cleanText(v, min, max) {
  const s = str(v).replace(/[<>]/g, '').trim();
  if (s.length < min || s.length > max) return null;
  return s;
}

function intInRange(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function numInRange(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function isHttpsUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function validateOrderPayload(body) {
  const errors = [];
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items || items.length < 1 || items.length > 30) {
    errors.push('Invalid cart items');
    return null;
  }

  const cleanItems = [];
  for (const raw of items) {
    const productId = intInRange(raw && raw.productId, 1, Number.MAX_SAFE_INTEGER);
    if (productId === null) { errors.push('Invalid product id'); break; }
    const qty = intInRange(raw && raw.qty, 1, 20);
    if (qty === null) { errors.push('Invalid quantity for an item'); break; }
    const size = str(raw.size).slice(0, 50);
    const color = str(raw.color).slice(0, 50);
    cleanItems.push({ productId, qty, size, color });
  }
  if (errors.length) return null;

  const c = (body && body.customer) || {};
  const name = cleanText(c.name, 2, 100);
  const address = cleanText(c.address, 5, 300);
  const phone = str(c.phone).trim();
  const city = str(c.city).trim();

  if (name === null) errors.push('A valid full name is required');
  if (!EGYPT_PHONE_RE.test(phone)) errors.push('A valid phone number is required');
  const phoneAlt = str(c.phoneAlt).trim();
  if (phoneAlt && (!EGYPT_PHONE_RE.test(phoneAlt) || phoneAlt === phone)) {
    errors.push('Invalid alternative phone number');
  }
  const email = str(c.email).trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) errors.push('Invalid email address');
  if (address === null) errors.push('A valid street address is required');
  if (!EGYPT_GOVERNORATES.includes(city)) errors.push('A valid city is required');
  const notes = str(c.notes).slice(0, 500);

  if (errors.length) return null;

  return {
    items: cleanItems,
    customer: { name, phone, phoneAlt, email, address, city, notes },
  };
}

function validateProductPayload(p) {
  const errors = [];
  const name = cleanText(p.name, 1, 200);
  const category = cleanText(p.category, 1, 60);
  const price = numInRange(p.price, 1, 10000000);
  const stock = intInRange(p.stock, 0, 1000000);

  if (name === null) errors.push('Product name is required');
  if (category === null) errors.push('Category is required');
  if (price === null) errors.push('A valid price is required');
  if (stock === null) errors.push('A valid stock is required');

  let salePrice = null;
  if (p.salePrice !== null && p.salePrice !== undefined && p.salePrice !== '') {
    salePrice = numInRange(p.salePrice, 0, 10000000);
    if (salePrice === null) errors.push('Invalid sale price');
  }

  const strArr = (v, maxLen, maxItems) => {
    if (!Array.isArray(v)) return [];
    return v.slice(0, maxItems).map((x) => str(x).replace(/[<>]/g, '').slice(0, maxLen)).filter(Boolean);
  };

  const sizes = strArr(p.sizes, 40, 30);
  const colors = strArr(p.colors, 40, 30);

  const images = Array.isArray(p.images)
    ? p.images.slice(0, 6).map((u) => str(u).slice(0, 2000)).filter((u) => u && isHttpsUrl(u))
    : [];

  let variantStock = {};
  if (p.variantStock && typeof p.variantStock === 'object' && !Array.isArray(p.variantStock)) {
    const keys = Object.keys(p.variantStock).slice(0, 200);
    for (const k of keys) {
      const val = intInRange(p.variantStock[k], 0, 1000000);
      if (val === null) { errors.push('Invalid variant stock'); break; }
      variantStock[str(k).slice(0, 100)] = val;
    }
  }

  if (errors.length) return null;

  return {
    name,
    category,
    price,
    salePrice,
    stock,
    sizes,
    colors,
    images,
    variantStock,
    sku: str(p.sku).replace(/[<>]/g, '').slice(0, 60),
    label: str(p.label).replace(/[<>]/g, '').slice(0, 40),
    description: str(p.description).slice(0, 5000),
    sizeGuide: p.sizeGuide && isHttpsUrl(p.sizeGuide) ? str(p.sizeGuide).slice(0, 2000) : null,
    active: p.active === undefined ? true : Boolean(p.active),
  };
}

function validateCouponPayload(d) {
  const errors = [];
  const code = str(d.code).trim().toUpperCase();
  const type = str(d.type) === 'fixed' ? 'fixed' : 'percentage';
  const value = numInRange(d.value, 0, 1000000);
  const startDate = str(d.startDate);
  const endDate = str(d.endDate);
  const usageLimit = intInRange(d.usageLimit, 0, 1000000);

  if (!COUPON_CODE_RE.test(code)) errors.push('A valid coupon code is required');
  if (value === null) errors.push('A valid discount value is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    errors.push('Valid start/end dates are required');
  }
  if (usageLimit === null) errors.push('A valid usage limit is required');
  if (errors.length) return null;

  return {
    code,
    type,
    value,
    startDate,
    endDate,
    usageLimit,
    active: d.active === undefined ? true : Boolean(d.active),
    description: str(d.description).replace(/[<>]/g, '').slice(0, 200),
  };
}

function validateUserPayload(u, { requirePassword }) {
  const errors = [];
  const name = cleanText(u.name, 2, 80);
  const email = str(u.email).trim().toLowerCase();
  const role = ['admin', 'manager', 'support'].includes(str(u.role)) ? str(u.role) : null;

  if (name === null) errors.push('A valid name is required');
  if (email.length > 200 || !EMAIL_RE.test(email)) errors.push('A valid email is required');
  if (!role) errors.push('A valid role is required');

  let password = null;
  if (requirePassword) {
    password = str(u.password);
    if (password.length < 6 || password.length > 128) errors.push('Password must be 6-128 characters');
  } else if (u.password !== undefined && u.password !== null && u.password !== '') {
    password = str(u.password);
    if (password.length < 6 || password.length > 128) errors.push('Password must be 6-128 characters');
  }

  if (errors.length) return null;
  return { name, email, role, password };
}

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

// ─── ORDER HELPERS ──────────────────────────────────────────────────────────

function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ZSH-${timestamp}-${random}`;
}

function parseJsonField(value, fallback) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }
  return value === undefined || value === null ? fallback : value;
}

function parseOrderRow(row) {
  if (!row) return null;
  return {
    ...row,
    items: parseJsonField(row.items, []),
    timestamps: parseJsonField(row.timestamps, {}),
  };
}

/** Removes customer PII for unauthorized (ID-only) tracking lookups. */
function maskOrderForLimitedAccess(order) {
  return {
    ...order,
    customer: '',
    phone: '',
    phoneAlt: '',
    email: '',
    address: '',
    city: '',
    notes: '',
  };
}

// ─── TELEGRAM (server-side, secret token) ───────────────────────────────────

function mdSafe(v) {
  return String(v == null ? '' : v).replace(/[_*`[\]]/g, '').slice(0, 400);
}

async function sendTelegramNotification(messageText) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    console.warn('Telegram notification skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured');
    return false;
  }
  const clean = messageText.replace(/→/g, ':').replace(/_/g, '');
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: clean, parse_mode: 'Markdown' }),
  });
  return resp.ok;
}

function buildOrderTelegramMessage(order, trackingUrl) {
  const itemsText = (order.items || [])
    .map((item) => {
      const details = [];
      if (item.size) details.push(item.size);
      if (item.color) details.push(item.color);
      const detailsStr = details.length > 0 ? ` (${details.join('/')})` : '';
      const price = Number(item.price || 0);
      return `• *${mdSafe(item.name)}*${mdSafe(detailsStr)} x${Number(item.qty || 0)} → _EGP ${price.toLocaleString()}_`;
    })
    .join('\n');

  const shippingLine = order.shippingCost
    ? `\n• *قيمة الشحن:* EGP ${Number(order.shippingCost).toLocaleString()}`
    : '';

  return `
✨ *طلب جديد من متجر ZASHM* ✨
--------------------------------🟩

👤 *بيانات العميل:*
• *الاسم:* ${mdSafe(order.customer)}
• *رقم الهاتف الأساسي:* ${mdSafe(order.phone)}
• *رقم الهاتف البديل:* ${mdSafe(order.phoneAlt) || 'لا يوجد'}
• *البريد الإلكتروني:* ${mdSafe(order.email) || 'غير محدد'}

📍 *تفاصيل الشحن:*
• *المدينة:* ${mdSafe(order.city) || 'غير محدد'}
• *العنوان:* ${mdSafe(order.address)}
• *ملاحظات الطلب:* ${mdSafe(order.notes) || 'لا توجد'}

🛍 *المنتجات المطلوبة:*
${itemsText}

--------------------------------🟨
💰 *الملخص المالي:*
• *المجموع الفرعي:* EGP ${Number(order.subtotal || 0).toLocaleString()}${shippingLine}
• *كود الخصم المستخدم:* ${mdSafe(order.discountCode) || 'لا يوجد'}
• *قيمة الخصم:* EGP ${Number(order.discount || 0).toLocaleString()}
• *الإجمالي الكلي:* *EGP ${Number(order.total || 0).toLocaleString()}*

--------------------------------
🔗 *رابط تتبع الطلب الخاص بك:*
${trackingUrl}

--------------------------------
🔒 _رقم الطلب المرجعي: ${mdSafe(order.id)}_
_تم تسجيل الطلب وتأكيده بأمان عبر الموقع_
`.trim();
}

// ─── STORAGE HELPERS ────────────────────────────────────────────────────────

const ALLOWED_IMAGE_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function detectImageType(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return 'image/avif';
  return null;
}

function sanitizeStoragePath(path) {
  const p = String(path || '');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(p)) return null;
  if (p.includes('..')) return null;
  if (!/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(p)) return null;
  return p;
}

function filePathFromPublicUrl(url) {
  if (!url) return null;
  const parts = String(url).split('/products/');
  if (parts.length < 2) return null;
  return sanitizeStoragePath(parts[1]);
}

module.exports = {
  env,
  getSupabaseUrl,
  supabaseAdmin,
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
  resetRateLimit,
  tooMany,
  signSession,
  verifySession,
  readBearer,
  can,
  requirePerm,
  hashPassword,
  verifyPassword,
  trackToken,
  verifyTrackToken,
  trackingUrlFor,
  PUBLIC_BASE_URL,
  validateOrderPayload,
  validateProductPayload,
  validateCouponPayload,
  validateUserPayload,
  ORDER_STATUSES,
  EGYPT_GOVERNORATES,
  getShippingCost,
  generateOrderId,
  parseOrderRow,
  maskOrderForLimitedAccess,
  sendTelegramNotification,
  buildOrderTelegramMessage,
  detectImageType,
  sanitizeStoragePath,
  filePathFromPublicUrl,
  EMAIL_RE,
  EGYPT_PHONE_RE,
};
