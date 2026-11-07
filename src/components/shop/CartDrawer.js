import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ShoppingBag, Trash2, Plus, Minus } from 'lucide-react';
import { useStore } from '../../store';
import { toast } from '../ui/BackToTop';
import { focusFirstElement, redirectOutsideFocus, trapTabKey } from '../../lib/focus-trap';
import { effectivePrice } from '../../lib/pricing';
import SafeImage from '../ui/SafeImage';

const FALLBACK_IMG = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="100"%3E%3Crect fill="%23222" width="80" height="100"/%3E%3C/svg%3E';

export default function CartDrawer() {
  const { cart, cartOpen, setCartOpen, removeFromCart, updateCartQty, cartTotal, setPage, appliedDiscount, removeAppliedDiscount } = useStore();
  const total = cartTotal() ?? 0;
  const panelRef = React.useRef(null);
  const openerRef = React.useRef(null);

  React.useEffect(() => {
    if (!cartOpen) return undefined;

    // Remember what opened the drawer (usually the bag button) so focus can
    // return there on close, then move focus inside the dialog.
    const opener = document.activeElement;
    openerRef.current = opener && typeof opener.focus === 'function' ? opener : null;
    focusFirstElement(panelRef.current);

    // Lock background scrolling while the overlay owns the screen.
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setCartOpen(false);
        return;
      }
      trapTabKey(event, panelRef.current);
    };
    const handleFocusIn = (event) => {
      redirectOutsideFocus(event, panelRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    // Safety net: Tab is trapped on keydown, but focus can still land outside
    // through a click, a script or a control disappearing while focused.
    document.addEventListener('focusin', handleFocusIn);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocusIn);
      document.body.style.overflow = previousBodyOverflow;
      const openerElement = openerRef.current;
      openerRef.current = null;
      if (openerElement && document.contains(openerElement)) {
        openerElement.focus({ preventScroll: true });
      }
    };
  }, [cartOpen, setCartOpen]);

  const changeQty = (item, nextQty) => {
    const result = updateCartQty(item.key, nextQty);
    if (result && result.success === false) {
      toast(result.error || 'Maximum available quantity reached.', 'warning');
    }
  };

  return (
    <AnimatePresence>
      {cartOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setCartOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, backdropFilter: 'blur(4px)' }}
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Shopping bag"
            tabIndex={-1}
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{ 
              position: 'fixed', 
              right: 0, 
              top: 0, 
              bottom: 0, 
              width: '100%',        // 🎯 أول تعديل: يأخذ 100% من عرض الشاشة على الموبايل عشان ما يخرجش برة
              maxWidth: 420,        // 🎯 ثاني تعديل: يثبت عند 420px كحد أقصى على الشاشات الكبيرة (الكمبيوتر)
              background: 'var(--bg2)', 
              borderLeft: '1px solid var(--border)', 
              zIndex: 2001, 
              display: 'flex', 
              flexDirection: 'column' 
            }}
          >
            {/* Header */}
            <div style={{ padding: '24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ShoppingBag size={20} color="var(--gold)" />
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>Shopping Bag</span>
                <span style={{ background: 'var(--gold)', color: 'var(--bg)', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                  {cart.reduce((s, i) => s + (i.qty ?? 0), 0)}
                </span>
              </div>
              <button onClick={() => setCartOpen(false)} aria-label="Close shopping bag" style={{ color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s' }}
                onMouseEnter={e => e.target.style.color = 'var(--gold)'}
                onMouseLeave={e => e.target.style.color = 'var(--text2)'}><X size={20} aria-hidden="true" /></button>
            </div>

            {/* Items */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
              {cart.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                  style={{ textAlign: 'center', padding: '80px 0' }}
                >
                  <ShoppingBag size={64} color="var(--border)" style={{ margin: '0 auto 20px' }} />
                  <p style={{ color: 'var(--text3)', fontSize: 14, marginBottom: 8 }}>Your bag is empty</p>
                  <p style={{ color: 'var(--text3)', fontSize: 12 }}>Add some luxury pieces to get started</p>
                  <button className="gold-btn" style={{ marginTop: 24 }} onClick={() => { setCartOpen(false); setPage('shop'); }}>
                    Explore Collection
                  </button>
                </motion.div>
              ) : (
                <AnimatePresence>
                  {cart.map(item => (
                    <motion.div
                      key={item.key}
                      layout
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20, height: 0, marginBottom: 0 }}
                      style={{ display: 'flex', gap: 14, marginBottom: 16, padding: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2, alignItems: 'center' }}
                    >
                      <SafeImage src={item.product?.images && item.product.images[0]} fallback={FALLBACK_IMG} alt={item.product?.name || 'Product'}
                        style={{ width: 80, height: 100, objectFit: 'cover', borderRadius: 1, flexShrink: 0 }} />
                      
                      {/* تفاصيل المنتج مع حماية المساحة المتاحة */}
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: 100, justifyContent: 'space-between' }}>
                        <div>
                          <p style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 500, marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.product?.name || 'Product'}</p>
                          <p style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 4 }}>Size: {item.size} · Color: {item.color}</p>
                          <p style={{ color: 'var(--gold)', fontSize: 14, fontWeight: 600, margin: 0 }}>
                            EGP {(effectivePrice(item.product) * (item.qty ?? 0)).toLocaleString()}
                          </p>
                        </div>
                        
                        {/* 🎯 السطر السفلي: توزيع ذكي يمنع التقاطع نهائياً */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8, marginTop: 'auto' }}>
                          
                          {/* كاونتر الكمية */}
                          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 2, background: 'rgba(0,0,0,0.1)', flexShrink: 0 }}>
                            <button onClick={() => item.qty > 1 ? changeQty(item, item.qty - 1) : removeFromCart(item.key)}
                              type="button" aria-label={`Decrease quantity of ${item.product?.name || 'item'}`}
                              style={{ width: 28, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>
                              <Minus size={11} aria-hidden="true" />
                            </button>
                            <span style={{ fontSize: 12, minWidth: 20, textAlign: 'center', color: 'var(--text)' }}>{item.qty}</span>
                            <button onClick={() => changeQty(item, item.qty + 1)}
                              type="button" aria-label={`Increase quantity of ${item.product?.name || 'item'}`}
                              style={{ width: 28, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>
                              <Plus size={11} aria-hidden="true" />
                            </button>
                          </div>

                          {/* زر الحذف مستقل وفي أقصى اليمين */}
                          <button onClick={() => removeFromCart(item.key)}
                            type="button" aria-label={`Remove ${item.product?.name || 'item'} from bag`}
                            style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s', padding: '4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}>
                            <Trash2 size={14} aria-hidden="true" />
                          </button>

                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>

            {/* Footer */}
            {cart.length > 0 && (
              <div style={{ padding: 24, borderTop: '1px solid var(--border)' }}>
                {appliedDiscount && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: 'rgba(201,168,76,0.08)', border: '1px solid var(--border-gold)', borderRadius: 2 }}>
                    <span style={{ color: 'var(--gold)', fontSize: 12 }}>🎉 {appliedDiscount.code} applied</span>
                    <button onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</button>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Total</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, color: 'var(--gold)' }}>EGP {total.toLocaleString()}</span>
                </div>
                <button className="gold-btn" style={{ width: '100%', marginBottom: 10 }}
                  onClick={() => { setCartOpen(false); setPage('checkout'); }}>
                  Proceed to Checkout
                </button>
                <button className="outline-btn" style={{ width: '100%' }}
                  onClick={() => { setCartOpen(false); setPage('cart'); }}>
                  View Full Cart
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}