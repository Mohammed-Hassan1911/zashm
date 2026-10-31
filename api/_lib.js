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

const PUBLIC_BASE_URL = () => env('PUBLIC_BASE_URL') || 'https://za-shm.vercel.app';

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
  // Authenticated/admin responses must never be cached by a browser or proxy.
  // Setting it here covers every route, including error responses.
  try {
    if (typeof res.getHeader !== 'function' || !res.getHeader('Cache-Control')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.end(JSON.stringify(body));
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const allowed = (
    env('ALLOWED_ORIGINS') ||
    'https://za-shm.vercel.app,http://localhost:3000,http://127.0.0.1:3000'
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function handleOptions(req, res) {
  applyCors(req, res);
  res.statusCode = 204;
  res.end();
}

// ─── COOKIES + CSRF ──────────────────────────────────────────────────────────
// The admin session lives in an HttpOnly, Secure, SameSite=Strict cookie so
// JavaScript — and therefore XSS — cannot read or exfiltrate it. A companion
// non-HttpOnly `zashm_csrf` cookie implements the double-submit check: unsafe
// requests must echo its value in X-CSRF-Token. SameSite=Strict already blocks
// cross-site sends in modern browsers; CSRF + Origin are defence in depth.
const SESSION_COOKIE = 'zashm_session';
const CSRF_COOKIE = 'zashm_csrf';
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (was 8)

function parseCookies(req) {
  const out = {};
  const raw = req && req.headers && req.headers.cookie;
  if (typeof raw !== 'string' || !raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
    out[key] = value;
  }
  return out;
}

function appendSetCookie(res, cookie) {
  if (typeof res.appendHeader === 'function') {
    res.appendHeader('Set-Cookie', cookie);
    return;
  }
  let prev = null;
  try { prev = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : null; } catch (e) { prev = null; }
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

function cookieAttrs(maxAgeSeconds) {
  return `Path=/; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

function setSessionCookie(res, token, ttlMs = SESSION_TTL_MS) {
  appendSetCookie(
    res,
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(ttlMs / 1000)}; HttpOnly`
  );
}

function setCsrfCookie(res, token, ttlMs = SESSION_TTL_MS) {
  // Deliberately NOT HttpOnly: the SPA must read it to echo X-CSRF-Token.
  appendSetCookie(
    res,
    `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(ttlMs / 1000)}`
  );
}

function clearSessionCookie(res) {
  appendSetCookie(res, `${SESSION_COOKIE}=; ${cookieAttrs(0)}; HttpOnly`);
}

function clearCsrfCookie(res) {
  appendSetCookie(res, `${CSRF_COOKIE}=; ${cookieAttrs(0)}`);
}

function safeEqualText(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requestOriginAllowed(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return true; // non-browser client; SameSite still protects cookies
  return getAllowedOrigin(req) === origin;
}

function csrfHeaderValid(req) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE] || '';
  const headerToken = req.headers && req.headers['x-csrf-token'];
  return safeEqualText(cookieToken, headerToken);
}

function isUnsafeMethod(req) {
  const m = String((req && req.method) || 'GET').toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
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
  const vercelIp = req.headers['x-real-ip'];
  if (typeof vercelIp === 'string' && vercelIp.trim()) return vercelIp.trim();
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

// ─── DURABLE RATE LIMITING (optional Upstash Redis, in-memory fallback) ─────
// The in-memory buckets above only cover one warm serverless instance, so a
// determined attacker can multiply attempts by hitting fresh instances. When
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are configured, counters
// move to Upstash over its REST API (no SDK dependency, works on the Edge and
// Node runtimes). If the call fails or the variables are absent, we fall back
// to the SAME in-memory limiter — the API never fails open completely and never
// becomes unavailable just because Redis is down.
function upstashConfig() {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisPipeline(cmds) {
  const cfg = upstashConfig();
  if (!cfg) return null;
  const resp = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmds),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  const out = await resp.json();
  if (!Array.isArray(out)) throw new Error('Upstash bad response');
  return out.map((row) => (row && Object.prototype.hasOwnProperty.call(row, 'result') ? row.result : null));
}

function redisKey(key) {
  return `zashm:rl:${String(key).slice(0, 200)}`;
}

/**
 * Async, durable counterpart of rateLimit(). Always resolves to the same
 * { allowed, remaining, resetIn } shape. Use this in HTTP handlers; rateLimit()
 * stays synchronous for tests and as the fallback.
 */
async function rateLimitShared(key, maxAttempts, windowMs) {
  if (!upstashConfig()) return rateLimit(key, maxAttempts, windowMs);
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  try {
    const rk = redisKey(key);
    const out = await redisPipeline([
      ['INCR', rk],
      ['EXPIRE', rk, String(windowSec), 'NX'],
      ['TTL', rk],
    ]);
    const count = Number(out && out[0]);
    if (!Number.isFinite(count)) throw new Error('Upstash INCR failed');
    const ttl = Number(out && out[2]);
    const resetIn = Number.isFinite(ttl) && ttl > 0 ? ttl : windowSec;
    return {
      allowed: count <= maxAttempts,
      remaining: Math.max(0, maxAttempts - count),
      resetIn,
    };
  } catch (e) {
    // Redis outage must not take the store down. Keep the per-instance guard.
    console.warn('Durable rate limit unavailable, using in-memory fallback');
    return rateLimit(key, maxAttempts, windowMs);
  }
}

/** Read a durable counter without incrementing it (used by the coupon lockout). */
async function rateLimitPeekShared(key) {
  if (!upstashConfig()) {
    const b = rateBuckets.get(key);
    if (!b || b.resetAt < Date.now()) return { count: 0, resetIn: 0 };
    return { count: b.count, resetIn: Math.ceil((b.resetAt - Date.now()) / 1000) };
  }
  try {
    const rk = redisKey(key);
    const out = await redisPipeline([['GET', rk], ['TTL', rk]]);
    const count = Number(out && out[0]) || 0;
    const ttl = Number(out && out[1]);
    return { count, resetIn: Number.isFinite(ttl) && ttl > 0 ? ttl : 0 };
  } catch (e) {
    const b = rateBuckets.get(key);
    if (!b || b.resetAt < Date.now()) return { count: 0, resetIn: 0 };
    return { count: b.count, resetIn: Math.ceil((b.resetAt - Date.now()) / 1000) };
  }
}

/** Clear a counter in both stores (best effort). */
async function resetRateLimitShared(key) {
  rateBuckets.delete(key);
  if (!upstashConfig()) return;
  try {
    await redisPipeline([['DEL', redisKey(key)]]);
  } catch (e) {
    /* best effort */
  }
}

function tooMany(res, resetIn, extra) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(resetIn || 60))));
  return json(res, 429, Object.assign({
    error: `Too many attempts. Try again in ${Math.ceil((resetIn || 60) / 60)} minute(s).`,
    rateLimited: true,
  }, extra || {}));
}

