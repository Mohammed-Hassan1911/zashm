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

  // The plate is a single element positioned over the live item boxes. While a
  // finger is on the dock it follows that finger, and it settles on the item
  // the finger left it closest to.
  const innerRef = React.useRef(null);
  const itemRefs = React.useRef([]);
  const dragRef = React.useRef(null);
  const previewIndexRef = React.useRef(-1);
  const suppressClickRef = React.useRef(false);
  const currentPageRef = React.useRef(currentPage);
  const [plate, setPlate] = React.useState({ x: 0, width: 0 });
  const [dragging, setDragging] = React.useState(false);
  const [previewIndex, setPreviewIndex] = React.useState(-1);

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
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  currentPageRef.current = currentPage;

  const activeIndex = items.findIndex((item) => item.page && item.page === currentPage);
  // With no matching route (the cart page, for example) the plate rests on the
  // first item but stays hidden until it is needed.
  const plateIndex = activeIndex >= 0 ? activeIndex : 0;

  const measurePlate = React.useCallback(() => {
    const inner = innerRef.current;
    const node = itemRefs.current[plateIndex];
    if (!inner || !node) return;
    const innerRect = inner.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    // The plate is absolutely positioned in the padding box, so the border is
    // subtracted from the item's offset.
    const x = nodeRect.left - innerRect.left - inner.clientLeft;
    const width = nodeRect.width;
    setPlate((prev) => (
      Math.abs(prev.x - x) < 0.5 && Math.abs(prev.width - width) < 0.5
        ? prev
        : { x, width }
    ));
  }, [plateIndex]);

  React.useLayoutEffect(() => {
    measurePlate();
  }, [measurePlate, dragging, cartCount, wishlist.length]);

  React.useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measurePlate());
    observer.observe(inner);
    return () => observer.disconnect();
  }, [measurePlate]);

  // Pointer listeners live for the whole session and no-op unless a drag is in
  // flight, so the handlers never go stale between renders. The item geometry
  // is read once, on pointerdown: a move then does arithmetic only, and the
  // state it causes is batched into a single animation frame, so a fast swipe
  // cannot queue one React render per pointer event.
  React.useEffect(() => {
    const stopFrame = (drag) => {
      if (!drag.frame) return;
      window.cancelAnimationFrame(drag.frame);
      drag.frame = 0;
    };

    const handleMove = (event) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      if (!drag.moved) {
        // A few pixels of jitter during a tap must not move the plate.
        if (Math.abs(dx) < 8) return;
        drag.moved = true;
      }

      const nextX = Math.min(Math.max(drag.startLeft + dx, drag.minX), drag.maxX);

      let nearest = 0;
      let nearestDistance = Infinity;
      for (let index = 0; index < drag.offsets.length; index += 1) {
        const distance = Math.abs(drag.offsets[index] - nextX);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = index;
        }
      }

      drag.pendingX = nextX;
      drag.pendingIndex = nearest;
      if (drag.frame) return;
      drag.frame = window.requestAnimationFrame(() => {
        drag.frame = 0;
        if (drag.pendingIndex !== previewIndexRef.current) {
          previewIndexRef.current = drag.pendingIndex;
          setPreviewIndex(drag.pendingIndex);
        }
        const x = drag.pendingX;
        setPlate((prev) => (Math.abs(prev.x - x) < 0.5 ? prev : { x, width: prev.width }));
      });
    };

    const handleUp = (event) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      stopFrame(drag);
      // A frame may still have been waiting; its choice is the finger's last.
      if (drag.moved && drag.pendingIndex >= 0) previewIndexRef.current = drag.pendingIndex;
      dragRef.current = null;
      setDragging(false);

      const targetIndex = previewIndexRef.current;
      previewIndexRef.current = -1;
      setPreviewIndex(-1);

      if (!drag.moved) return;

      // The swipe already chose the item, so the click that follows the
      // pointerup must not navigate a second time.
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 400);

      const target = itemsRef.current[targetIndex];
      if (!target) return;
      if (target.action) target.action();
      else if (target.page && target.page !== currentPageRef.current) setPage(target.page);
    };

    const handleCancel = (event) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      stopFrame(drag);
      dragRef.current = null;
      previewIndexRef.current = -1;
      setPreviewIndex(-1);
      setDragging(false);
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [setPage]);

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const inner = innerRef.current;
    if (!inner) return;

    // One geometry read for the whole gesture, not one per pointermove.
    const originX = inner.getBoundingClientRect().left + inner.clientLeft;
    const nodes = itemRefs.current;
    const offsets = [];
    let minX = null;
    let maxX = null;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      const left = node.getBoundingClientRect().left - originX;
      offsets[index] = left;
      if (minX === null) minX = left;
      maxX = left;
    }
    if (minX === null) return;

    const startNode = nodes[plateIndex];
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeft: startNode ? startNode.getBoundingClientRect().left - originX : plate.x,
      minX,
      maxX,
      offsets,
      moved: false,
      pendingX: 0,
      pendingIndex: -1,
      frame: 0,
    };
    setDragging(true);
  };

  const handleClickCapture = (event) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <motion.nav
      initial={{ y: 70, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: 0.3, type: 'spring', stiffness: 210, damping: 26, mass: 1 }}
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
      <div
        className="mobile-nav-inner"
        ref={innerRef}
        onPointerDown={handlePointerDown}
        onClickCapture={handleClickCapture}
      >
        {/* One plate for the whole dock: it slides under the current route and
            follows a finger that swipes across the items. */}
        {plate.width > 0 && (activeIndex >= 0 || dragging) && (
          <motion.span
            className="mobile-nav-plate"
            aria-hidden="true"
            initial={false}
            animate={{ x: plate.x, width: plate.width }}
            transition={dragging
              ? { duration: 0 }
              : { type: 'spring', stiffness: 430, damping: 34, mass: 0.7 }}
          />
        )}
        {items.map(({ icon: Icon, label, page, action, badge }, index) => {
          const current = index === activeIndex;
          const highlighted = dragging ? index === previewIndex : current;
          return (
            <motion.button
              key={label}
              ref={(node) => { itemRefs.current[index] = node; }}
              type="button"
              onClick={action || (() => setPage(page))}
              aria-label={badge > 0 ? `${label}, ${badge} item${badge === 1 ? '' : 's'}` : label}
              aria-current={current ? 'page' : undefined}
              className={`mobile-nav-item${highlighted ? ' is-active' : ''}`}
              whileTap={{ scale: 0.94 }}
              transition={{ type: 'spring', stiffness: 520, damping: 32 }}
            >
              <span className="mobile-nav-icon">
                <Icon size={17} aria-hidden="true" />
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
