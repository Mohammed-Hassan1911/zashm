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
    let rejected = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (rejected) return;

      size += chunk.length;

      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;

        reject(
          Object.assign(
            new Error('Payload too large'),
            { status: 413 }
          )
        );

        // نوقف استقبال البيانات دون تدمير الاتصال بالكامل.
        req.resume();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (rejected) return;

      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString('utf8'))
        );
      } catch {
        reject(
          Object.assign(
            new Error('Invalid JSON body'),
            { status: 400 }
          )
        );
      }
    });

    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

function clientIp(req) {
  const vercelIp = req.headers['x-real-ip'];
  if (typeof vercelIp === 'string' && vercelIp.trim()) return vercelIp.trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ─── SERVER-SIDE RATE LIMITING (per warm instance) ──────────────────────────

// Bounded so a burst of unique keys (for example spoofed X-Real-IP values that
// reach a function directly) cannot grow the map without limit in a warm
// instance. Entries are swept on a timer and, under pressure, evicted oldest
// first. This limiter is a best-effort guard only; durable limits use Upstash.
const rateBuckets = new Map();
const RATE_BUCKET_MAX = 10000;
let rateSweepAt = 0;
let lastRateWarnAt = 0;

function warnRateLimitOnce(message) {
  const now = Date.now();
  if (now - lastRateWarnAt < 60 * 1000) return;
  lastRateWarnAt = now;
  console.warn(message);
}

function sweepRateBuckets(now) {
  for (const [k, b] of rateBuckets) {
    if (b.resetAt < now) rateBuckets.delete(k);
  }
  while (rateBuckets.size >= RATE_BUCKET_MAX) {
    const oldest = rateBuckets.keys().next();
    if (oldest.done) break;
    rateBuckets.delete(oldest.value);
  }
}

function rateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  if (now > rateSweepAt || rateBuckets.size >= RATE_BUCKET_MAX) {
    rateSweepAt = now + 5 * 60 * 1000;
    sweepRateBuckets(now);
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

// ─── SHARED RATE LIMITING (Upstash Redis, Supabase RPC, local fallback) ─────
// The in-memory buckets above only cover one warm serverless instance, so a
// determined attacker can multiply attempts by hitting fresh instances. When
// configured, Upstash is primary; the server-only Supabase RPC is the shared
// fallback. If neither shared provider is available, the bounded local guard
// keeps requests available while emitting a health warning.
function upstashConfig() {
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

const REDIS_TIMEOUT_MS = 1500;

async function redisPipeline(cmds) {
  const cfg = upstashConfig();
  if (!cfg) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const resp = await fetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmds),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
    const out = await resp.json();
    if (!Array.isArray(out)) throw new Error('Upstash bad response');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// A failed command is returned per-command by the Upstash pipeline, so a
// silent `null` would look like "no counter" and fail open. Treat it as an
// outage and use the shared database fallback.
function redisValue(row) {
  if (row && Object.prototype.hasOwnProperty.call(row, 'error')) {
    throw new Error('Upstash command failed');
  }
  return row && Object.prototype.hasOwnProperty.call(row, 'result') ? row.result : null;
}

function redisKey(key) {
  return `zashm:rl:${String(key).slice(0, 200)}`;
}

async function databaseRateLimit(key, maxAttempts, windowSec, action) {
  const hashedKey = crypto.createHash('sha256').update(String(key)).digest('hex');
  const { data, error } = await supabaseAdmin().rpc('zshm_rate_limit', {
    p_key: hashedKey,
    p_max_attempts: maxAttempts,
    p_window_seconds: windowSec,
    p_action: action,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || typeof result !== 'object') throw new Error('Database rate limiter returned an invalid response');
  return result;
}

function formatDatabaseRateLimit(result) {
  const count = Number(result && result.count);
  const resetIn = Number(result && result.resetIn);
  if (!Number.isFinite(count) || !Number.isFinite(resetIn) ||
      typeof result.allowed !== 'boolean') {
    throw new Error('Database rate limiter returned invalid counters');
  }
  return {
    allowed: result.allowed,
    remaining: Math.max(0, Number(result.remaining) || 0),
    resetIn,
  };
}

/**
 * Async, durable counterpart of rateLimit(). Always resolves to the same
 * { allowed, remaining, resetIn } shape. Use this in HTTP handlers; rateLimit()
 * stays synchronous for tests and as the fallback.
 *
 * Counters are shared when Upstash is configured or the Supabase RPC migration
 * is applied. Without either provider, the bounded fallback is per-instance.
 * See docs/security-production-checklist.md for rollout requirements.
 */
async function rateLimitShared(key, maxAttempts, windowMs) {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  if (!upstashConfig()) {
    try {
      const result = await databaseRateLimit(key, maxAttempts, windowSec, 'consume');
      return formatDatabaseRateLimit(result);
    } catch (e) {
      warnRateLimitOnce('Shared rate limit unavailable, using per-instance fallback');
      return rateLimit(key, maxAttempts, windowMs);
    }
  }

  try {
    const rk = redisKey(key);
    const out = await redisPipeline([
      ['INCR', rk],
      ['EXPIRE', rk, String(windowSec), 'NX'],
      ['TTL', rk],
    ]);
    const count = Number(redisValue(out && out[0]));
    if (!Number.isFinite(count)) throw new Error('Upstash INCR failed');
    const rawTtl = Number(redisValue(out && out[2]));
    const resetIn = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : windowSec;
    if (rawTtl === -1) {
      // A counter without an expiry would never reset. Repair it; if the
      // repair fails the fallback below still applies.
      try {
        await redisPipeline([['EXPIRE', rk, String(windowSec)]]);
      } catch (e) {
        /* best effort */
      }
    }
    return {
      allowed: count <= maxAttempts,
      remaining: Math.max(0, maxAttempts - count),
      resetIn,
    };
  } catch (e) {
    try {
      return formatDatabaseRateLimit(
        await databaseRateLimit(key, maxAttempts, windowSec, 'consume')
      );
    } catch (databaseError) {
      // Neither shared provider is available. Keep the store available, but
      // retain a bounded per-instance guard and emit a health warning.
      warnRateLimitOnce('Shared rate limit unavailable, using per-instance fallback');
      return rateLimit(key, maxAttempts, windowMs);
    }
  }
}

/** Read a durable counter without incrementing it (used by the coupon lockout). */
async function rateLimitPeekShared(key) {
  if (!upstashConfig()) {
    try {
      const result = await databaseRateLimit(key, 1, 60, 'peek');
      const count = Number(result.count);
      const resetIn = Number(result.resetIn);
      if (!Number.isFinite(count) || !Number.isFinite(resetIn)) {
        throw new Error('Database rate limiter returned invalid counters');
      }
      return { count, resetIn };
    } catch (e) {
      warnRateLimitOnce('Shared rate limit unavailable, using per-instance fallback');
    }
    const b = rateBuckets.get(key);
    if (!b || b.resetAt < Date.now()) return { count: 0, resetIn: 0 };
    return { count: b.count, resetIn: Math.ceil((b.resetAt - Date.now()) / 1000) };
  }
  try {
    const rk = redisKey(key);
    const out = await redisPipeline([['GET', rk], ['TTL', rk]]);
    const count = Number(redisValue(out && out[0])) || 0;
    const ttl = Number(redisValue(out && out[1]));
    return { count, resetIn: Number.isFinite(ttl) && ttl > 0 ? ttl : 0 };
  } catch (e) {
    try {
      const result = await databaseRateLimit(key, 1, 60, 'peek');
      const count = Number(result.count);
      const resetIn = Number(result.resetIn);
      if (!Number.isFinite(count) || !Number.isFinite(resetIn)) {
        throw new Error('Database rate limiter returned invalid counters');
      }
      return { count, resetIn };
    } catch (databaseError) {
      warnRateLimitOnce('Shared rate limit unavailable, using per-instance fallback');
      const b = rateBuckets.get(key);
      if (!b || b.resetAt < Date.now()) return { count: 0, resetIn: 0 };
      return { count: b.count, resetIn: Math.ceil((b.resetAt - Date.now()) / 1000) };
    }
  }
}

/** Clear a counter in both stores (best effort). */
async function resetRateLimitShared(key) {
  rateBuckets.delete(key);
  let cleared = false;
  if (upstashConfig()) {
    try {
      const out = await redisPipeline([['DEL', redisKey(key)]]);
      redisValue(out && out[0]);
      cleared = true;
    } catch (e) { /* try the database fallback */ }
  }
  try {
    await databaseRateLimit(key, 1, 60, 'reset');
    cleared = true;
  } catch (e) { /* local counter was already cleared */ }
  if (!cleared) warnRateLimitOnce('Shared rate limit reset unavailable; local counter was cleared');
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
    'reviews.read', 'reviews.write',
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
//
// Legacy links are 32 hex chars: HMAC(`track:<id>`) truncated. They never
// expire, which is why rotating SESSION_SECRET is the only way to invalidate
// them. New links use `v1.<expiry-ms>.<hmac>` and expire after 30 days by
// default; every legacy token keeps verifying so sent WhatsApp links do not
// break. TRACKING_TOKEN_TTL_HOURS can set a different positive duration.
function legacyTrackToken(orderId) {
  const secret = requireSecret('SESSION_SECRET');
  return hmac(`track:${orderId}`, secret).toString('hex').slice(0, 32);
}

function expiringTrackToken(orderId, expiresAt) {
  const secret = requireSecret('SESSION_SECRET');
  return hmac(`track:${orderId}:${expiresAt}`, secret).toString('hex').slice(0, 32);
}

function trackingTtlMs() {
  const raw = env('TRACKING_TOKEN_TTL_HOURS');
  const configuredHours = raw ? Number(raw) : 720;
  const hours = Number.isFinite(configuredHours) && configuredHours > 0
    ? configuredHours
    : 720;
  // Cap at ten years so a typo cannot create effectively-permanent tokens.
  return Math.min(Math.floor(hours * 60 * 60 * 1000), 10 * 365 * 24 * 60 * 60 * 1000);
}

function trackToken(orderId, expiresAt) {
  const explicit = Number(expiresAt);
  const ttl = trackingTtlMs();
  const exp = Number.isFinite(explicit) && explicit > 0
    ? Math.floor(explicit)
    : (ttl ? Date.now() + ttl : 0);
  if (!exp) return legacyTrackToken(orderId);
  return `v1.${exp}.${expiringTrackToken(orderId, exp)}`;
}

function verifyTrackToken(orderId, token) {
  if (!orderId || !token || typeof token !== 'string') return false;
  const versioned = token.match(/^v1\.(\d{1,16})\.([a-f0-9]{32})$/i);
  if (versioned) {
    const exp = Number(versioned[1]);
    if (!Number.isSafeInteger(exp) || exp <= Date.now()) return false;
    return safeEqualHex(expiringTrackToken(orderId, exp), versioned[2].toLowerCase());
  }
  // Legacy 32-hex links stay valid indefinitely (no expiry information exists).
  return safeEqualHex(legacyTrackToken(orderId), token);
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
    return { ok: false, errors: ['Your bag is empty or contains too many items.'] };
  }

  const cleanItems = [];
  for (const raw of items) {
    const productId = intInRange(raw && raw.productId, 1, Number.MAX_SAFE_INTEGER);
    if (productId === null) { errors.push('Invalid product id.'); break; }
    const qty = intInRange(raw && raw.qty, 1, 20);
    if (qty === null) { errors.push('Invalid quantity for an item.'); break; }
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

  if (name === null) errors.push('Please enter your full name (at least 2 characters).');
  if (!EGYPT_PHONE_RE.test(phone)) errors.push('Please enter a valid Egyptian mobile number (e.g. 01XXXXXXXXX).');
  const phoneAlt = c.phoneAlt ? normalizePhone(c.phoneAlt) : '';
  if (phoneAlt && (!EGYPT_PHONE_RE.test(phoneAlt) || phoneAlt === phone)) {
    errors.push('The alternative phone number is invalid or the same as the primary one.');
  }
  const email = str(c.email).trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) errors.push('Please enter a valid email address.');
  if (address === null) errors.push('Please enter a complete street address (at least 5 characters).');
  if (!EGYPT_GOVERNORATES.includes(city)) errors.push('Please select your governorate from the list.');

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    items: cleanItems,
    customer: { name, phone, phoneAlt, email, address, city, notes: str(c.notes).slice(0, 500) },
  };
}

/**
 * Validate an admin order edit. The customer block is always required (the
 * dashboard sends the complete current values), while `items` and `couponCode`
 * are optional: omitting them means "keep the stored value". Item validation
 * mirrors validateOrderPayload so an edited cart obeys exactly the same bounds
 * as a newly placed one.
 */
function validateOrderEditPayload(body) {
  const errors = [];
  const c = (body && body.customer) || {};
  const name = cleanText(c.name, 2, 100);
  const address = cleanText(c.address, 5, 300);
  const phone = normalizePhone(c.phone);
  const city = str(c.city).trim();

  if (name === null) errors.push('Please enter the customer full name (at least 2 characters).');
  if (!EGYPT_PHONE_RE.test(phone)) errors.push('Please enter a valid Egyptian mobile number (e.g. 01XXXXXXXXX).');
  const phoneAlt = c.phoneAlt ? normalizePhone(c.phoneAlt) : '';
  if (phoneAlt && (!EGYPT_PHONE_RE.test(phoneAlt) || phoneAlt === phone)) {
    errors.push('The alternative phone number is invalid or the same as the primary one.');
  }
  const email = str(c.email).trim();
  if (email && (email.length > 200 || !EMAIL_RE.test(email))) errors.push('Please enter a valid email address.');
  if (address === null) errors.push('Please enter a complete street address (at least 5 characters).');
  if (!EGYPT_GOVERNORATES.includes(city)) errors.push('Please select the governorate from the list.');

  let items = null;
  if (body && body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
      errors.push('The order must contain between 1 and 30 items.');
    } else {
      items = [];
      for (const raw of body.items) {
        const productId = intInRange(raw && raw.productId, 1, Number.MAX_SAFE_INTEGER);
        const qty = intInRange(raw && raw.qty, 1, 20);
        if (productId === null || qty === null) {
          errors.push('Invalid item or quantity in the edited order.');
          items = null;
          break;
        }
        items.push({
          productId,
          qty,
          size: str(raw.size).slice(0, 50),
          color: str(raw.color).slice(0, 50),
        });
      }
    }
  }

  let couponProvided = false;
  let couponCode = null;
  if (body && Object.prototype.hasOwnProperty.call(body, 'couponCode')) {
    couponProvided = true;
    couponCode = str(body.couponCode).trim().toUpperCase();
    if (couponCode && !COUPON_CODE_RE.test(couponCode)) {
      errors.push('A valid discount code is required.');
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    customer: {
      name,
      phone,
      phoneAlt,
      email,
      address,
      city,
      notes: str(c.notes).slice(0, 500),
    },
    items,
    couponProvided,
    couponCode,
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
    // Same rule as the storefront: 0 means "no discount", never a free order.
    else if (!(salePrice > 0)) salePrice = null;
  }

  // Option labels are compared the same way the admin UI does (trim, collapse
  // whitespace, ignore case) and repeats are dropped while keeping the first
  // spelling — a duplicate size/colour must never be stored twice and must
  // never double-count stock. Variant keys are built from these spellings.
  const strArr = (v, maxLen, maxItems) => {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const unique = [];
    for (const raw of v.slice(0, maxItems)) {
      const value = str(raw).replace(/[<>]/g, '').trim().slice(0, maxLen);
      if (!value) continue;
      const key = value.replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(value);
    }
    return unique;
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

  // products.stock is server-authoritative for variant products: recompute it
  // from the DECLARED combinations only instead of trusting the client. Orphan
  // keys stay untouched inside variantStock but never contribute to the
  // sellable total. Legacy products (no declared size/colour lists) keep their
  // submitted global counter.
  let storedStock = stock;
  if (sizes.length > 0 && colors.length > 0) {
    storedStock = 0;
    for (const size of sizes) {
      for (const color of colors) {
        const qty = Number(variantStock[`${size}-${color}`]);
        if (Number.isFinite(qty) && qty > 0) storedStock += qty;
      }
    }
  }

  if (errors.length) return null;

  return {
    name,
    category,
    price,
    salePrice,
    stock: storedStock,
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
function couponIsRedeemable(row, today, { allowExhausted = false } = {}) {
  if (!row || typeof row !== 'object') return false;
  if (row.active !== true) return false;
  const start = str(row.startDate);
  const end = str(row.endDate);
  if (!start || !end || !(start <= today && end >= today)) return false;
  // When an existing order is edited and keeps its coupon, this order already
  // consumed a unit, so the exhausted usage limit must not reject it.
  if (!allowExhausted) {
    const used = Number(row.usageCount || 0);
    const limit = Number(row.usageLimit || 0);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || !(used < limit)) return false;
  }
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

/** Masks customer PII for ID-only tracking lookups (no secure token). All
 * customer-identifying fields — including `phone` — are cleared so an order id
 * alone never exposes personal data. The secure `tk` link is required to view
 * the full record. */
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

/** Converts a phone to an international dial string for https://wa.me/ links
 * (Egyptian 01x... → 20 1x..., "+2..." kept, otherwise "+20" is prepended). */
function waNumber(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return '';
  if (d.charAt(0) === '0') d = '20' + d.slice(1);
  else if (!d.startsWith('20')) d = '20' + d;
  return d;
}

/**
 * POST a message to the configured Telegram chat.
 *
 * The order messages are PLAIN TEXT by default: this text is forwarded to the
 * customer on WhatsApp, and a Markdown escaper would eat the `_` of an email
 * address and the `-` of an order id. Pass `parseMode: 'Markdown'` only for a
 * message that is deliberately formatted.
 *
 * `replyMarkup` becomes the inline keyboard (action buttons), keeping the
 * message body copyable without any URL inside it.
 */
async function sendTelegramNotification(messageText, options = {}) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    console.warn('Telegram notification skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured');
    return false;
  }
  const parseMode = options.parseMode === undefined ? null : options.parseMode;
  const clamped = clampBytes(String(messageText == null ? '' : messageText), TELEGRAM_MESSAGE_MAX_BYTES);
  const text = parseMode === 'Markdown'
    ? clamped.replace(/→/g, ':').replace(/_/g, '')
    : clamped;
  const body = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;
  if (options.replyMarkup && typeof options.replyMarkup === 'object') {
    body.reply_markup = options.replyMarkup;
  }
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  // A failed order is answered while its alert is in flight, so that path passes
  // a timeout: a hung Telegram API must not hold the customer's error response.
  const timeoutMs = Number(options.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, init);
  return resp.ok;
}

// ─── ORDER NOTIFICATIONS (Telegram) ─────────────────────────────────────────
// Telegram is the only notification channel. Two templates, two audiences:
//
//   1. `buildOrderTelegramMessage` — the customer confirmation text. It is the
//      exact text the owner forwards on WhatsApp, so it is sent as PLAIN TEXT
//      (no parse_mode) and never through a Markdown escaper: an underscore in
//      an email or a hyphen in an order id must survive the copy untouched.
//   2. `buildOrderStatusMessage` — a short internal line for a status change or
//      a deletion. The owner does not forward it; it only has to be scannable.
//
// Every customer-controlled value goes through `safeLineText`, which collapses
// newlines and control characters, so a name or an address can never forge an
// extra order line or price.

const TELEGRAM_MESSAGE_MAX_BYTES = 3900; // hard API limit is 4096 characters
// A failed order is answered with an error while the alert is in flight, so
// this path uses a tighter bound than the normal (post-commit) notification.
const FAILURE_ALERT_TIMEOUT_MS = 5000;
// The common order is far below this; the byte clamp at send time trims
// pathological carts instead of losing the whole notification.
const ORDER_ITEM_MAX = 50;

/** Status → Arabic label for the short internal update. Unknown statuses fall
 * back to a neutral package icon so a future status never breaks a message. */
const ORDER_STATUS_TEXT = {
  Pending: { emoji: '🛍️', label: 'طلب جديد', line: 'قيد المراجعة' },
  Confirmed: { emoji: '🟢', label: 'تم تأكيد الطلب', line: 'تم تأكيد الطلب' },
  Processing: { emoji: '⚙️', label: 'جاري تجهيز الطلب', line: 'قيد التجهيز' },
  Shipped: { emoji: '🚚', label: 'تم شحن الطلب', line: 'تم الشحن' },
  Delivered: { emoji: '✅', label: 'تم توصيل الطلب', line: 'تم التوصيل' },
  Edited: { emoji: '✏️', label: 'تم تعديل الطلب', line: 'تم تعديل البيانات' },
  Cancelled: { emoji: '🚫', label: 'تم إلغاء الطلب', line: 'ملغي' },
  Deleted: { emoji: '🔴', label: 'تم حذف الطلب', line: 'محذوف' },
  Failed: { emoji: '⚠️', label: 'طلب لم يُحفظ', line: 'لم يُحفظ في قاعدة البيانات' },
};

// Arabic reason shown in the failure alert. The raw database error is never
// sent (and never logged): the owner only needs to know which step failed.
const ORDER_FAILURE_REASONS = {
  product_lookup: 'تعذر قراءة بيانات المنتجات من قاعدة البيانات',
  coupon_lookup: 'تعذر التحقق من كود الخصم',
  save_failed: 'تعذر حفظ الأوردر في قاعدة البيانات',
  unexpected: 'خطأ غير متوقع في السيرفر',
};

/** UTF-8 size of a string. */
function byteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

/** Truncate to a UTF-8 byte budget without splitting an emoji/surrogate pair. */
function clampBytes(value, maxBytes) {
  const text = String(value == null ? '' : value);
  if (byteLength(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/** Single-line, length-capped, control-character-free text.
 *
 * Every customer-controlled value goes through this: a newline in a name or an
 * address could otherwise fake extra order lines or prices. Markdown characters
 * are NOT removed — these messages are plain text, and `_`/`-` are legitimate
 * parts of an email address or an order id.
 */
function safeLineText(value, maxChars) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  let count = 0;
  for (const ch of cleaned) {
    if (count >= maxChars) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** "EGP 1,865" — one formatter everywhere so the amount is unambiguous. */
function moneyEGP(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `EGP ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n)}`;
}

/** Order date/time in Cairo time, e.g. "05 Nov 2026, 2:15 PM". Falls back to
 * the stored date-only value when `timestamps.created` is missing. */
function orderDateText(createdAt, fallbackDate) {
  const created = createdAt ? new Date(createdAt) : null;
  if (created && !Number.isNaN(created.getTime())) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Cairo',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).formatToParts(created);
      const get = (type) => {
        const part = parts.find((p) => p.type === type);
        return part ? part.value : '';
      };
      const hour = String(Number(get('hour')) || 12);
      const period = get('dayPeriod').toUpperCase().replace(/\./g, '');
      const text = `${get('day')} ${get('month')} ${get('year')}, ${hour}:${get('minute')} ${period}`.trim();
      if (text) return text;
    } catch (e) {
      /* fall through to the date-only value */
    }
  }
  const dateOnly = safeLineText(fallbackDate, 20);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (m) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const idx = Number(m[2]) - 1;
    if (idx >= 0 && idx < 12) return `${m[3]} ${months[idx]} ${m[1]}`;
  }
  return dateOnly;
}

/** One line per item: "• Silk Abaya (M / Black) × 1 — EGP 1,300".
 * The price is the server-computed line total. Missing product data (a failed
 * database read) still produces a readable line instead of dropping the item. */
function orderItemLines(items, limit = ORDER_ITEM_MAX) {
  const list = Array.isArray(items) ? items : [];
  const shown = list.slice(0, Math.max(0, limit));
  const lines = [];
  for (const item of shown) {
    if (!item || typeof item !== 'object') continue;
    const name = safeLineText(item.name, 70) || `منتج #${Math.max(0, Math.trunc(Number(item.productId) || 0))}`;
    const variant = [safeLineText(item.size, 18), safeLineText(item.color, 18)]
      .filter(Boolean)
      .join(' / ');
    const qty = Math.max(1, Math.min(999, Math.trunc(Number(item.qty) || 1)));
    const lineTotal = Number(item.price);
    const amount = Number.isFinite(lineTotal) ? ` — ${moneyEGP(lineTotal)}` : '';
    lines.push(`• ${name}${variant ? ` (${variant})` : ''} × ${qty}${amount}`);
  }
  const hidden = list.length - shown.length;
  if (hidden > 0) {
    lines.push(`• +${hidden} more item${hidden === 1 ? '' : 's'}`);
  }
  return lines;
}

/**
 * Customer confirmation message — the exact text the owner sends on WhatsApp.
 *
 * Sources, in order: the order row, then `tracking_url`/`trackingUrl`, then the
 * explicit `trackingUrl` argument. `shippingCost` is not stored on the order
 * row (it is derived from the city), so it is derived again when absent.
 */
function buildOrderTelegramMessage(order = {}, trackingUrl) {
  const orderId = safeLineText(order.id, 48);
  const nameText = safeLineText(order.customer, 60);
  const phoneText = safeLineText(order.phone, 24);
  const phoneAltText = safeLineText(order.phoneAlt, 24);
  const emailText = safeLineText(order.email, 120);
  const cityText = safeLineText(order.city, 40);
  const addressText = safeLineText(order.address, 220);
  const notesText = safeLineText(order.notes, 260);
  const discountCodeText = safeLineText(order.discountCode, 30);
  const subtotal = Number.isFinite(Number(order.subtotal)) ? Number(order.subtotal) : 0;
  const discount = Number.isFinite(Number(order.discount)) ? Number(order.discount) : 0;
  const total = Number.isFinite(Number(order.total)) ? Number(order.total) : 0;
  const shipping = Number(
    order.shippingCost != null ? order.shippingCost : getShippingCost(order.city)
  );
  const track = String(order.tracking_url || order.trackingUrl || trackingUrl || '').trim();
  const wa = phoneText ? waNumber(phoneText) : '';
  const firstName = nameText.split(/\s+/)[0];

  const lines = [];
  lines.push(`السلام عليكم أ/ ${firstName || 'عميلنا العزيز'} 👋`);
  lines.push('مع حضرتك فريق ZASHM. حابين نأكد مع حضرتك تفاصيل الأوردر قبل الشحن.');
  lines.push('');

  lines.push('👤 بيانات العميل');
  if (nameText) lines.push(`• الاسم: ${nameText}`);
  if (phoneText) lines.push(`• الهاتف: ${phoneText}`);
  if (wa) lines.push(`• واتساب: https://wa.me/${wa}`);
  if (phoneAltText) lines.push(`• هاتف بديل: ${phoneAltText}`);
  if (emailText) lines.push(`• الإيميل: ${emailText}`);
  lines.push('');

  lines.push('📍 عنوان الشحن');
  lines.push(`• المدينة: ${cityText || 'غير محدد'}`);
  if (addressText) lines.push(`• العنوان: ${addressText}`);
  if (notesText) lines.push(`• ملاحظات: ${notesText}`);
  lines.push('');

  lines.push('🛍️ المنتجات');
  const itemLines = orderItemLines(order.items, ORDER_ITEM_MAX);
  lines.push(...(itemLines.length ? itemLines : ['لا توجد منتجات']));
  lines.push('');

  lines.push('💰 ملخص الحساب');
  lines.push(`• المجموع الفرعي: ${moneyEGP(subtotal)}`);
  if (Number.isFinite(shipping) && shipping > 0) lines.push(`• الشحن: ${moneyEGP(shipping)}`);
  if (discountCodeText) lines.push(`• كود الخصم: ${discountCodeText}`);
  if (discount > 0) lines.push(`• قيمة الخصم: ${moneyEGP(discount)}`);
  lines.push(`• الإجمالي: ${moneyEGP(total)}`);
  lines.push('');

  if (track) {
    lines.push('🚚 تتبع الأوردر');
    lines.push(track.slice(0, 300));
  }
  if (orderId) lines.push(`• رقم الطلب: ${orderId}`);
  lines.push('');

  lines.push('لو البيانات دي مظبوطة، ردّ علينا بـ ✅ ونكمّل التجهيز والشحن.');
  lines.push('✏️ ولو حابب تعدّل أي حاجة — الاسم، العنوان، المقاس، أو منتج — قولّنا قبل الشحن وإحنا هنظبّطها.');

  return lines.join('\n');
}

/** Short internal update for a status change or a deletion. Deliberately not
 * the customer text: the owner does not forward it, and a "تم الشحن" line must
 * never be pasted into a customer chat as if it were the confirmation. */
function buildOrderStatusMessage(order = {}, status) {
  const rawStatus = String(status == null ? '' : status).trim();
  const style = Object.prototype.hasOwnProperty.call(ORDER_STATUS_TEXT, rawStatus)
    ? ORDER_STATUS_TEXT[rawStatus]
    : { emoji: '📦', label: 'تحديث الطلب', line: safeLineText(rawStatus, 40) || 'قيد المراجعة' };
  const orderId = safeLineText(order.id, 48);
  const nameText = safeLineText(order.customer, 60);
  const total = Number(order.total);

  const lines = [`${style.emoji} ZASHM | ${style.label}`];
  if (orderId) lines.push(`• رقم الطلب: ${orderId}`);
  if (nameText) lines.push(`• العميل: ${nameText}`);
  lines.push(`• الحالة: ${style.line}`);
  if (Number.isFinite(total)) lines.push(`• الإجمالي: ${moneyEGP(total)}`);
  return lines.join('\n');
}

/** One diff line for an edited item, e.g. "Silk Abaya (M / Black) × 2 — EGP 2,600". */
function orderEditLineText(line) {
  const variant = [line.size, line.color].filter(Boolean).join(' / ');
  const amount = line.price === null ? '' : ` — ${moneyEGP(line.price)}`;
  return `${line.name}${variant ? ` (${variant})` : ''} × ${line.qty}${amount}`;
}

/** Group order lines by product + size + colour, summing duplicates. */
function orderEditLineMap(items) {
  const map = new Map();
  for (const item of (Array.isArray(items) ? items : [])) {
    if (!item || typeof item !== 'object') continue;
    const pid = Number(item.productId);
    const productId = Number.isFinite(pid) ? pid : 0;
    const size = safeLineText(item.size, 20);
    const color = safeLineText(item.color, 20);
    const key = `${productId}|${size}|${color}`;
    const qty = Math.max(1, Math.min(999, Math.trunc(Number(item.qty) || 1)));
    const rawPrice = Number(item.price);
    const price = Number.isFinite(rawPrice) ? rawPrice : null;
    const existing = map.get(key);
    if (existing) {
      existing.qty += qty;
      existing.price = existing.price === null || price === null
        ? null
        : existing.price + price;
      continue;
    }
    map.set(key, {
      key,
      name: safeLineText(item.name, 60) || `منتج #${productId}`,
      size,
      color,
      qty,
      price,
    });
  }
  return map;
}

/**
 * Internal edit alert. Unlike `buildOrderStatusMessage`, this says exactly what
 * the owner changed: customer fields as `old → new`, added/removed items with
 * size/colour/quantity/line price, quantity changes, coupon and shipping
 * changes, and the total before/after. It is still the SHORT internal template
 * (plain text, no customer greeting), never the customer confirmation text.
 */
function buildOrderEditMessage(before = {}, after = {}) {
  const lines = ['✏️ ZASHM | تم تعديل الطلب'];
  const orderId = safeLineText(after.id || before.id, 48);
  if (orderId) lines.push(`• رقم الطلب: ${orderId}`);
  const customer = safeLineText(after.customer || before.customer, 60);
  if (customer) lines.push(`• العميل: ${customer}`);

  // ── customer / address fields ──────────────────────────────────────────────
  const dataFields = [
    ['الاسم', 'customer', 80],
    ['الهاتف', 'phone', 24],
    ['الهاتف البديل', 'phoneAlt', 24],
    ['الإيميل', 'email', 120],
    ['المحافظة', 'city', 40],
    ['العنوان', 'address', 220],
    ['الملاحظات', 'notes', 200],
  ];
  const dataChanges = [];
  for (const [label, key, maxChars] of dataFields) {
    const oldValue = safeLineText(before[key], maxChars) || '—';
    const newValue = safeLineText(after[key], maxChars) || '—';
    if (oldValue !== newValue) dataChanges.push(`• ${label}: ${oldValue} → ${newValue}`);
  }
  if (dataChanges.length) {
    lines.push('', '📝 تعديلات البيانات:');
    lines.push(...dataChanges.slice(0, 10));
    if (dataChanges.length > 10) lines.push(`• +${dataChanges.length - 10} تعديل آخر`);
  }

  // ── item diff: added / removed / quantity changed ──────────────────────────
  const beforeLines = orderEditLineMap(before.items);
  const afterLines = orderEditLineMap(after.items);
  const keys = new Set([...beforeLines.keys(), ...afterLines.keys()]);
  const itemChanges = [];
  for (const key of keys) {
    const oldLine = beforeLines.get(key);
    const newLine = afterLines.get(key);
    if (!oldLine && newLine) {
      itemChanges.push(`• إضافة: ${orderEditLineText(newLine)}`);
      continue;
    }
    if (oldLine && !newLine) {
      itemChanges.push(`• حذف: ${orderEditLineText(oldLine)}`);
      continue;
    }
    if (oldLine && newLine && oldLine.qty !== newLine.qty) {
      const variant = [newLine.size, newLine.color].filter(Boolean).join(' / ');
      const name = newLine.name || oldLine.name;
      const oldAmount = oldLine.price === null ? '' : ` — ${moneyEGP(oldLine.price)}`;
      const newAmount = newLine.price === null ? '' : ` — ${moneyEGP(newLine.price)}`;
      itemChanges.push(
        `• الكمية: ${name}${variant ? ` (${variant})` : ''} × ${oldLine.qty}${oldAmount} → × ${newLine.qty}${newAmount}`
      );
      continue;
    }
    // Same quantity but a different line price (the product price changed
    // between placement and the edit).
    if (oldLine && newLine
        && oldLine.price !== null && newLine.price !== null
        && oldLine.price !== newLine.price) {
      const variant = [newLine.size, newLine.color].filter(Boolean).join(' / ');
      const name = newLine.name || oldLine.name;
      itemChanges.push(
        `• السعر: ${name}${variant ? ` (${variant})` : ''} — ${moneyEGP(oldLine.price)} → ${moneyEGP(newLine.price)}`
      );
    }
  }
  if (itemChanges.length) {
    lines.push('', '🛒 تعديلات المنتجات:');
    lines.push(...itemChanges.slice(0, 20));
    if (itemChanges.length > 20) lines.push(`• +${itemChanges.length - 20} تعديل آخر`);
  }

  // ── coupon, shipping and totals ────────────────────────────────────────────
  const moneyChanges = [];
  const oldCode = safeLineText(before.discountCode, 30).toUpperCase();
  const newCode = safeLineText(after.discountCode, 30).toUpperCase();
  if (oldCode !== newCode) {
    if (!oldCode) moneyChanges.push(`• الكوبون: تمت إضافة ${newCode}`);
    else if (!newCode) moneyChanges.push(`• الكوبون: تم حذف ${oldCode}`);
    else moneyChanges.push(`• الكوبون: ${oldCode} → ${newCode}`);
  }

  const oldDiscount = Number(before.discount);
  const newDiscount = Number(after.discount);
  if (Number.isFinite(oldDiscount) && Number.isFinite(newDiscount) && oldDiscount !== newDiscount) {
    moneyChanges.push(`• الخصم: ${moneyEGP(oldDiscount)} → ${moneyEGP(newDiscount)}`);
  }

  const oldShipping = getShippingCost(before.city);
  const newShipping = getShippingCost(after.city);
  if (oldShipping !== newShipping) {
    moneyChanges.push(`• الشحن: ${moneyEGP(oldShipping)} → ${moneyEGP(newShipping)}`);
  }

  const oldTotal = Number(before.total);
  const newTotal = Number(after.total);
  if (Number.isFinite(oldTotal) && Number.isFinite(newTotal) && oldTotal !== newTotal) {
    moneyChanges.push(`• الإجمالي قبل: ${moneyEGP(oldTotal)}`);
    moneyChanges.push(`• الإجمالي بعد: ${moneyEGP(newTotal)}`);
    const diff = newTotal - oldTotal;
    moneyChanges.push(`• الفرق: ${diff > 0 ? '+' : '−'}${moneyEGP(Math.abs(diff))}`);
  }
  if (moneyChanges.length) {
    lines.push('', '💰 الحساب:');
    lines.push(...moneyChanges.slice(0, 12));
  }

  if (!dataChanges.length && !itemChanges.length && !moneyChanges.length) {
    lines.push('', 'لا توجد تغييرات في البيانات أو المنتجات.');
  }
  return lines.join('\n');
}

/** wa.me deep link, optionally pre-filling the message. Returns '' when the
 * phone number cannot be normalised, so callers never render a dead link. */
function whatsAppDeepLink(phone, text) {
  const number = waNumber(phone);
  if (!number) return '';
  const suffix = text ? `?text=${encodeURIComponent(String(text))}` : '';
  return `https://wa.me/${number}${suffix}`;
}

/** Pre-filled WhatsApp message. Carries the customer confirmation in a form
 * that fits Telegram's 2048-character button-URL limit, so the button opens
 * the WhatsApp app directly with the message already typed — no browser
 * redirect, no "Do you want to open…" prompt. The exact, full text still ships
 * in the notification body and is also available via the "نسخ الرسالة كاملة"
 * copy button. Optional fields are dropped (in priority order) when the
 * message would otherwise exceed the budget. */
function buildWhatsAppPrefillMessage(order = {}, trackingUrl) {
  const nameText = safeLineText(order.customer, 60);
  const phoneText = safeLineText(order.phone, 24);
  const phoneAltText = safeLineText(order.phoneAlt, 24);
  const emailText = safeLineText(order.email, 120);
  const cityText = safeLineText(order.city, 40);
  const addressText = safeLineText(order.address, 220);
  const notesText = safeLineText(order.notes, 260);
  const discountCodeText = safeLineText(order.discountCode, 30);
  const total = Number(order.total);
  const discount = Number(order.discount);
  const track = String(order.tracking_url || order.trackingUrl || trackingUrl || '').trim();
  const firstName = nameText.split(/\s+/)[0];
  const itemLines = orderItemLines(order.items, ORDER_ITEM_MAX);
  const money = (v) => (Number.isFinite(Number(v)) ? `EGP ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(v))}` : '');

  const build = (opts) => {
    const lines = [];
    lines.push(`السلام عليكم أ/ ${firstName || 'عميلنا العزيز'} 👋`);
    lines.push('مع حضرتك فريق ZASHM. حابين نأكد مع حضرتك تفاصيل الأوردر قبل الشحن.');
    lines.push('');
    lines.push('👤 بيانات العميل');
    if (nameText) lines.push(`• الاسم: ${nameText}`);
    if (phoneText) lines.push(`• الهاتف: ${phoneText}`);
    if (opts.phoneAlt && phoneAltText) lines.push(`• هاتف بديل: ${phoneAltText}`);
    if (opts.email && emailText) lines.push(`• الإيميل: ${emailText}`);
    lines.push('');
    lines.push('📍 عنوان الشحن');
    if (cityText) lines.push(`• المدينة: ${cityText}`);
    if (opts.address && addressText) lines.push(`• العنوان: ${addressText}`);
    if (opts.notes && notesText) lines.push(`• ملاحظات: ${notesText}`);
    lines.push('');
    lines.push('🛍️ المنتجات');
    lines.push(...(itemLines.length ? itemLines : ['لا توجد منتجات']));
    lines.push('');
    if (Number.isFinite(total)) {
      let summary = `💰 الإجمالي: ${money(total)}`;
      if (discountCodeText && discount > 0) summary += ` (خصم ${discountCodeText} ${money(discount)})`;
      lines.push(summary);
    }
    lines.push('');
    if (track) {
      lines.push('🚚 تتبع الأوردر');
      lines.push(track.slice(0, 300));
    }
    if (order.id) lines.push(`• رقم الطلب: ${safeLineText(order.id, 48)}`);
    lines.push('');
    lines.push('لو البيانات دي مظبوطة، ردّ علينا بـ ✅');
    return lines.join('\n');
  };

  const num = waNumber(order && order.phone);
  const budget = 1980;
  const fits = (msg) => (`https://wa.me/${num}?text=${encodeURIComponent(msg)}`).length <= budget;
  const variants = [
    { phoneAlt: true, email: true, address: true, notes: true },
    { phoneAlt: true, email: true, address: true, notes: false },
    { phoneAlt: true, email: true, address: false, notes: false },
    { phoneAlt: true, email: false, address: false, notes: false },
    { phoneAlt: false, email: false, address: false, notes: false },
  ];
  for (const v of variants) {
    const msg = build(v);
    if (fits(msg)) return msg;
  }
  const full = build(variants[variants.length - 1]);
  let out = '';
  for (const ch of full) {
    if ((`https://wa.me/${num}?text=${encodeURIComponent(out + ch)}`).length > budget) break;
    out += ch;
  }
  return out;
}

/** Signed link that opens the owner's WhatsApp with the confirmation message
 * already typed. The full message is ~1.2 KB of Arabic; percent-encoding it
 * directly would blow past Telegram's button-URL limit, so the button points at
 * this short redirect and the text is built on tap.
 */
function whatsAppConfirmLink(orderId) {
  const id = String(orderId == null ? '' : orderId).trim();
  if (!id) return '';
  try {
    const base = PUBLIC_BASE_URL().replace(/\/+$/, '');
    return `${base}/api/orders?track=${encodeURIComponent(id)}`
      + `&tk=${encodeURIComponent(trackToken(id))}&wa=1`;
  } catch (e) {
    // No SESSION_SECRET (or signing failed): drop the button rather than
    // shipping a dead link.
    return '';
  }
}

/** Inline keyboard for a notification. The customer text stays clean; actions
 * live in buttons, so copying the message never drags an admin URL with it. */
function buildOrderTelegramActions(order = {}, trackingUrl, { includeWhatsApp = true } = {}) {
  const rows = [];
  const primary = [];
  if (includeWhatsApp) {
    const number = waNumber(order && order.phone);
    let whatsappUrl = '';
    if (number) {
      const prefill = buildWhatsAppPrefillMessage(order, trackingUrl);
      const candidate = `https://wa.me/${number}?text=${encodeURIComponent(prefill)}`;
      // Telegram caps a button URL at 2048 chars. If the pre-filled message is
      // too long, fall back to the signed redirect that builds it on tap.
      if (candidate.length <= 2000) whatsappUrl = candidate;
      else whatsappUrl = whatsAppConfirmLink(order.id);
    }
    if (whatsappUrl) primary.push({ text: '💬 واتساب بالرسالة جاهزة', url: whatsappUrl });
  }
  const track = String(order.tracking_url || order.trackingUrl || trackingUrl || '').trim();
  if (track) primary.push({ text: '🔗 صفحة الأوردر', url: track });
  if (includeWhatsApp) {
    const orderId = safeLineText(order && order.id, 48);
    // copy_text.text is capped at 256 chars by Telegram, so only the short
    // order id can be offered here; the full message is copied from the body.
    if (orderId) primary.push({ text: '📋 نسخ رقم الطلب', copy_text: { text: orderId } });
  }
  if (primary.length) rows.push(primary);
  rows.push([{
    text: '🛠 لوحة الطلبات',
    url: `${PUBLIC_BASE_URL().replace(/\/+$/, '')}/admin?tab=orders`,
  }]);
  return { inline_keyboard: rows };
}

/** Human-readable reference for a failed order attempt. It deliberately never
 * contains the customer's phone/name, only a timestamp and random suffix so two
 * attempts in the same second cannot collide. */
function newFailureReference() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `FAILED-${stamp}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/** Plain-text failure alert sent to Telegram when an order could not be stored.
 * It carries whatever data is already available: after a product or coupon read
 * failure the item names/prices are unknown, but the customer's contact details
 * (already validated) are always present so the owner can call them and take
 * the order manually. */
function buildOrderFailureMessage({
  reference,
  reason,
  orderId,
  customer,
  items,
  subtotal,
  shippingCost,
  discount,
  discountCode,
  total,
  createdAt,
} = {}) {
  const ref = safeLineText(reference, 48) || 'FAILED';
  const attemptId = safeLineText(orderId, 48);
  const reasonText = ORDER_FAILURE_REASONS[String(reason || '')] || ORDER_FAILURE_REASONS.unexpected;
  const nameText = safeLineText(customer && customer.name, 60);
  const phoneText = safeLineText(customer && customer.phone, 24);
  const phoneAltText = safeLineText(customer && customer.phoneAlt, 24);
  const emailText = safeLineText(customer && customer.email, 120);
  const cityText = safeLineText(customer && customer.city, 40);
  const addressText = safeLineText(customer && customer.address, 220);
  const notesText = safeLineText(customer && customer.notes, 260);
  const discountCodeText = safeLineText(discountCode, 30);
  const whenText = orderDateText(createdAt);
  const shipping = Number(shippingCost);
  const discountAmount = Number(discount);
  const subtotalAmount = Number(subtotal);
  const totalAmount = Number(total);
  const money = (value) => (Number.isFinite(value) ? moneyEGP(value) : '');

  const lines = [];
  lines.push('⚠️ ZASHM | تنبيه: الأوردر لم يُحفظ');
  lines.push(`🔖 المرجع: ${ref}`);
  if (attemptId) lines.push(`• رقم المحاولة: ${attemptId}`);
  if (whenText) lines.push(`🕒 الوقت: ${whenText}`);
  lines.push(`📌 السبب: ${reasonText}`);
  lines.push('');

  const customerLines = [];
  if (nameText) customerLines.push(`• الاسم: ${nameText}`);
  if (phoneText) {
    const wa = waNumber(phoneText);
    customerLines.push(`• الهاتف: ${phoneText}${wa ? ` — واتساب: https://wa.me/${wa}` : ''}`);
  }
  if (phoneAltText) customerLines.push(`• هاتف بديل: ${phoneAltText}`);
  if (emailText) customerLines.push(`• الإيميل: ${emailText}`);
  if (customerLines.length) {
    lines.push('👤 بيانات العميل');
    lines.push(...customerLines);
    lines.push('');
  }

  const addressLines = [];
  if (cityText) addressLines.push(`• المدينة: ${cityText}`);
  if (addressText) addressLines.push(`• العنوان: ${addressText}`);
  if (notesText) addressLines.push(`• ملاحظات: ${notesText}`);
  if (addressLines.length) {
    lines.push('📍 عنوان الشحن');
    lines.push(...addressLines);
    lines.push('');
  }

  const failureItemLines = orderItemLines(items, ORDER_ITEM_MAX);
  if (failureItemLines.length) {
    lines.push('🛍️ المنتجات');
    lines.push(...failureItemLines);
    lines.push('');
  }

  const summaryLines = [];
  const subtotalText = money(subtotalAmount);
  const shippingText = money(shipping);
  const discountText = money(discountAmount);
  const totalText = money(totalAmount);
  if (subtotalText) summaryLines.push(`• المجموع الفرعي: ${subtotalText}`);
  if (shippingText && shipping > 0) summaryLines.push(`• الشحن: ${shippingText}`);
  if (discountCodeText) summaryLines.push(`• كود الخصم: ${discountCodeText}`);
  if (discountText && discountAmount > 0) summaryLines.push(`• قيمة الخصم: ${discountText}`);
  if (totalText) summaryLines.push(`• الإجمالي: ${totalText}`);
  if (summaryLines.length) {
    lines.push('💰 ملخص الحساب');
    lines.push(...summaryLines);
    lines.push('');
  }

  lines.push('⚠️ الأوردر لم يصل إلى قاعدة البيانات. تواصل مع العميل يدويًا لتأكيد الطلب.');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Send the failure alert to Telegram. Never throws: this path runs while the
 * customer is waiting for an error response. */
async function sendOrderFailureAlert(context = {}) {
  const reference = context.reference || newFailureReference();
  const message = buildOrderFailureMessage({ ...context, reference });
  let telegram = false;
  try {
    telegram = (await sendTelegramNotification(message, {
      timeoutMs: FAILURE_ALERT_TIMEOUT_MS,
      parseMode: null,
    })) === true;
  } catch (e) {
    console.error('Order failure alert failed:', e && e.name ? e.name : 'Error');
  }
  return { reference, telegram };
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
  validateOrderEditPayload,
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
  buildWhatsAppPrefillMessage,
  buildOrderStatusMessage,
  buildOrderEditMessage,
  buildOrderTelegramActions,
  whatsAppDeepLink,
  waNumber,
  whatsAppConfirmLink,
  buildOrderFailureMessage,
  sendOrderFailureAlert,
  newFailureReference,
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