// ─── SESSION TOKENS (HMAC signed, stateless) ────────────────────────────────
// SESSION_TTL_MS is defined with the cookie helpers above (4 hours).

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
  const sv = Number(
    user.session_version != null
      ? user.session_version
      : (user.sessionVersion != null ? user.sessionVersion : 0)
  ) || 0;
  const payload = {
    sub: String(user.id),
    role: String(user.role || ''),
    name: String(user.name || ''),
    email: String(user.email || ''),
    sv,
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

/**
 * Resolve the session from the HttpOnly cookie first, then from a legacy
 * Authorization: Bearer token. Returns { session, source } or null.
 * `source` is used by requirePerm to decide whether CSRF/Origin checks apply:
 * a cookie is attached automatically by the browser, a Bearer token is not.
 */
function readSession(req) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[SESSION_COOKIE];
  if (cookieToken) {
    const session = verifySession(cookieToken);
    if (session) return { session, source: 'cookie' };
  }
  const session = readBearer(req);
  if (session) return { session, source: 'bearer' };
  return null;
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

/** Returns the verified session or sends an error response and returns null.
 *
 * Re-reads the user row from the database on every privileged call so that a
 * role change, an account deletion, or (after applying
 * supabase/session_revocation.sql) a session-version bump takes effect
 * immediately instead of lingering for up to the 4h token TTL. The DB role is
 * authoritative — the role baked into the token is ignored. */
async function requirePerm(req, res, permission) {
  const auth = readSession(req);
  if (!auth) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  // Cookie-authenticated unsafe requests must pass Origin + double-submit CSRF.
  // Bearer tokens are immune (a cross-site page cannot read or set them).
  if (auth.source === 'cookie' && isUnsafeMethod(req)) {
    if (!requestOriginAllowed(req)) {
      json(res, 403, { error: 'Request origin is not allowed' });
      return null;
    }
    if (!csrfHeaderValid(req)) {
      json(res, 403, { error: 'CSRF validation failed' });
      return null;
    }
  }

  const token = auth.session;

  let row;
  try {
    const { data, error } = await supabaseAdmin()
      .from('users')
      .select('*')
      .eq('id', token.sub)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (e) {
    console.error('Session re-check failed:', e && e.message);
    json(res, 401, { error: 'Session could not be verified. Please sign in again.' });
    return null;
  }

  if (!row) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  const tokenSv = Number(token.sv || 0);
  const dbSv = Number(
    row.session_version != null
      ? row.session_version
      : (row.sessionVersion != null ? row.sessionVersion : 0)
  ) || 0;
  if (tokenSv !== dbSv) {
    json(res, 401, { error: 'Session expired. Please sign in again.' });
    return null;
  }

  const session = { ...token, role: String(row.role || '') };
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

// Convert Arabic-Indic (٠-٩) and Eastern Arabic (۰-۹) digits to ASCII.
function normalizeDigits(v) {
  return String(v)
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

// Normalize an Egyptian mobile number: Arabic digits → ASCII, strip common
// separators, and accept +20 / 0020 / 20 country-code forms.
function normalizePhone(v) {
  let s = normalizeDigits(v).trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('20') && s.length === 12 && s.charAt(2) === '1') s = '0' + s.slice(2);
  else if (s.length === 10 && s.charAt(0) === '1') s = '0' + s;
  return s;
}

// Current calendar date (YYYY-MM-DD) in Egypt time. The storefront applies and
// validates coupons using the visitor's local (Cairo) date, so the server must
// use the same timezone for expiry windows — otherwise a coupon that starts
// "today" is wrongly rejected for the first hours of the Cairo day (UTC lags).
function cairoDateString(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date || new Date());
  let year = '';
  let month = '';
  let day = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
  }
  return `${year}-${month}-${day}`;
}

function validateOrderPayload(body) {
  const errors = [];
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items || items.length < 1 || items.length > 30) {
    return { ok: false, errors: ['Your bag is empty or contains too many items. / سلة التسوق فارغة أو تحتوي على عدد كبير من المنتجات.'] };
  }

  const cleanItems = [];
  for (const raw of items) {
    const productId = intInRange(raw && raw.productId, 1, Number.MAX_SAFE_INTEGER);
    if (productId === null) { errors.push('Invalid product id / معرّف منتج غير صالح'); break; }
    const qty = intInRange(raw && raw.qty, 1, 20);
    if (qty === null) { errors.push('Invalid quantity for an item / كمية غير صالحة لمنتج'); break; }
    const size = str(raw.size).slice(0, 50);
    const color = str(raw.color).slice(0, 50);
    cleanItems.push({ productId, qty, size, color });
  }
  if (errors.length) return { ok: false, errors };

  const c = (body && body.customer) || {};
  const name = cleanText(c.name, 2, 100);
  const address = cleanText(c.address, 5, 300);
  const phone = normalizePhone(c.phone);
  const city = str(c.city).trim();

  if (name === null) errors.push('Please enter your full name (at least 2 characters). / يرجى إدخال اسمك الكامل (حرفان على الأقل).');
  if (!EGYPT_PHONE_RE.test(phone)) errors.push('Please enter a valid Egyptian mobile number (e.g. 01XXXXXXXXX). / يرجى إدخال رقم موبايل مصري صحيح (مثال: 01XXXXXXXXX).');
  const phoneAlt = c.phoneAlt ? normalizePhone(c.phoneAlt) : '';
  if (phoneAlt && (!EGYPT_PHONE_RE.test(phoneAlt) || phoneAlt === phone)) {
    errors.push('The alternative phone number is invalid or the same as the primary one. / رقم الهاتف البديل غير صالح أو مطابق لرقم الهاتف الأساسي.');
  }
  const email = str(c.email).trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) errors.push('Please enter a valid email address. / يرجى إدخال بريد إلكتروني صحيح.');
  if (address === null) errors.push('Please enter a complete street address (at least 5 characters). / يرجى إدخال عنوان شارع كامل (5 أحرف على الأقل).');
  if (!EGYPT_GOVERNORATES.includes(city)) errors.push('Please select your governorate from the list. / يرجى اختيار المحافظة من القائمة.');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    items: cleanItems,
    customer: { name, phone, phoneAlt, email, address, city, notes: str(c.notes).slice(0, 500) },
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

