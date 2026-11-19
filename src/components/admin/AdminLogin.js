import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Lock, Mail, AlertTriangle, Shield } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { validateLoginForm } from '../../lib/security';

export default function AdminLogin({ onSuccess }) {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverError, setServerError] = useState('');
  const [rateLimited, setRateLimited] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const LOCK_MS = 15 * 60 * 1000;

  // Start the lockout countdown the moment the server (or local limiter) reports it.
  useEffect(() => {
    if (rateLimited && !lockUntil) setLockUntil(Date.now() + LOCK_MS);
  }, [rateLimited, lockUntil]);

  // Tick once per second while locked so the countdown stays live.
  useEffect(() => {
    if (!lockUntil) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockUntil]);

  const lockRemaining = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;

  // Auto re-enable the form when the countdown elapsed.
  useEffect(() => {
    if (lockUntil && lockRemaining === 0) {
      setLockUntil(0);
      setRateLimited(false);
      setAttempts(0);
    }
  }, [lockUntil, lockRemaining]);

  const formatRemaining = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  const update = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setErrors(e => ({ ...e, [k]: null }));
    setServerError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validateLoginForm(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    setLoading(true);
    setServerError('');

    // تأخير شبكة وهمي بسيط لمنح تجربة مستخدم سلسة
    await new Promise(r => setTimeout(r, 400));
    
    // استدعاء دالة تسجيل الدخول المربوطة بالسيرفر سحابياً
    const result = await login(form.email, form.password);
    setLoading(false);

    if (result.success) {
      // 1. إبلاغ المكون الأب بنجاح العملية (الـ App.jsx والـ Context هيلقطوها فوراً)
      if (onSuccess) {
        onSuccess(result.session);
      }
      
      // 2. ✅ تم حذف window.location.href التدميري نهائياً لمنع الريفريش والتحويل الخارجي الخاطئ
      
    } else {
      setAttempts(a => a + 1);
      setServerError(result.error);
      if (result.rateLimited) setRateLimited(true);
    }
  };

  return (
    <div className="admin-login">
      {/* The login screen lives in the same lit room as the storefront: a warm
          key light from the upper left, a cooler rim from the upper right, and
          a soft pool where the card sits. Percentage sizes only — clamp() and
          min() are invalid inside a radial-gradient size and silently drop the
          whole layer in Chromium. */}
      <div data-decor="true" className="admin-login-backdrop" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="admin-login-shell"
      >
        {/* Card */}
        <div className="admin-login-card">
          {/* Logo */}
          <div className="admin-login-head">
            <div className="admin-login-seal">
              <Shield size={24} color="#0d0b08" aria-hidden="true" />
            </div>
            <h1 className="admin-login-wordmark lit-wordmark">ZASHM</h1>
            <p className="admin-login-subtitle">Admin Panel</p>
          </div>

          {/* Error */}
          <AnimatePresence>
            {serverError && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                role="alert"
                 style={{ background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 20, display: 'flex', gap: 8, alignItems: 'flex-start' }}
              >
                <AlertTriangle size={14} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
                <p style={{ color: 'var(--red)', fontSize: 12 }}>{serverError}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Rate limited */}
          {rateLimited && (
            <div role="status" aria-live="polite" style={{ background: 'rgba(243,156,18,0.1)', border: '1px solid rgba(243,156,18,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 20 }}>
              <p style={{ color: '#f39c12', fontSize: 12 }}>🔒 Account temporarily locked due to too many failed attempts. Try again in {formatRemaining(lockRemaining)}.</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="admin-email" style={{ display: 'block', fontSize: 11, color: 'var(--text3)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Email Address</label>
              <div style={{ position: 'relative' }}>
                <Mail size={14} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: errors.email ? 'var(--red)' : 'var(--text3)' }} />
                <input
                  type="email"
                  id="admin-email"
                  value={form.email}
                  onChange={e => update('email', e.target.value)}
                  placeholder="admin@zashm.com"
                  style={{ width: '100%', paddingLeft: 40, borderColor: errors.email ? 'var(--red)' : undefined }}
                  autoComplete="email"
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'admin-email-error' : undefined}
                />
              </div>
              {errors.email && <p id="admin-email-error" role="alert" style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{errors.email}</p>}
            </div>

            <div style={{ marginBottom: 24 }}>
              <label htmlFor="admin-password" style={{ display: 'block', fontSize: 11, color: 'var(--text3)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <Lock size={14} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: errors.password ? 'var(--red)' : 'var(--text3)' }} />
                <input
                  id="admin-password"
                  type={showPwd ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => update('password', e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', paddingLeft: 40, paddingRight: 48, borderColor: errors.password ? 'var(--red)' : undefined }}
                  autoComplete="current-password"
                  aria-invalid={!!errors.password}
                  aria-describedby={errors.password ? 'admin-password-error' : undefined}
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  aria-label={showPwd ? 'Hide password' : 'Show password'}
                  aria-pressed={showPwd}
                  style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {errors.password && <p id="admin-password-error" role="alert" style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{errors.password}</p>}
            </div>

            {/* Attempt indicator */}
            {attempts > 0 && attempts < 5 && (
              <p style={{ color: '#f39c12', fontSize: 11, marginBottom: 12, textAlign: 'center' }}>
                {5 - attempts} attempt{5 - attempts !== 1 ? 's' : ''} remaining before lockout
              </p>
            )}

            <motion.button
              type="submit"
              disabled={loading || rateLimited}
              className="gold-btn"
              style={{ width: '100%', opacity: loading || rateLimited ? 0.6 : 1, position: 'relative', overflow: 'hidden' }}
              whileTap={{ scale: 0.98 }}
            >
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    style={{ width: 14, height: 14, border: '2px solid var(--bg)', borderTopColor: 'transparent', borderRadius: '50%' }}
                  />
                  Authenticating...
                </span>
              ) : 'Sign In to Admin'}
            </motion.button>
          </form>

        </div>
      </motion.div>
    </div>
  );
}