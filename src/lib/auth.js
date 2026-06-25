import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { createSession, getSession, destroySession, hashPassword, verifyPassword, checkRateLimit, resetRateLimit, db } from './security';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // تهيئة النظام والتحقق من الجلسة وجلب البيانات
  useEffect(() => {
    async function init() {
      try {
        console.log("🔄 [ZASHM AUTH] Starting initialization...");
        
        const existing = getSession();
        if (existing) {
          console.log("🔑 [ZASHM AUTH] Existing session found:", existing);
          setSession(existing);
        }

        if (db.syncFromServer) {
          await db.syncFromServer();
        }

        const storedUsers = db.getAll('users') || [];
        setUsers(storedUsers);
        console.log(`👥 [ZASHM AUTH] Synced ${storedUsers.length} users from DB.`);
      } catch (error) {
        console.error("❌ Error during auth initialization:", error);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  const login = useCallback(async (email, password) => {
    try {
      if (!email || !password) {
        return { success: false, error: 'Email and password are required' };
      }

      const cleanEmail = email.trim().toLowerCase();
      console.log("🚀 [ZASHM LOGIN] Attempting login for:", cleanEmail);
      
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

      let storedUsers = db.getAll('users') || [];
      let user = storedUsers.find(u => u && u.email && u.email.toString().trim().toLowerCase() === cleanEmail);

      if (!user && db.syncFromServer) {
        await db.syncFromServer();
        storedUsers = db.getAll('users') || [];
        user = storedUsers.find(u => u && u.email && u.email.toString().trim().toLowerCase() === cleanEmail);
      }

      if (!user) {
        return { success: false, error: 'Invalid email or password' };
      }

      const userHash = user.passwordHash || user.passwordhash;
      const valid = await verifyPassword(password, userHash);
      if (!valid) {
        return {
          success: false,
          error: `Invalid credentials. ${rateCheck.remaining} attempts remaining.`,
        };
      }

      resetRateLimit(rateLimitKey);
      
      // ─── [حل مشكلة ثبات الباسورد والهاش التلقائي] ──────────────────────────
      const isSHA256 = /^[a-f0-9]{64}$/i.test(userHash?.trim());
      let updatedFields = { lastLogin: new Date().toISOString() };
      
      // نجهز نسخة محدثة من كائن اليوزر عشان الجلسة تتسيف صح ومترجعش قديمة
      let userForSession = { ...user, ...updatedFields };

      if (!isSHA256) {
        console.log("🔒 [ZASHM SECURITY] Generating secure hash...");
        const newSecureHash = await hashPassword(password.trim());
        updatedFields.passwordHash = newSecureHash;
        userForSession.passwordHash = newSecureHash; // تحديث الجلسة بالهاش الجديد فوراً!
      }

      // تحديث قاعدة البيانات
      await db.update('users', user.id, updatedFields);
      setUsers(db.getAll('users') || []);
      // ──────────────────────────────────────────────────────────────────────────

      // 1. إنشاء الجلسة بالكائن المحدث بالكامل (عشان الباسورد الجديد يثبت)
      const newSession = createSession(userForSession);
      
      // 2. تحديث الـ State
      setSession(newSession);

      await new Promise(resolve => setTimeout(resolve, 50));
      return { success: true, session: newSession, user: userForSession };

    } catch (loginError) {
      console.error("💥 [ZASHM LOGIN] Critical crash:", loginError);
      return { success: false, error: `Internal login error: ${loginError.message}` };
    }
  }, []);

  const logout = useCallback(() => {
    destroySession();
    setSession(null);
    console.log("🔒 [ZASHM AUTH] User logged out.");
  }, []);

  const hasPermission = useCallback((permission) => {
    if (!session) return false;
    const PERMISSIONS = {
      admin: ['*'],
      manager: ['products.read', 'products.write', 'orders.read', 'orders.write', 'discounts.read', 'discounts.write', 'analytics.read', 'dashboard.read'],
      support: ['orders.read', 'dashboard.read'],
    };
    const perms = PERMISSIONS[session.role] || [];
    return perms.includes('*') || perms.includes(permission);
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
    const cleanEmail = email.trim().toLowerCase();
    
    const storedUsers = db.getAll('users') || [];
    const existing = storedUsers.find(u => u && u.email && u.email.toString().trim().toLowerCase() === cleanEmail);
    if (existing) return { success: false, error: 'Email already exists' };
    
    const hash = await hashPassword(password);
    const newUser = { 
      id: `usr_${Date.now()}`, 
      name, 
      email: cleanEmail, 
      role, 
      passwordHash: hash, 
      createdAt: new Date().toISOString(), 
      lastLogin: null 
    };
    
    await db.insert('users', newUser);
    setUsers(db.getAll('users') || []);
    return { success: true };
  }, [hasPermission]);

  const updateUser = useCallback(async (id, updates) => {
    if (!hasPermission('users.write')) return { success: false, error: 'Unauthorized' };
    
    const finalUpdates = { ...updates };

    if (finalUpdates.email) {
      finalUpdates.email = finalUpdates.email.trim().toLowerCase();
    }

    if (finalUpdates.password) {
      finalUpdates.passwordHash = await hashPassword(finalUpdates.password);
      delete finalUpdates.password;
    }

    // تحديث قاعدة البيانات للسيرفر
    await db.update('users', id, finalUpdates);
    
    // 🔥 [حل التعديل الذاتي] لو الأدمن بيعدل بيانات نفسه، لازم نحدث جلسته الحالية في المتصفح فوراً عشان ميرجعش قديم!
    if (id === session?.userId) {
      console.log("🔄 [ZASHM AUTH] Admin updated their own data. Refreshing active session...");
      const updatedUserObj = {
        id: session.userId,
        name: finalUpdates.name || session.name,
        email: finalUpdates.email || session.email,
        role: finalUpdates.role || session.role,
        passwordHash: finalUpdates.passwordHash || session.passwordHash
      };
      const refreshedSession = createSession(updatedUserObj);
      setSession(refreshedSession);
    }

    setUsers(db.getAll('users') || []);
    return { success: true };
  }, [hasPermission, session]);

  const deleteUser = useCallback(async (id) => {
    if (!hasPermission('users.write')) return { success: false, error: 'Unauthorized' };
    if (id === session?.userId) return { success: false, error: 'Cannot delete own account' };
    
    await db.delete('users', id);
    setUsers(db.getAll('users') || []);
    return { success: true };
  }, [hasPermission, session]);

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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, background: 'var(--bg)' }}>
      <p style={{ color: 'var(--red)', fontFamily: 'var(--font-display)', fontSize: 24 }}>Access Denied</p>
      <p style={{ color: 'var(--text3)', fontSize: 13 }}>You don't have permission to view this page</p>
    </div>
  );
}