// ─── COUPON PRICING (single source of truth) ────────────────────────────────
// The coupons table grew two value columns over its lifetime: `value` (written
// by the console) and `discountValue` (legacy). Both are kept in sync by the
// admin API, but rows written before this fix may only have one of them. Every
// layer — admin validation, /api/coupons/validate, api/orders.js and the
// atomic_place_order() RPC — must resolve the SAME number, otherwise the price
// the customer sees can differ from the price that is charged. `value` wins
// when it is a usable number; `discountValue` is the fallback. Never call
// Number(row.value) directly.
function couponDiscountValue(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [row.value, row.discountValue];
  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

// Optional minimum cart subtotal (EGP). 0 / null / missing ⇒ no minimum.
function couponMinOrderAmount(row) {
  if (!row || typeof row !== 'object') return 0;
  const n = Number(row.minOrderAmount);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Optional absolute cap on the discount (EGP), mainly for percentage coupons.
// null / 0 / missing ⇒ no cap.
function couponMaxDiscount(row) {
  if (!row || typeof row !== 'object') return null;
  const n = Number(row.maxDiscount);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Compute the discount for a coupon row and an authoritative subtotal.
 * Returns { ok: true, discount, type, value } or { ok: false, reason }.
 * Mirrors supabase/atomic_place_order.sql exactly; keep them in sync.
 */
function computeCouponDiscount(coupon, subtotal) {
  const sub = Number(subtotal);
  if (!coupon || !Number.isFinite(sub) || sub <= 0) {
    return { ok: false, reason: 'invalid_subtotal' };
  }
  const min = couponMinOrderAmount(coupon);
  if (min > 0 && sub < min) return { ok: false, reason: 'min_order_amount' };

  const type = coupon.type === 'percentage' ? 'percentage' : 'fixed';
  const value = couponDiscountValue(coupon);
  if (value === null || value <= 0) return { ok: false, reason: 'invalid_value' };

  let discount = type === 'percentage'
    ? Math.round(sub * value / 100)
    : value;
  const cap = couponMaxDiscount(coupon);
  if (cap !== null) discount = Math.min(discount, cap);
  discount = Math.min(discount, sub); // never discount more than the cart
  discount = Math.max(0, Math.round(discount));
  if (discount <= 0) return { ok: false, reason: 'invalid_value' };
  return { ok: true, discount, type, value };
}

/**
 * True when the coupon is currently usable, ignoring the cart subtotal.
 * Kept in one place so /api/coupons/validate and api/orders.js can never
 * disagree about active / date window / usage limit. `today` is a Cairo
 * YYYY-MM-DD string.
 */
function couponIsRedeemable(row, today) {
  if (!row || typeof row !== 'object') return false;
  if (row.active !== true) return false;
  const start = str(row.startDate);
  const end = str(row.endDate);
  if (!start || !end || !(start <= today && end >= today)) return false;
  const used = Number(row.usageCount || 0);
  const limit = Number(row.usageLimit || 0);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || !(used < limit)) return false;
  return couponDiscountValue(row) !== null;
}

function validateCouponPayload(d) {
  const errors = [];
  const code = str(d.code).trim().toUpperCase();
  const type = str(d.type) === 'fixed' ? 'fixed' : 'percentage';

  // Accept either column name; the canonical `value` wins when both are given.
  const rawValue = (d.value !== undefined && d.value !== null && d.value !== '')
    ? d.value
    : d.discountValue;
  const value = numInRange(rawValue, 0, 1000000);
  const startDate = str(d.startDate);
  const endDate = str(d.endDate);
  const usageLimit = intInRange(d.usageLimit, 0, 1000000);

  // Optional constraints. Missing / empty / 0 ⇒ disabled.
  let minOrderAmount = 0;
  if (d.minOrderAmount !== undefined && d.minOrderAmount !== null && d.minOrderAmount !== '') {
    const n = numInRange(d.minOrderAmount, 0, 10000000);
    if (n === null) errors.push('A valid minimum order amount is required');
    else minOrderAmount = n;
  }
  let maxDiscount = null;
  if (d.maxDiscount !== undefined && d.maxDiscount !== null && d.maxDiscount !== '') {
    const n = numInRange(d.maxDiscount, 0, 10000000);
    if (n === null) errors.push('A valid maximum discount is required');
    else if (n > 0) maxDiscount = n;
  }

  if (!COUPON_CODE_RE.test(code)) errors.push('A valid coupon code is required');
  if (value === null || value <= 0) errors.push('A valid discount value is required');
  if (type === 'percentage' && value !== null && value > 100) {
    errors.push('Percentage discount cannot exceed 100');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    errors.push('Valid start/end dates are required');
  }
  if (endDate && startDate && endDate < startDate) errors.push('End date must be after the start date');
  if (usageLimit === null) errors.push('A valid usage limit is required');
  if (errors.length) return null;

  return {
    code,
    type,
    value,
    // Mirror into the legacy column so every reader agrees.
    discountValue: value,
    startDate,
    endDate,
    usageLimit,
    minOrderAmount,
    maxDiscount,
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

  // SEC-C: 12+ characters for every NEW or CHANGED password. Existing
  // passwords are never forced to change — login does not use this validator.
  const MIN_PASSWORD = 12;
  let password = null;
  if (requirePassword) {
    password = str(u.password);
    if (password.length < MIN_PASSWORD || password.length > 128) {
      errors.push(`Password must be ${MIN_PASSWORD}-128 characters`);
    }
  } else if (u.password !== undefined && u.password !== null && u.password !== '') {
    password = str(u.password);
    if (password.length < MIN_PASSWORD || password.length > 128) {
      errors.push(`Password must be ${MIN_PASSWORD}-128 characters`);
    }
  }

  if (errors.length) return null;
  return { name, email, role, password };
}

const ORDER_STATUSES = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];

// ─── ORDER HELPERS ──────────────────────────────────────────────────────────

function generateOrderId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  // crypto randomness (not Math.random) so ids cannot be predicted/raced.
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
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

/** Masks customer PII for ID-only tracking lookups; `phone` is intentionally
 * kept so the customer sees the number they submitted on the first check. */
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
  // Telegram uses Markdown: user-controlled text must not be able to inject
  // markup OR new lines (a newline could fake extra order lines / prices).
  return String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[_*`[\]()~>#+=|{}.!-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Converts a phone to an international dial string for https://wa.me/ links
 * (Egyptian 01x... → 20 1x..., "+2..." kept, otherwise "+20" is prepended). */
function waNumber(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return '';
  if (d.charAt(0) === '0') d = '20' + d.slice(1);
  else if (!d.startsWith('20')) d = '20' + d;
  return d;
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
      const details = [item.size, item.color].filter(Boolean);
      const detailsStr = details.length
        ? ` (${mdSafe(details.join(' / '))})`
        : '';
      return `▪️ ${mdSafe(item.name)}${detailsStr} × ${Number(item.qty || 0)} — EGP ${Number(item.price || 0).toLocaleString()}`;
    })
    .join('\n');
  const shippingLine = order.shippingCost
    ? `• الشحن: EGP ${Number(order.shippingCost).toLocaleString()}\n`
    : '';
  return `
✨ *ZASHM | طلب جديد* ✨
━━━━━━━━━━━━━━
👤 *بيانات العميل*
• الاسم: ${mdSafe(order.customer)}
• الهاتف: ${mdSafe(order.phone)} — [واتساب](https://wa.me/${waNumber(order.phone)})
• هاتف بديل: ${mdSafe(order.phoneAlt) || 'لا يوجد'}
• الإيميل: ${mdSafe(order.email) || 'غير محدد'}
📍 *عنوان الشحن*
• المدينة: ${mdSafe(order.city) || 'غير محدد'}
• العنوان: ${mdSafe(order.address)}
• ملاحظات: ${mdSafe(order.notes) || 'لا توجد'}
🛍 *المنتجات*
${itemsText || 'لا توجد منتجات'}
━━━━━━━━━━━━━━
💰 *ملخص الحساب*
• المجموع الفرعي: EGP ${Number(order.subtotal || 0).toLocaleString()}
${shippingLine}• كود الخصم: ${mdSafe(order.discountCode) || 'لا يوجد'}
• قيمة الخصم: EGP ${Number(order.discount || 0).toLocaleString()}
💵 *الإجمالي: EGP ${Number(order.total || 0).toLocaleString()}*
🔗 *تتبع الطلب*
${trackingUrl}
🧾 رقم الطلب: ${mdSafe(order.id)}
━━━━━━━━━━━━━━
💚 حابين نأكد مع حضرتك الأوردر، ولو عندك أي استفسار إحنا تحت أمرك في أي وقت.
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
  // ISO-BMFF: an MP4 also starts with `....ftyp`, so verify the actual brand
  // instead of accepting any ftyp box. AVIF uses major brand avif/avis (or a
  // compatible brand in the box's brand list).
  if (buf.length >= 16 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const size = Math.min(Number(buf.readUInt32BE(0)) || 0, buf.length, 256);
    const major = buf.toString('ascii', 8, 12);
    if (major === 'avif' || major === 'avis') return 'image/avif';
    for (let off = 16; off + 4 <= size; off += 4) {
      const brand = buf.toString('ascii', off, off + 4);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
  }
  return null;
}

function sanitizeStoragePath(path) {
  const p = String(path || '');
  if (!p || p.length > 512 || p.startsWith('/') || p.includes('\\')) return null;
  const segments = p.split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9._ -]{1,120}$/.test(segment) || segment === '.' || segment === '..')) return null;
  if (!/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(p)) return null;
  return p;
}

// Only public objects from this configured Supabase project and products bucket
// can be cleaned up. External or similarly-shaped URLs are never guessed.
const PRODUCT_STORAGE_URL_RE = /\/storage\/v1\/object\/public\/products\/(.+)$/;

function filePathFromPublicUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (e) {
    return null;
  }
  let configuredHost;
  try {
    configuredHost = new URL(getSupabaseUrl()).hostname;
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== configuredHost) return null;
  const m = PRODUCT_STORAGE_URL_RE.exec(parsed.pathname);
  if (!m) return null;
  try {
    return sanitizeStoragePath(decodeURIComponent(m[1]));
  } catch (e) {
    return null;
  }
}

