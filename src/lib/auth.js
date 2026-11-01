import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { createSession, getSession, destroySession, checkRateLimit, resetRateLimit, hasPermission as sessionHasPermission, db } from './security';
import { api, setUnauthorizedHandler } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef(null);
  sessionRef.current = session;

  const loadUsers = useCallback(async () => {
    try {
      const payload = await api.get('/admin/users');
      setUsers(Array.isArray(payload.users) ? payload.users : []);
    } catch (err) {
      // No permission or session problem — users list simply stays empty.
      if (err && (err.status === 401 || err.status === 403)) setUsers([]);
    }
  }, []);

  // Any 401 from the server means the session token is no longer valid.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      destroySession();
      setSession(null);
      setUsers([]);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // تهيئة النظام والتحقق من الجلسة وجلب البيانات
  useEffect(() => {
    async function init() {
      try {
        const existing = getSession();
        if (existing) {
          setSession(existing);
        }

        await db.syncFromServer();

        if (existing) {
          await loadUsers();
        }
      } catch (error) {
        console.error('Error during auth initialization:', error);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, [loadUsers]);

  const login = useCallback(async (email, password) => {
    try {
      if (!email || !password) {
        return { success: false, error: 'Email and password are required' };
      }

      const cleanEmail = email.trim().toLowerCase();
      const rateLimitKey = `login_${cleanEmail}`;
      const rateCheck = checkRateLimit(rateLimitKey, 5, 15 * 60 * 1000);

      if (!rateCheck.allowed) {
        return {
          success: false,
          error: rateCheck.blocked
            ? `Too many attempts. Try again in ${Math.ceil(rateCheck.resetIn / 60)} minutes.`
            : 'Rate limit exceeded',
          rateLimited: true,
        };
      }

      let payload;
      try {
        payload = await api.post('/auth', { action: 'login', email: cleanEmail, password });
      } catch (err) {
        if (err && err.status === 429) {
          return { success: false, error: err.message, rateLimited: true };
        }
        if (err && err.status === 401) {
          return {
            success: false,
            error: `Invalid credentials. ${rateCheck.remaining} attempts remaining.`,
          };
        }
        throw err;
      }

      resetRateLimit(rateLimitKey);

      // The credential itself is the HttpOnly cookie set by the server. Keep
      // only non-secret UI state; cache the CSRF fallback in case cookie access
      // is restricted but the cookie is still sent.
      try {
        if (payload && payload.csrfToken) sessionStorage.setItem('zashm_csrf', payload.csrfToken);
      } catch (e) { /* storage may be unavailable */ }
      const userForSession = payload.user;
      const newSession = createSession(userForSession);
      setSession(newSession);

      if (['admin'].includes(newSession.role)) {
        await loadUsers();
      }

      return { success: true, session: newSession, user: userForSession };
    } catch (loginError) {
      console.error('Login error:', loginError && loginError.message);
      return { success: false, error: loginError.message || 'Login failed. Please try again.' };
    }
  }, [loadUsers]);

  const logout = useCallback(async () => {
    // Clear the server-side HttpOnly cookie first; never leave a live session
    // behind just because the client navigated away.
    try {
      await api.post('/auth', { action: 'logout' });
    } catch (e) {
      /* the local state is still cleared below */
    }
    destroySession();
    setSession(null);
    setUsers([]);
  }, []);

  const hasPermission = useCallback((permission) => {
    return sessionHasPermission(session, permission);
  }, [session]);

  const canAccess = useCallback((page) => {
    const PAGE_PERMS = {
      dashboard: 'dashboard.read',
      orders: 'orders.read',
      products: 'products.read',
      discounts: 'discounts.read',
      analytics: 'analytics.read',
      users: 'users.read',
      settings: 'settings.read',
    };
    return hasPermission(PAGE_PERMS[page] || page);
  }, [hasPermission]);

  const addUser = useCallback(async ({ name, email, password, role }) => {
    if (!hasPermission('users.write')) return { success: false, error: 'Unauthorized' };
    try {
      const payload = await api.post('/admin/users', { name, email, password, role });
      await loadUsers();
      return { success: true, user: payload.user };
    } catch (err) {
      return { success: false, error: err.message || 'Could not create user' };
    }
  }, [hasPermission, loadUsers]);

  const updateUser = useCallback(async (id, updates) => {
    if (!hasPermission('users.write')) return { success: false, error: 'Unauthorized' };
    try {
      const payload = await api.patch('/admin/users', { id, updates });
      await loadUsers();

      // لو الأدمن بيعدل بيانات نفسه، حدّث الجلسة الحالية فوراً عشان مترجعش قديمة
      if (String(id) === String(sessionRef.current?.userId)) {
        const updatedUser = payload.user || {};
        const roleChanged = updatedUser.role && updatedUser.role !== sessionRef.current.role;
        const passwordChanged = Boolean(updates && updates.password);

        // Role/password changes bump session_version on the server, which
        // revokes the current cookie. Sign out cleanly instead of keeping a
        // dead token in memory.
        if (roleChanged || passwordChanged) {
          await logout();
          return { success: true, user: payload.user, reauth: true };
        }

        const refreshedSession = {
          ...sessionRef.current,
          name: updatedUser.name || sessionRef.current.name,
          email: updatedUser.email || sessionRef.current.email,
          role: updatedUser.role || sessionRef.current.role,
        };
        setSession(refreshedSession);
        try { sessionStorage.setItem('zashm_session', JSON.stringify(refreshedSession)); } catch (e) { /* ignore */ }
      }

      return { success: true, user: payload.user };
    } catch (err) {
      return { success: false, error: err.message || 'Could not update user' };
    }
  }, [hasPermission, loadUsers, logout]);

  const deleteUser = useCallback(async (id) => {
    if (!hasPermission('users.write')) return { success: false, error: 'Unauthorized' };
    if (String(id) === String(sessionRef.current?.userId)) {
      return { success: false, error: 'Cannot delete own account' };
    }
    try {
      await api.del('/admin/users', { id });
      await loadUsers();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || 'Could not delete user' };
    }
  }, [hasPermission, loadUsers]);

  return (
    <AuthContext.Provider value={{ session, login, logout, hasPermission, canAccess, loading, users, addUser, updateUser, deleteUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function withAuth(Component, requiredPermission) {
  return function ProtectedComponent(props) {
    const { session, hasPermission, loading } = useAuth();

    if (loading) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
          <p style={{ color: 'var(--text2)' }}>Loading securely...</p>
        </div>
      );
    }

    if (!session) return <LoginRequired />;
    if (requiredPermission && !hasPermission(requiredPermission)) return <AccessDenied />;
    return <Component {...props} />;
  };
}

function LoginRequired() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, background: 'var(--bg)' }}>
      <div style={{ width: 48, height: 48, border: '2px solid var(--gold)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontSize: 22 }}>🔒</div>
      <p style={{ color: 'var(--text2)', fontFamily: 'var(--font-display)', fontSize: 20 }}>Authentication Required</p>
      <p style={{ color: 'var(--text3)', fontSize: 13 }}>Please log in to access this area</p>
    </div>
  );
}

function AccessDenied() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 8, background: 'var(--bg)' }}>
      <p style={{ color: 'var(--red)', fontFamily: 'var(--font-display)', fontSize: 24 }}>Access Denied</p>
      <p style={{ color: 'var(--text3)', fontSize: 13 }}>You don't have permission to view this page</p>
    </div>
  );
}
