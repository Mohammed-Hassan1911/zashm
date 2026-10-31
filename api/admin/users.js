'use strict';

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  tooMany,
  requirePerm,
  supabaseAdmin,
  hashPassword,
  validateUserPayload,
} = require('../_lib');

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdate || row.createdat || row.created_at || row.createdAt || null,
    lastLogin: row.lastlogin || row.last_login || row.lastLogin || null,
  };
}

// Serialized by the DB trigger in supabase/admin_protection.sql; this JS check
// exists to return a helpful 409 before hitting the trigger.
async function countAdmins(sb) {
  const { data, error } = await sb.from('users').select('id').eq('role', 'admin');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

const LAST_ADMIN_MESSAGE = 'Cannot remove the last admin. Promote another admin first.';

async function insertUserWithFallback(sb, baseRecord) {
  const attempts = [
    { ...baseRecord },
    { ...baseRecord, id: Date.now() },
    { ...baseRecord, id: `usr_${Date.now()}` },
  ];
  let lastErr = null;
  for (const record of attempts) {
    try {
      const { data, error } = await sb.from('users').insert([record]).select().single();
      if (error) {
        lastErr = error;
        if (/duplicate|unique/i.test(error.message)) throw error;
        continue;
      }
      return data;
    } catch (e) {
      throw e;
    }
  }
  throw lastErr || new Error('Could not create user');
}

// ─── GET /api/admin/users — list (never includes password hashes) ────────────

async function listUsers(req, res) {
  const session = await requirePerm(req, res, 'users.read');
  if (!session) return;

  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from('users').select('*').order('createdate', { ascending: false });
    if (error) return json(res, 500, { error: 'Could not load users' });
    return json(res, 200, { users: (data || []).map(toPublicUser) });
  } catch (err) {
    console.error('Users list error:', err && err.message);
    return json(res, 500, { error: 'Could not load users' });
  }
}

// ─── POST /api/admin/users — create ──────────────────────────────────────────

