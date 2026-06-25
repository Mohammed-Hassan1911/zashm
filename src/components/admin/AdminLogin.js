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
      console.log("🎉 [ADMIN LOGIN] Authentication successful, establishing state...");
      
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
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', overflow: 'hidden' }}>
      {/* Background */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 20% 50%, rgba(201,168,76,0.04) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(201,168,76,0.03) 0%, transparent 50%)' }} />
      {[...Array(4)].map((_, i) => (
        <motion.div key={i}
          style={{ position: 'absolute', width: 1, height: 1, borderRadius: '50%', background: 'var(--gold)', opacity: 0.15, left: `${20 + i * 22}%`, top: `${15 + i * 18}%` }}
          animate={{ scale: [1, 80, 1], opacity: [0.15, 0, 0.15] }}
          transition={{ duration: 8 + i * 2, repeat: Infinity, delay: i * 1.5 }}
        />
      ))}

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        style={{ width: '100%', maxWidth: 420, position: 'relative' }}
      >
        {/* Card */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '40px 36px', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: 36 }}>
            <motion.div
              style={{ width: 56, height: 56, background: 'linear-gradient(135deg, var(--gold-dark), var(--gold))', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}
              animate={{ boxShadow: ['0 0 0 0 rgba(201,168,76,0.4)', '0 0 0 12px rgba(201,168,76,0)', '0 0 0 0 rgba(201,168,76,0)'] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <Shield size={24} color="var(--bg)" />
            </motion.div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, letterSpacing: 4, marginBottom: 6 }} className="shimmer-text">ZASHM</h1>
            <p style={{ color: 'var(--text3)', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' }}>Admin Panel</p>
          </div>

          {/* Error */}
          <AnimatePresence>
            {serverError && (
              <motion.div
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                style={{ background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 20, display: 'flex', gap: 8, alignItems: 'flex-start' }}
              >
                <AlertTriangle size={14} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
                <p style={{ color: 'var(--red)', fontSize: 12 }}>{serverError}</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Rate limited */}
          {rateLimited && (
            <div style={{ background: 'rgba(243,156,18,0.1)', border: '1px solid rgba(243,156,18,0.3)', borderRadius: 6, padding: '10px 14px', marginBottom: 20 }}>
              <p style={{ color: '#f39c12', fontSize: 12 }}>🔒 Account temporarily locked due to too many failed attempts. Please wait before trying again.</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text3)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Email Address</label>
              <div style={{ position: 'relative' }}>
                <Mail size={14} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: errors.email ? 'var(--red)' : 'var(--text3)' }} />
                <input
                  type="email"
                  value={form.email}
                  onChange={e => update('email', e.target.value)}
                  placeholder="admin@zashm.com"
                  style={{ width: '100%', paddingLeft: 40, borderColor: errors.email ? 'var(--red)' : undefined }}
                  autoComplete="email"
                />
              </div>
              {errors.email && <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{errors.email}</p>}
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text3)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <Lock size={14} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: errors.password ? 'var(--red)' : 'var(--text3)' }} />
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={form.password}
                  onChange={e => update('password', e.target.value)}
                  placeholder="••••••••"
                  style={{ width: '100%', paddingLeft: 40, paddingRight: 40, borderColor: errors.password ? 'var(--red)' : undefined }}
                  autoComplete="current-password"
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {showPwd ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {errors.password && <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{errors.password}</p>}
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

          <p style={{ color: 'var(--text3)', fontSize: 11, textAlign: 'center', marginTop: 20 }}>
            🔒 Secured with SHA-256 hashing & rate limiting
          </p>
        </div>
      </motion.div>
    </div>
  );
}