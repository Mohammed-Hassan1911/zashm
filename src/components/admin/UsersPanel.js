import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Trash2, Edit, Shield, Eye, Users, Key } from 'lucide-react';
import { useAuth } from '../../lib/auth';

const ROLE_CONFIG = {
  admin: { color: 'var(--gold)', bg: 'rgba(201,168,76,0.1)', icon: Shield, label: 'Admin', desc: 'Full system access' },
  manager: { color: '#3498db', bg: 'rgba(52,152,219,0.1)', icon: Edit, label: 'Manager', desc: 'Products & orders' },
  support: { color: '#27ae60', bg: 'rgba(39,174,96,0.1)', icon: Eye, label: 'Support', desc: 'View orders only' },
};

export default function UsersPanel() {
  const { users, addUser, updateUser, deleteUser, session } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'support' });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const update = (k, v) => { 
    setForm(f => ({ ...f, [k]: v })); 
    setErrors(e => ({ ...e, [k]: null })); 
  };

  const validate = () => {
    const e = {};
    if (!form.name.trim()) e.name = 'Name required';
    if (!form.email.trim()) e.email = 'Email required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Invalid email';
    
    if (!editingId && !form.password) e.password = 'Password required';
    if (form.password && form.password.length < 6) e.password = 'Min 6 characters';
    return e;
  };

  const handleEdit = (user) => {
    setEditingId(user.id);
    setForm({
      name: user.name,
      email: user.email,
      password: '', 
      role: user.role || 'support'
    });
    setErrors({});
    setShowForm(true); 
  };

  const handleSave = async () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    setLoading(true);
    
    try {
      if (editingId) {
        const updatedData = { name: form.name, email: form.email, role: form.role };
        if (form.password && form.password.trim() !== '') {
          updatedData.password = form.password;
        }
        
        await updateUser(editingId, updatedData);
        if (typeof window.toast === 'function') window.toast('تم تحديث بيانات العضو بنجاح! 🔄');
      } else {
        await addUser(form);
        if (typeof window.toast === 'function') window.toast('تم إضافة عضو الفريق بنجاح! 🚀');
      }
      
      setShowForm(false);
      setEditingId(null);
      setForm({ name: '', email: '', password: '', role: 'support' });
    } catch (err) {
      console.error("Error saving user:", err);
      if (typeof window.toast === 'function') window.toast('⚠️ حدث خطأ أثناء حفظ بيانات العضو.');
    } finally {
      setLoading(false);
    }
  };

  const storedUsers = users ? users.filter(u => u.id) : []; 

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 4 }}>{storedUsers.length} team members</p>
        </div>
        <button className="gold-btn" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px' }}
          onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: '', email: '', password: '', role: 'support' }); setErrors({}); }}>
          <Plus size={14} /> Add User
        </button>
      </div>

      {/* Role Legend */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        {Object.entries(ROLE_CONFIG).map(([role, cfg]) => {
          const Icon = cfg.icon;
          const count = storedUsers.filter(u => u.role === role).length;
          return (
            <div key={role} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '16px 20px' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                <div style={{ width: 32, height: 32, borderRadius: 6, background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={15} color={cfg.color} />
                </div>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: cfg.color }}>{cfg.label}</p>
                  <p style={{ fontSize: 10, color: 'var(--text3)' }}>{cfg.desc}</p>
                </div>
              </div>
              <p style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: cfg.color }}>{count}</p>
            </div>
          );
        })}
      </div>

      {/* Users Table */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg3)', borderBottom: '1px solid var(--border)' }}>
              {['User','Role','Last Login','Actions'].map(h => (
                <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, color: 'var(--text3)', letterSpacing: 1, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {storedUsers.map(user => {
              const cfg = ROLE_CONFIG[user.role] || ROLE_CONFIG.support;
              const isMe = user.id === session?.userId;
              return (
                <motion.tr key={user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ width: 36, height: 36, borderRadius: '50%', background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <span style={{ color: cfg.color, fontWeight: 700, fontSize: 14 }}>{user.name ? user.name[0] : 'U'}</span>
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 500 }}>{user.name} {isMe && <span style={{ color: 'var(--gold)', fontSize: 10 }}>(you)</span>}</p>
                        <p style={{ fontSize: 11, color: 'var(--text3)' }}>{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <span style={{ background: cfg.bg, color: cfg.color, padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{cfg.label}</span>
                  </td>
                  <td style={{ padding: '14px 16px', color: 'var(--text3)', fontSize: 12 }}>
                    {user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never'}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* تصفية وتنظيف زر الـ Edit بالكامل لمنع أي كراش نهائياً */}
                      <button 
                        onClick={() => handleEdit(user)}
                        style={{ 
                          padding: '5px 10px', 
                          background: '#111111', 
                          border: '1px solid #c9a84c', 
                          borderRadius: 4, 
                          color: '#ffffff', 
                          cursor: 'pointer', 
                          fontSize: 11,
                          transition: 'all 0.2s ease'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#c9a84c'; e.currentTarget.style.color = '#111111'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = '#111111'; e.currentTarget.style.color = '#ffffff'; }}
                      >
                        Edit
                      </button>
                      {!isMe && (
                        <button onClick={() => { if(window.confirm('Are you sure you want to remove this user?')) deleteUser(user.id); }}
                          style={{ padding: '5px 10px', background: 'rgba(192,57,43,0.1)', border: '1px solid rgba(192,57,43,0.2)', borderRadius: 4, color: 'var(--red)', cursor: 'pointer', fontSize: 11 }}>
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Permission Matrix */}
      <div style={{ marginTop: 24, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 24 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 16 }}>Permission Matrix</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text3)' }}>Feature</th>
                {['Admin','Manager','Support'].map(r => <th key={r} style={{ padding: '8px 12px', color: ROLE_CONFIG[r.toLowerCase()]?.color }}>{r}</th>)}
              </tr>
            </thead>
            <tbody>
              {[
                ['Dashboard', true, true, true],
                ['View Orders', true, true, true],
                ['Change Order Status', true, true, false],
                ['Manage Products', true, true, false],
                ['Manage Discounts', true, true, false],
                ['Analytics', true, true, false],
                ['Manage Users', true, false, false],
                ['System Settings', true, false, false],
              ].map(([feature, ...perms]) => (
                <tr key={feature} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{feature}</td>
                  {perms.map((has, i) => (
                    <td key={i} style={{ padding: '8px 12px', textAlign: 'center' }}>
                      <span style={{ fontSize: 14 }}>{has ? '✅' : '⛔'}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {showForm && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowForm(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000 }}
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              style={{
                position: 'fixed',
                top: '5vh',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 440,
                maxWidth: '90vw',
                maxHeight: '90vh',
                overflowY: 'auto',
                background: 'var(--bg2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 32,
                zIndex: 2001,
                boxSizing: 'border-box'
              }}
            >
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, marginBottom: 24 }}>
                {editingId ? 'Edit User' : 'Add Team Member'}
              </h2>

              <div style={{ display: 'grid', gap: 14 }}>
                {[
                  ['Full Name', 'name', 'text'],
                  ['Email Address', 'email', 'email']
                ].map(([lbl, key, type]) => (
                  <div key={key}>
                    <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                      {lbl}
                    </label>
                    <input
                      type={type}
                      value={form[key]}
                      onChange={e => update(key, e.target.value)}
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: 6,
                        border: `1px solid ${errors[key] ? 'var(--red)' : 'var(--border)'}`,
                        outline: 'none'
                      }}
                    />
                    {errors[key] && (
                      <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 3 }}>
                        {errors[key]}
                      </p>
                    )}
                  </div>
                ))}

                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Role
                  </label>
                  <select
                    value={form.role}
                    onChange={e => update('role', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px',
                      borderRadius: 6,
                      border: `1px solid ${errors.role ? 'var(--red)' : 'var(--border)'}`,
                      outline: 'none',
                      background: 'var(--bg3)',
                      color: 'var(--text)'
                    }}
                  >
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="support">Support</option>
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: 11, color: 'var(--text3)', display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={e => update('password', e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px',
                      borderRadius: 6,
                      border: `1px solid ${errors.password ? 'var(--red)' : 'var(--border)'}`,
                      outline: 'none'
                    }}
                    placeholder={editingId ? "Leave blank to keep current password" : "Min 6 characters"}
                  />
                  {errors.password && (
                    <p style={{ color: 'var(--red)', fontSize: 11, marginTop: 3 }}>
                      {errors.password}
                    </p>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                <button className="gold-btn" style={{ flex: 1 }} onClick={handleSave}>
                  {loading ? 'Saving...' : editingId ? 'Save Changes' : 'Add User'}
                </button>
                <button className="outline-btn" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}