async function createUser(req, res) {
  const session = await requirePerm(req, res, 'users.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminuser:${ip}`, 30, 15 * 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 16 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const input = (body && body.user) || body || {};
  const u = validateUserPayload(input, { requirePassword: true });
  if (!u) return json(res, 422, { error: 'Invalid user data (name, email, role and a 12+ character password are required)' });

  try {
    const sb = supabaseAdmin();
    const { data: existing } = await sb.from('users').select('id').eq('email', u.email).maybeSingle();
    if (existing) return json(res, 409, { error: 'Email already exists' });

    const record = {
      name: u.name,
      email: u.email,
      role: u.role,
      passwordhash: await hashPassword(u.password),
      createdate: new Date().toISOString(),
      lastlogin: null,
    };
    const data = await insertUserWithFallback(sb, record);
    return json(res, 200, { success: true, user: toPublicUser(data) });
  } catch (err) {
    console.error('User create failed:', err && err.message);
    if (/duplicate|unique/i.test(String(err.message))) return json(res, 409, { error: 'Email already exists' });
    return json(res, 500, { error: 'Could not create user' });
  }
}

// ─── PATCH /api/admin/users — update profile / role / password ───────────────

async function updateUser(req, res) {
  const session = await requirePerm(req, res, 'users.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminuser:${ip}`, 30, 15 * 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 16 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const id = String((body && body.id) || (req.query && req.query.id) || '').trim();
  const updates = (body && body.updates) || {};
  if (!id) return json(res, 400, { error: 'User id is required' });

  try {
    const sb = supabaseAdmin();
    const { data: existing, error } = await sb.from('users').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load user' });
    if (!existing) return json(res, 404, { error: 'User not found' });

    const merged = {
      name: updates.name !== undefined ? updates.name : existing.name,
      email: updates.email !== undefined ? updates.email : existing.email,
      role: updates.role !== undefined ? updates.role : existing.role,
      password: updates.password || undefined,
    };
    const u = validateUserPayload(merged, { requirePassword: false });
    if (!u) return json(res, 422, { error: 'Invalid user data (a 12+ character password is required when changing it)' });

    // SEC-C: never demote the only admin. The DB trigger is the real guard for
    // concurrent requests; this pre-check gives a clear error.
    if (String(existing.role) === 'admin' && String(u.role) !== 'admin') {
      const admins = await countAdmins(sb);
      if (admins <= 1) return json(res, 409, { error: LAST_ADMIN_MESSAGE });
    }

    if (u.email !== existing.email) {
      const { data: dup } = await sb.from('users').select('id').eq('email', u.email).neq('id', id).maybeSingle();
      if (dup) return json(res, 409, { error: 'Email already exists' });
    }

    const write = {};
    if (u.name !== existing.name) write.name = u.name;
    if (u.email !== existing.email) write.email = u.email;
    if (u.role !== existing.role) write.role = u.role;
    if (u.password) write.passwordhash = await hashPassword(u.password);

    if (Object.keys(write).length === 0) return json(res, 200, { success: true, user: toPublicUser(existing) });

    const invalidatesSessions = Boolean(write.role || write.passwordhash);
    const hasSessionVersion = Object.prototype.hasOwnProperty.call(existing, 'session_version')
      || Object.prototype.hasOwnProperty.call(existing, 'sessionVersion');
    const currentSv = Number(
      existing.session_version != null
        ? existing.session_version
        : (existing.sessionVersion != null ? existing.sessionVersion : 0)
    ) || 0;
    const update = { ...write };
    if (invalidatesSessions && hasSessionVersion) {
      update.session_version = currentSv + 1;
    }

    const { error: updErr } = await sb.from('users').update(update).eq('id', id);
    if (updErr) throw updErr;

    if (invalidatesSessions && !hasSessionVersion) {
      console.warn('Session revocation skipped: session_version migration is not applied');
    }

    const { data: fresh } = await sb.from('users').select('*').eq('id', id).maybeSingle();
    return json(res, 200, { success: true, user: toPublicUser(fresh) });
  } catch (err) {
    console.error('User update failed:', err && err.message);
    if (/last[_ ]?admin/i.test(String(err.message))) return json(res, 409, { error: LAST_ADMIN_MESSAGE });
    if (/duplicate|unique/i.test(String(err.message))) return json(res, 409, { error: 'Email already exists' });
    return json(res, 500, { error: 'Could not update user' });
  }
}

// ─── DELETE /api/admin/users ─────────────────────────────────────────────────

async function deleteUser(req, res) {
  const session = await requirePerm(req, res, 'users.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminuser:${ip}`, 30, 15 * 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    /* tolerated */
  }

  const id = String((body && body.id) || (req.query && req.query.id) || '').trim();
  if (!id) return json(res, 400, { error: 'User id is required' });
  if (String(id) === String(session.sub)) {
    return json(res, 400, { error: 'Cannot delete own account' });
  }

  try {
    const sb = supabaseAdmin();
    const { data: target, error } = await sb.from('users').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load user' });
    if (!target) return json(res, 404, { error: 'User not found' });

    if (String(target.role) === 'admin') {
      const admins = await countAdmins(sb);
      if (admins <= 1) return json(res, 409, { error: LAST_ADMIN_MESSAGE });
    }

    const { error: delErr } = await sb.from('users').delete().eq('id', id);
    if (delErr) throw delErr;
    return json(res, 200, { success: true });
  } catch (err) {
    console.error('User delete failed:', err && err.message);
    if (/last[_ ]?admin/i.test(String(err.message))) return json(res, 409, { error: LAST_ADMIN_MESSAGE });
    return json(res, 500, { error: 'Could not delete user' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'GET') return listUsers(req, res);
  if (req.method === 'POST') return createUser(req, res);
  if (req.method === 'PATCH') return updateUser(req, res);
  if (req.method === 'DELETE') return deleteUser(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
