import React, { useState, useEffect, createContext, useContext } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowUp, CheckCircle, AlertCircle, Info, X, ShoppingBag, Bell } from 'lucide-react';
import { useStore } from '../../store';

// Back to Top
export function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handler = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);
  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0 }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{ position: 'fixed', bottom: 90, right: 24, width: 44, height: 44, borderRadius: '50%', background: 'var(--gold)', color: 'var(--bg)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 800, boxShadow: '0 4px 20px rgba(201,168,76,0.4)' }}
          whileHover={{ scale: 1.1, boxShadow: '0 6px 30px rgba(201,168,76,0.6)' }}
          whileTap={{ scale: 0.9 }}
          className="back-to-top"
        ><ArrowUp size={18} /></motion.button>
      )}
    </AnimatePresence>
  );
}

// Toast System
const ToastContext = createContext(null);
let toastId = 0;
let addToastGlobal = null;

export function Toaster() {
  const [toasts, setToasts] = useState([]);
  addToastGlobal = (toastItem) => {
    const id = ++toastId;
    setToasts(prev => [...prev, { ...toastItem, id }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  };

  // الأيقونات حسب النوع
  const icons = { success: CheckCircle, error: AlertCircle, info: Info };
  
  // توحيد الألوان كلياً لخدمة الطابع الأسود والذهبي للبراند
  const themeGold = '#c9a84c';

  return (
    <div style={{ position: 'fixed', top: 90, right: 24, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AnimatePresence>
        {toasts.map(t => {
          const Icon = icons[t.type] || Info;
          return (
            <motion.div key={t.id}
              initial={{ opacity: 0, x: 80, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 80, scale: 0.9 }}
              style={{ 
                background: '#111111', 
                border: `1px solid ${themeGold}`, 
                borderRadius: 4, 
                padding: '12px 16px', 
                minWidth: 260, 
                maxWidth: 340, 
                display: 'flex', 
                alignItems: 'center', 
                gap: 10, 
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.6), 0 0 15px rgba(201, 168, 76, 0.2)' 
              }}>
              <Icon size={16} color={themeGold} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 13, flex: 1, color: '#ffffff' }}>{t.message}</span>
              <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}><X size={14} /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// دالة الـ toast الأساسية الذكية والداعمة للصيغتين لحماية المتصفح من الكراش
export function toast(message, type = 'info') {
  if (addToastGlobal) addToastGlobal({ message, type });
}

// ربط الصيغ المتقدمة (toast.success و toast.error) لتوفير الدعم الشامل للمشروع
toast.success = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'success' });
};

toast.error = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'error' });
};

toast.info = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'info' });
};

// Order Notification
export function OrderNotification() {
  const { newOrderNotification, clearOrderNotification, orders } = useStore();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (newOrderNotification) {
      setShow(true);
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start(); osc.stop(ctx.currentTime + 0.5);
      } catch(e) {}
      setTimeout(() => { setShow(false); clearOrderNotification(); }, 5000);
    }
  }, [newOrderNotification, clearOrderNotification]);

  const latest = (orders && orders.length > 0) ? orders[0] : null;

  return (
    <AnimatePresence>
      {show && latest && (
        <motion.div
          initial={{ opacity: 0, y: -80, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -80, scale: 0.9 }}
          style={{ position: 'fixed', top: 90, left: '50%', transform: 'translateX(-50%)', zIndex: 9999, background: '#111111', border: '1px solid var(--gold)', borderRadius: 4, padding: '16px 24px', boxShadow: '0 10px 30px rgba(0, 0, 0, 0.6), 0 0 15px rgba(201, 168, 76, 0.2)', display: 'flex', alignItems: 'center', gap: 14, minWidth: 320 }}
        >
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(201,168,76,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse-gold 2s infinite' }}>
            <Bell size={18} color="var(--gold)" />
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)', letterSpacing: 1, textTransform: 'uppercase' }}>New Order!</p>
            <p style={{ fontSize: 13, color: '#ffffff', marginTop: 2 }}>{latest.customer ?? 'Order'} — EGP {(latest.total ?? 0).toLocaleString()}</p>
          </div>
          <button onClick={() => { setShow(false); clearOrderNotification(); }}
            style={{ marginLeft: 'auto', color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer' }}><X size={16} /></button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}