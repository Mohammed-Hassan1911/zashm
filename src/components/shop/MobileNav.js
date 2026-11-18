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
        const keyboardWasClosed = !viewportShrunkRef.current;
        viewportShrunkRef.current = true;
        setKeyboardOpen(true);
        const activeElement = document.activeElement;
        if (keyboardWasClosed && isEditable(activeElement)) {
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

  React.useEffect(() => {
    document.body.classList.toggle('mobile-keyboard-open', keyboardOpen);
    return () => document.body.classList.remove('mobile-keyboard-open');
  }, [keyboardOpen]);

  const items = [
    { icon: Home, label: 'Home', page: 'home' },
    { icon: Grid, label: 'Shop', page: 'shop' },
    { icon: Heart, label: 'Wishlist', page: 'wishlist', badge: wishlist.length },
    { icon: ShoppingBag, label: 'Bag', action: () => setCartOpen(true), badge: cartCount },
  ];

  return createPortal(
    <motion.nav
      initial={{ y: 90, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 0.35, type: 'spring', stiffness: 190, damping: 24, mass: 1.05 }}
      whileTap={{ scale: 0.985, transition: { type: 'spring', stiffness: 520, damping: 32 } }}
      className={`mobile-nav${keyboardOpen ? ' mobile-nav--keyboard-open' : ''}`}
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
        width: '100%',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        // The wrapper spans the viewport but paints nothing; the glass capsule
        // inside is centred and narrower. Horizontal padding keeps it clear of
        // the screen edges, and the bottom padding lifts it off the safe area.
        padding:
          '0 max(14px, calc(env(safe-area-inset-right, 0px) + 14px)) calc(10px + env(safe-area-inset-bottom, 0px)) max(14px, calc(env(safe-area-inset-left, 0px) + 14px))',
      }}
    >
      <div className="mobile-nav-inner">
        {items.map(({ icon: Icon, label, page, action, badge }) => {
          const active = currentPage === page;
          return (
            <motion.button
              key={label}
              type="button"
              onClick={action || (() => setPage(page))}
              aria-label={badge > 0 ? `${label}, ${badge} item${badge === 1 ? '' : 's'}` : label}
              aria-current={active ? 'page' : undefined}
              className={`mobile-nav-item${active ? ' is-active' : ''}`}
              whileTap={{ scale: 0.9, y: 1 }}
              transition={{ type: 'spring', stiffness: 520, damping: 30 }}
            >
              {/* One gold-tinted plate is shared between the four items, so it
                  glides to the current route instead of blinking on and off. */}
              {active && (
                <motion.span
                  layoutId="mobile-nav-plate"
                  className="mobile-nav-plate"
                  aria-hidden="true"
                  transition={{ type: 'spring', stiffness: 470, damping: 34, mass: 0.85 }}
                />
              )}
              <span className="mobile-nav-icon">
                <Icon size={20} aria-hidden="true" />
                {badge > 0 && (
                  <span className="mobile-nav-badge" aria-hidden="true">{badge}</span>
                )}
              </span>
              <span className="mobile-nav-label">{label}</span>
            </motion.button>
          );
        })}
      </div>
    </motion.nav>,
    document.body
  );
}
