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

    // Lock background scrolling while the overlay owns the screen. `overflow:
    // hidden` alone does not stop the page scrolling behind the drawer on iOS
    // Safari, so the body is fixed in place for the life of the overlay and put
    // back exactly where it was on close. The drawer's own body keeps
    // `overscroll-behavior: contain`, so the two scroll areas never chain.
    const html = document.documentElement;
    const body = document.body;
    const liveY = typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset;
    const scrollY = Number.isFinite(liveY) ? liveY : 0;
    const lockedWidth = html.clientWidth;
    const previous = {
      htmlOverflow: html.style.overflow,
      htmlScrollBehavior: html.style.scrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    };
    html.style.overflow = 'hidden';
    html.style.scrollBehavior = 'auto';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = `${lockedWidth}px`;
    body.style.overflow = 'hidden';

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
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
      // Un-fixing the body can clamp the offset for a frame; re-assert it.
      window.requestAnimationFrame?.(() => window.scrollTo(0, scrollY));
      html.style.scrollBehavior = previous.htmlScrollBehavior;
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
            className="cart-drawer"
            style={{ 
              position: 'fixed', 
              right: 0, 
              top: 0, 
              bottom: 0, 
              width: '100%',        // 🎯 أول تعديل: يأخذ 100% من عرض الشاشة على الموبايل عشان ما يخرجش برة
              maxWidth: 420,        // 🎯 ثاني تعديل: يثبت عند 420px كحد أقصى على الشاشات الكبيرة (الكمبيوتر)
              zIndex: 2001, 
              display: 'flex', 
              flexDirection: 'column' 
            }}
          >
            {/* Header */}
            <div className="cart-drawer-head">
              <div className="cart-drawer-heading">
                <span className="cart-drawer-head-icon" aria-hidden="true">
                  <ShoppingBag size={19} />
                </span>
                <span className="cart-drawer-title">Shopping Bag</span>
                <span className="cart-drawer-count">
                  {cart.reduce((s, i) => s + (i.qty ?? 0), 0)}
                </span>
              </div>
              <button
                onClick={() => setCartOpen(false)}
                aria-label="Close shopping bag"
                className="cart-drawer-close"
                style={{ width: 44, height: 44 }}
              >
                <X size={19} aria-hidden="true" />
              </button>
            </div>

            {/* Items */}
            <div className="cart-drawer-body">
              {cart.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                  className="cart-drawer-empty"
                >
                  <span className="cart-drawer-empty-icon" aria-hidden="true">
                    <ShoppingBag size={30} />
                  </span>
                  <p className="cart-drawer-empty-title">Your bag is empty</p>
                  <p className="cart-drawer-empty-copy">Add some luxury pieces to get started</p>
                  <button className="gold-btn cart-drawer-empty-cta" onClick={() => { setCartOpen(false); setPage('shop'); }}>
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
                      className="cart-drawer-item"
                    >
                      <div className="cart-drawer-thumb">
                        <SafeImage src={item.product?.images && item.product.images[0]} fallback={FALLBACK_IMG} alt={item.product?.name || 'Product'}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      </div>

                      {/* تفاصيل المنتج مع حماية المساحة المتاحة */}
                      <div className="cart-drawer-info">
                        <div className="cart-drawer-info-top">
                          <p className="cart-drawer-name">{item.product?.name || 'Product'}</p>
                          <p className="cart-drawer-meta">Size: {item.size} · Color: {item.color}</p>
                          <p className="cart-drawer-price">
                            EGP {(effectivePrice(item.product) * (item.qty ?? 0)).toLocaleString()}
                          </p>
                        </div>

                        {/* 🎯 السطر السفلي: توزيع ذكي يمنع التقاطع نهائياً */}
                        <div className="cart-drawer-controls">

                          {/* كاونتر الكمية */}
                          <div className="cart-drawer-qty">
                            <button onClick={() => item.qty > 1 ? changeQty(item, item.qty - 1) : removeFromCart(item.key)}
                              type="button" aria-label={`Decrease quantity of ${item.product?.name || 'item'}`}
                              className="cart-drawer-qty-btn" style={{ width: 44, height: 44 }}>
                              <Minus size={13} aria-hidden="true" />
                            </button>
                            <span className="cart-drawer-qty-value">{item.qty}</span>
                            <button onClick={() => changeQty(item, item.qty + 1)}
                              type="button" aria-label={`Increase quantity of ${item.product?.name || 'item'}`}
                              className="cart-drawer-qty-btn" style={{ width: 44, height: 44 }}>
                              <Plus size={13} aria-hidden="true" />
                            </button>
                          </div>

                          {/* زر الحذف مستقل وفي أقصى اليمين */}
                          <button onClick={() => removeFromCart(item.key)}
                            type="button" aria-label={`Remove ${item.product?.name || 'item'} from bag`}
                            className="cart-drawer-remove" style={{ width: 44, height: 44 }}>
                            <Trash2 size={15} aria-hidden="true" />
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
              <div className="cart-drawer-foot">
                {appliedDiscount && (
                  <div className="cart-drawer-discount">
                    <span>🎉 {appliedDiscount.code} applied</span>
                    <button onClick={removeAppliedDiscount}>Remove</button>
                  </div>
                )}
                <div className="cart-drawer-total">
                  <span className="cart-drawer-total-label">Total</span>
                  <span className="cart-drawer-total-value">EGP {total.toLocaleString()}</span>
                </div>
                <button className="gold-btn cart-drawer-checkout"
                  onClick={() => { setCartOpen(false); setPage('checkout'); }}>
                  Proceed to Checkout
                </button>
                <button className="outline-btn cart-drawer-view"
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