/** Collects every trusted storage path referenced by a product row. */
function pathsFromProductImageFields(row) {
  const paths = new Set();
  const push = (u) => {
    const p = filePathFromPublicUrl(u);
    if (p) paths.add(p);
  };
  if (row) {
    if (Array.isArray(row.images)) row.images.forEach(push);
    if (row.image) push(row.image);
    if (row.sizeGuide) push(row.sizeGuide);
  }
  return [...paths];
}

/** Paths referenced by products NOT in excludeIds (i.e. still owned by others). */
async function storagePathsUsedByOtherProducts(sb, excludeIds) {
  const excluded = new Set((excludeIds || []).map(String));
  const used = new Set();
  const productRows = await readAllRows(sb, 'products', 'id, images, image, sizeGuide');
  for (const row of productRows) {
    if (excluded.has(String(row.id))) continue;
    for (const path of pathsFromProductImageFields(row)) used.add(path);
  }
  const orders = await readAllRows(sb, 'orders', 'items');
  for (const order of orders) collectStoragePaths(order.items, used);
  return used;
}

async function readAllRows(sb, table, columns) {
  const rows = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    let query = sb.from(table).select(columns);
    if (typeof query.order === 'function') query = query.order('id', { ascending: true });
    const { data, error } = typeof query.range === 'function'
      ? await query.range(offset, offset + pageSize - 1)
      : await query;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error(`Could not verify image references in ${table}.`);
    const page = data;
    rows.push(...page);
    if (page.length < pageSize || typeof query.range !== 'function') return rows;
    offset += page.length;
  }
}

