import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { ArrowUp, CheckCircle, AlertCircle, AlertTriangle, Info, X, ShoppingBag, Heart } from 'lucide-react';

// Back to Top
export function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handler = () => setVisible(window.scrollY > 400);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);
  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0 }}
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          style={{ position: 'fixed', bottom: 90, right: 24, width: 44, height: 44, borderRadius: '50%', background: 'var(--gold)', color: 'var(--bg)', border: 'none', cursor: 'pointer', alignItems: 'center', justifyContent: 'center', zIndex: 800, boxShadow: '0 4px 20px rgba(201,168,76,0.4)' }}
          whileHover={{ scale: 1.1, boxShadow: '0 6px 30px rgba(201,168,76,0.6)' }}
          whileTap={{ scale: 0.9 }}
          className="back-to-top"
        ><ArrowUp size={18} /></motion.button>
      )}
    </AnimatePresence>,
    document.body
  );
}

// Toast System
let toastId = 0;
let addToastGlobal = null;

const TOAST_DURATION = {
  success: 3000,
  error: 3500,
  warning: 3500,
  info: 3000,
};

function ToastMessage({ toastItem, onDismiss, reduceMotion }) {
  const type = TOAST_DURATION[toastItem.type] ? toastItem.type : 'info';
  const message = String(toastItem.message);
  const normalizedMessage = message.toLowerCase();
  const Icon = type === 'success'
    ? (/wishlist|favorite|المفضلة/.test(normalizedMessage) ? Heart : /bag|cart|السلة/.test(normalizedMessage) ? ShoppingBag : CheckCircle)
    : type === 'error'
      ? AlertCircle
      : type === 'warning'
        ? AlertTriangle
        : Info;
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toastItem.id), TOAST_DURATION[type]);
    return () => window.clearTimeout(timer);
  }, [onDismiss, toastItem.id, type]);

  return (
    <motion.div
      className={`zashm-toast zashm-toast--${type}`}
      role={type === 'error' ? 'alert' : 'status'}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: 'easeOut' }}
    >
      <Icon className="zashm-toast-icon" size={18} color="#111" aria-hidden="true" />
      <span className="zashm-toast-message">{message}</span>
      <button
        type="button"
        className="zashm-toast-dismiss"
        onClick={() => onDismiss(toastItem.id)}
        aria-label="Dismiss notification"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </motion.div>
  );
}

export function Toaster() {
  const [toasts, setToasts] = useState([]);
  const reduceMotion = useReducedMotion();
  const addToast = useCallback((toastItem) => {
    const normalizedType = TOAST_DURATION[toastItem.type] ? toastItem.type : 'info';
    const normalizedMessage = String(toastItem.message);
    const nextToast = { ...toastItem, type: normalizedType, message: normalizedMessage, id: ++toastId };

    setToasts(prev => {
      if (prev.some(item => item.type === normalizedType && item.message === normalizedMessage)) return prev;

      return [...prev, nextToast].slice(-3);
    });
  }, []);
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(item => item.id !== id));
  }, []);

  useEffect(() => {
    addToastGlobal = addToast;
    return () => {
      if (addToastGlobal === addToast) addToastGlobal = null;
    };
  }, [addToast]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="zashm-toast-viewport">
      <div className="zashm-toast-stack" role="region" aria-label="Notifications" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map(item => (
            <ToastMessage
              key={item.id}
              toastItem={item}
              onDismiss={dismissToast}
              reduceMotion={reduceMotion}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>,
    document.body
  );
}

// The same entry point supports both toast(message, type) and named methods.
export function toast(message, type = 'info') {
  if (addToastGlobal) addToastGlobal({ message, type });
}

toast.success = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'success' });
};

toast.error = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'error' });
};

toast.warning = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'warning' });
};

toast.info = (message) => {
  if (addToastGlobal) addToastGlobal({ message, type: 'info' });
};

// 🎯 Order Notification (تم تعطيله لعدم إظهاره للعميل)
export function OrderNotification() {
  return null; // لا يظهر أي شيء على الشاشة
}