import React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Home, Grid, Heart, ShoppingBag } from 'lucide-react';
import { useStore } from '../../store';

export default function MobileNav() {
  const { setPage, currentPage, cart, wishlist, setCartOpen } = useStore();
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);
  const editableFocusedRef = React.useRef(false);
  const viewportBaselineRef = React.useRef(null);
  const viewportShrunkRef = React.useRef(false);
  const safeCart = cart || [];
  const cartCount = safeCart.reduce((s, i) => s + i.qty, 0);

  React.useEffect(() => {
    const visualViewport = window.visualViewport;
    const getViewportHeight = () => visualViewport?.height ?? window.innerHeight;
    viewportBaselineRef.current = getViewportHeight();

    const isEditable = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.isContentEditable) return true;
      if (element.matches('textarea, select')) return !element.disabled;
      return element.matches('input') && !element.disabled && !element.readOnly &&
        !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(element.type);
    };

    const handleFocusIn = (event) => {
      if (!isEditable(event.target)) return;
      editableFocusedRef.current = true;
      setKeyboardOpen(true);
    };

    const handleFocusOut = () => {
      Promise.resolve().then(() => {
        editableFocusedRef.current = isEditable(document.activeElement);
        if (editableFocusedRef.current) {
          setKeyboardOpen(true);
        } else if (!viewportShrunkRef.current) {
          setKeyboardOpen(false);
        }
      });
    };

    const handleViewportResize = () => {
      const height = getViewportHeight();
      if (!editableFocusedRef.current) {
        viewportShrunkRef.current = false;
        viewportBaselineRef.current = height;
        setKeyboardOpen(false);
        return;
      }

      const baseline = viewportBaselineRef.current ?? height;
      if (height < baseline - 120) {
        viewportShrunkRef.current = true;
        setKeyboardOpen(true);
        const activeElement = document.activeElement;
        if (isEditable(activeElement)) {
          window.requestAnimationFrame(() => {
            const viewportTop = visualViewport?.offsetTop ?? 0;
            const viewportBottom = viewportTop + getViewportHeight();
            const activeRect = activeElement.getBoundingClientRect();
            if (activeRect.top < viewportTop || activeRect.bottom > viewportBottom) {
              activeElement.scrollIntoView({ block: 'nearest' });
            }
          });
        }
        return;
      }

      viewportShrunkRef.current = false;
      setKeyboardOpen(false);
      if (!editableFocusedRef.current) viewportBaselineRef.current = height;
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    visualViewport?.addEventListener('resize', handleViewportResize);
    window.addEventListener('resize', handleViewportResize);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      visualViewport?.removeEventListener('resize', handleViewportResize);
      window.removeEventListener('resize', handleViewportResize);
    };
  }, []);

  const items = [
    { icon: Home, label: 'Home', page: 'home' },
    { icon: Grid, label: 'Shop', page: 'shop' },
    { icon: Heart, label: 'Wishlist', page: 'wishlist', badge: wishlist.length },
    { icon: ShoppingBag, label: 'Bag', action: () => setCartOpen(true), badge: cartCount },
  ];

  return createPortal(
    <motion.nav
      initial={{ y: 80 }}
      animate={{ y: 0 }}
      transition={{ delay: 0.5, type: 'spring', stiffness: 200 }}
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
        background: 'rgba(17,17,17,0.96)', backdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--border)',
        width: '100%',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        padding: '8px max(0px, env(safe-area-inset-right, 0px)) max(8px, env(safe-area-inset-bottom, 0px)) max(0px, env(safe-area-inset-left, 0px))',
      }}
      className={keyboardOpen ? 'mobile-nav mobile-nav--keyboard-open' : 'mobile-nav'}
    >
      <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
        {items.map(({ icon: Icon, label, page, action, badge }) => {
          const active = currentPage === page;
          return (
            <motion.button
              key={label}
              onClick={action || (() => setPage(page))}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 16px', background: 'none', border: 'none', cursor: 'pointer', position: 'relative', color: active ? 'var(--gold)' : 'var(--text3)' }}
              whileTap={{ scale: 0.9 }}
            >
              <div style={{ position: 'relative' }}>
                <Icon size={20} />
                {badge > 0 && (
                  <span style={{ position: 'absolute', top: -6, right: -6, width: 15, height: 15, borderRadius: '50%', background: 'var(--gold)', color: 'var(--bg)', fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{badge}</span>
                )}
              </div>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
              {active && (
                <motion.div layoutId="mobile-nav-indicator"
                  style={{ position: 'absolute', bottom: -8, width: 4, height: 4, borderRadius: '50%', background: 'var(--gold)' }} />
              )}
            </motion.button>
          );
        })}
      </div>
    </motion.nav>,
    document.body
  );
}