function collectStoragePaths(value, paths) {
  if (typeof value === 'string') {
    const path = filePathFromPublicUrl(value);
    if (path) {
      paths.add(path);
      return;
    }
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error('Could not parse stored order items; image references were not changed.');
      }
      collectStoragePaths(parsed, paths);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStoragePaths(entry, paths));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStoragePaths(entry, paths));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isStorageObjectNotFound(error) {
  if (!error) return false;
  const status = Number(error.status || error.statusCode || 0);
  const msg = String((error.message || error.error || '') + ' ' + (error.name || '')).toLowerCase();
  if (status === 404) return true;
  return /(object not found|resource was not found|not found|does not exist|no such key|no such object)/.test(msg);
}

/**
 * Removes a set of storage files one by one. Every call is an explicit
 * `remove()` whose returned `error` is inspected (a throw is a bonus). A file
 * that no longer exists is treated as already cleaned (idempotent success so
 * previously-leaked orphans get resolved on a re-run). Real errors are retried
 * a limited number of times, then reported — never swallowed silently.
 */
async function removeStorageFiles(sb, paths, retries = 2) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  const removed = [];
  const failed = [];
  for (const path of unique) {
    let ok = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { error } = await sb.storage.from('products').remove([path]);
        if (!error) { ok = true; break; }
        if (isStorageObjectNotFound(error)) { ok = true; break; }
      } catch (e) {
        // transient failure — a limited retry happens below
      }
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
    if (ok) removed.push(path);
    else failed.push(path);
  }
  return { removed, failed };
}

