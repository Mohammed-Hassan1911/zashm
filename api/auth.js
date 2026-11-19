'use strict';

const {
  json,
  safeLogError,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  resetRateLimitShared,
  tooMany,
  supabaseAdmin,
  signSession,
  hashPassword,
  verifyPassword,
  EMAIL_RE,
  setSessionCookie,
  setCsrfCookie,
  clearSessionCookie,
  clearCsrfCookie,
  newCsrfToken,
  requestOriginAllowed,
  readSession,
  SESSION_TTL_MS,
} = require('./_lib');
const errorsHandler = require('./_errors');

// A real scrypt hash used when the email does not exist, so "no such user" and
// "wrong password" cost the same. Never matches a real password.
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$9235e98da7b9db0c3908d02f9877f404$44031c67af6a4173a996c8a200fefd4358a05a676110367be48b9e20970e5bb1';

// One window for every login budget, so a retry that clears one clears the
// others at the same moment.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/**
 * POST /api/auth  { action: 'login', email, password }
 * POST /api/auth  { action: 'logout' }
 * Server-side authentication. Never returns password hashes or the session
 * token: the token is delivered in an HttpOnly cookie.
 */
module.exports = async function handler(req, res) {
  // The Hobby plan caps a deployment at 12 Serverless Functions and this
  // project is at the cap, so /api/errors is served by this function through a
  // rewrite (vercel.json) instead of a file of its own. The marker is only set
  // by that rewrite; a direct /api/auth?__zshm_route=errors reaches the same
  // bounded handler and never touches login.
  if (req.query && req.query.__zshm_route === 'errors') {
    return errorsHandler(req, res);
  }

  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!requestOriginAllowed(req)) {
    return json(res, 403, { error: 'Request origin is not allowed' });
  }

  const ip = clientIp(req);

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  if (!body || (body.action !== 'login' && body.action !== 'logout')) {
    return json(res, 400, { error: 'Invalid request' });
  }

  if (body.action === 'logout') {
    // Best-effort server-side revocation: when supabase/session_revocation.sql
    // has been applied, bumping users.session_version invalidates every session
    // token for this user immediately (all devices), instead of leaving a
    // stolen 4-hour cookie usable. Without the migration this is a no-op and
    // logout still clears both cookies below.
    const auth = readSession(req);
    const userId = auth && auth.session ? auth.session.sub : null;
    if (userId !== null && userId !== undefined) {
      try {
        const sb = supabaseAdmin();
        const { data: row, error } = await sb
          .from('users')
          .select('*')
          .eq('id', userId)
          .maybeSingle();
        if (!error && row && Object.prototype.hasOwnProperty.call(row, 'session_version')) {
          const current = Number(row.session_version) || 0;
          const { error: updateError } = await sb
            .from('users')
            .update({ session_version: current + 1 })
            .eq('id', userId);
          if (updateError) {
            console.warn('Logout revocation skipped: could not bump session_version');
          }
        }
      } catch (e) {
        // The local cookies are still cleared; never fail logout on DB errors.
        safeLogError('Logout revocation skipped', e);
      }
    }
    clearSessionCookie(res);
    clearCsrfCookie(res);
    return json(res, 200, { success: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) {
    return json(res, 400, { error: 'Email and password are required' });
  }
  if (email.length > 200 || !EMAIL_RE.test(email) || password.length > 128) {
    return json(res, 400, { error: 'Invalid email or password format' });
  }

  // Server-side rate limiting (per IP+email and per IP) — cannot be reset by reloading the page.
  // The per-IP keys alone are weak against an attacker who rotates addresses
  // (mobile carriers and CGNAT make that trivial), so the account itself gets
  // a budget shared across every IP. It is looser than the per-IP+email budget
  // so a shared NAT cannot lock a real owner out, and a successful login
  // clears it. The three checks run together so login latency is unchanged.
  const emailKey = `login:${ip}:${email}`;
  const ipKey = `login:${ip}`;
  const accountKey = `login:acct:${email}`;
  const [emailCheck, ipCheck, accountCheck] = await Promise.all([
    rateLimitShared(emailKey, 5, LOGIN_WINDOW_MS),
    rateLimitShared(ipKey, 20, LOGIN_WINDOW_MS),
    rateLimitShared(accountKey, 12, LOGIN_WINDOW_MS),
  ]);
  if (!emailCheck.allowed) return tooMany(res, emailCheck.resetIn);
  if (!ipCheck.allowed) return tooMany(res, ipCheck.resetIn);
  if (!accountCheck.allowed) return tooMany(res, accountCheck.resetIn);

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      safeLogError('Auth lookup failed', error);
      return json(res, 500, { error: 'Login is temporarily unavailable' });
    }

    // Constant-ish work even when the user does not exist (mitigates user enumeration timing).
    const stored = data ? data.passwordhash : DUMMY_PASSWORD_HASH;
    const { valid, needsRehash } = await verifyPassword(password, stored || DUMMY_PASSWORD_HASH);

    if (!data || !valid) {
      return json(res, 401, { error: 'Invalid credentials' });
    }

    // Clear the failed-attempt budget for this IP+email in the SHARED limiter
    // too, otherwise a user who retried a few times gets 429 after a
    // successful login. The per-IP key is deliberately not reset. The account
    // key is cleared as well: the person who just proved they own the account
    // should not inherit a budget burnt by an attacker.
    await Promise.all([
      resetRateLimitShared(emailKey),
      resetRateLimitShared(accountKey),
    ]);

    const nowIso = new Date().toISOString();
    const updates = { lastlogin: nowIso };
    if (needsRehash) {
      // Transparent migration: legacy (SHA-256/static-salt or plaintext) rows are
      // upgraded to scrypt on successful login. Nothing plaintext is ever stored.
      updates.passwordhash = await hashPassword(password);
    }
    const { error: loginWriteError } = await sb.from('users').update(updates).eq('id', data.id);
    if (loginWriteError) {
      // Login still succeeds; but a silent failure means legacy hashes are
      // re-hashed every time and lastlogin lies, so surface it.
      safeLogError('Login bookkeeping update failed', loginWriteError);
    }

    const token = signSession({
      id: data.id,
      name: data.name,
      email: data.email,
      role: data.role,
      session_version: data.session_version,
    });

    // HttpOnly session + JS-readable CSRF double-submit token.
    const csrfToken = newCsrfToken();
    setSessionCookie(res, token, SESSION_TTL_MS);
    setCsrfCookie(res, csrfToken, SESSION_TTL_MS);

    return json(res, 200, {
      success: true,
      expiresAt: Date.now() + SESSION_TTL_MS,
      csrfToken,
      user: { id: data.id, name: data.name, email: data.email, role: data.role },
    });
  } catch (err) {
    safeLogError('Auth error', err);
    return json(res, 500, { error: 'Login is temporarily unavailable' });
  }
};
