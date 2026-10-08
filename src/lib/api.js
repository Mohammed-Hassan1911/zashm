// ─── ZASHM SERVER API CLIENT ──────────────────────────────────────────────────
// Thin fetch wrapper for the secure serverless API (see /api). All admin and
// order endpoints authenticate with the server-signed session token (Bearer).

const SESSION_KEY = 'zashm_session';

export class ApiError extends Error {
  constructor(status, message, payload) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload || {};
  }
}

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

export function getSessionToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    return session && session.token ? String(session.token) : null;
  } catch {
    return null;
  }
}

function extractError(status, payload) {
  if (payload && typeof payload.error === 'string' && payload.error) return payload.error;
  if (payload && Array.isArray(payload.errors) && payload.errors.length) return payload.errors[0];
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 429) return 'Too many requests. Please try again shortly.';
  return 'Request failed. Please try again.';
}

export async function apiFetch(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Network error — could not reach the server');
  }

  let payload = {};
  try {
    payload = await res.json();
  } catch (e) {
    payload = {};
  }

  if (res.status === 401 && unauthorizedHandler) {
    try {
      unauthorizedHandler();
    } catch (e) {
      /* handler must never break the caller */
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, extractError(res.status, payload), payload);
  }
  return payload;
}

export const api = {
  get: (path, opts) => apiFetch(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => apiFetch(path, { ...opts, method: 'POST', body }),
  patch: (path, body, opts) => apiFetch(path, { ...opts, method: 'PATCH', body }),
  del: (path, body, opts) => apiFetch(path, { ...opts, method: 'DELETE', body }),
};

// ─── حذف ملف من Storage (bucket products) مع منع الحذف المزدوج ──────────────
// نقطة وحيدة لحذف ملفات الصور المؤقتة من الـAdmin. إذا كان نفس الملف يُحذف في
// وقت واحد (مثلاً X و Cancel معاً)، يُعاد استخدام نفس الـpromise بدل إرسال
// طلب Delete ثانٍ — يحفظ ما سبق، يمنع duplicate delete، ولا يترك orphan.
const storageDeletePending = new Map();
export function deleteStorageFile(path) {
  if (!path) return Promise.resolve();
  const existing = storageDeletePending.get(path);
  if (existing) return existing;
  const run = (async () => {
    await api.del('/admin/upload', { path });
  })();
  storageDeletePending.set(path, run);
  run.then(() => storageDeletePending.delete(path)).catch(() => storageDeletePending.delete(path));
  return run;
}