async function cleanupUnreferencedProductImages(sb, candidatePaths) {
  const candidates = [...new Set((candidatePaths || []).map(sanitizeStoragePath).filter(Boolean))];
  if (!candidates.length) return { removed: [], failed: [], shared: [] };

  const referenced = await storagePathsUsedByOtherProducts(sb, []);
  const shared = candidates.filter((path) => referenced.has(path));
  const unreferenced = candidates.filter((path) => !referenced.has(path));
  const result = await removeStorageFiles(sb, unreferenced);
  return { ...result, shared };
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
  rateLimitShared,
  rateLimitPeekShared,
  resetRateLimitShared,
  tooMany,
  signSession,
  verifySession,
  readBearer,
  readSession,
  parseCookies,
  setSessionCookie,
  setCsrfCookie,
  clearSessionCookie,
  clearCsrfCookie,
  newCsrfToken,
  requestOriginAllowed,
  SESSION_TTL_MS,
  SESSION_COOKIE,
  CSRF_COOKIE,
  can,
  requirePerm,
  hashPassword,
  verifyPassword,
  trackToken,
  verifyTrackToken,
  trackingUrlFor,
  PUBLIC_BASE_URL,
  validateOrderPayload,
  cairoDateString,
  validateProductPayload,
  validateCouponPayload,
  couponDiscountValue,
  couponMinOrderAmount,
  couponMaxDiscount,
  computeCouponDiscount,
  couponIsRedeemable,
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
  pathsFromProductImageFields,
  storagePathsUsedByOtherProducts,
  removeStorageFiles,
  cleanupUnreferencedProductImages,
  EMAIL_RE,
  EGYPT_PHONE_RE,
  COUPON_CODE_RE,
};
