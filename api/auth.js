'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
  resetRateLimit,
  tooMany,
  supabaseAdmin,
  signSession,
  hashPassword,
  verifyPassword,
} = require('./_lib');

/**
 * POST /api/auth  { action: 'login', email, password }
 * Server-side authentication. Never returns password hashes.
 */
module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const ip = clientIp(req);

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  if (!body || body.action !== 'login') {
    return json(res, 400, { error: 'Invalid request' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) {
    return json(res, 400, { error: 'Email and password are required' });
  }

  // Server-side rate limiting (per IP+email and per IP) — cannot be reset by reloading the page.
  const emailKey = `login:${ip}:${email}`;
  const ipKey = `login:${ip}`;
  const emailCheck = rateLimit(emailKey, 5, 15 * 60 * 1000);
  const ipCheck = rateLimit(ipKey, 20, 15 * 60 * 1000);
  if (!emailCheck.allowed) return tooMany(res, emailCheck.resetIn);
  if (!ipCheck.allowed) return tooMany(res, ipCheck.resetIn);

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from('users')
      .select('id, name, email, role, passwordhash, lastlogin')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      console.error('Auth lookup failed:', error.message);
      return json(res, 500, { error: 'Login is temporarily unavailable' });
    }

    // Constant-ish work even when the user does not exist (mitigates user enumeration timing).
    const stored = data ? data.passwordhash : '';
    const { valid, needsRehash } = await verifyPassword(password, stored || '');

    if (!data || !valid) {
      return json(res, 401, { error: 'Invalid credentials' });
    }

    resetRateLimit(emailKey);

    const nowIso = new Date().toISOString();
    const updates = { lastlogin: nowIso };
    if (needsRehash) {
      // Transparent migration: legacy (SHA-256/static-salt or plaintext) rows are
      // upgraded to scrypt on successful login. Nothing plaintext is ever stored.
      updates.passwordhash = await hashPassword(password);
    }
    await sb.from('users').update(updates).eq('id', data.id);

    const token = signSession({ id: data.id, name: data.name, email: data.email, role: data.role });

    return json(res, 200, {
      success: true,
      token,
      expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      user: { id: data.id, name: data.name, email: data.email, role: data.role },
    });
  } catch (err) {
    console.error('Auth error:', err && err.message);
    return json(res, 500, { error: 'Login is temporarily unavailable' });
  }
};
