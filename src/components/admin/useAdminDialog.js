import { useEffect, useId, useRef } from 'react';

// One focus-trap/labelling/scroll-lock contract for every admin overlay.
// Kept as a hook (rather than a fixed-markup modal) because the console uses
// different surfaces — centred dialogs, right-hand drawers and the product
// editor — while all of them need identical keyboard behaviour.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useAdminDialog({ open = true, onClose, disabled = false, initialFocusRef } = {}) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const root = dialogRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusable = () => Array.from(root ? root.querySelectorAll(FOCUSABLE_SELECTOR) : [])
      .filter((node) => node.getAttribute('aria-hidden') !== 'true' && !node.closest('[hidden]'));

    const firstTarget = (initialFocusRef && initialFocusRef.current) || focusable()[0] || root;
    if (firstTarget && typeof firstTarget.focus === 'function') {
      if (firstTarget === root && !firstTarget.getAttribute('tabindex')) firstTarget.setAttribute('tabindex', '-1');
      firstTarget.focus();
    }

    const onKeyDown = (event) => {
      // Nested dialogs stack: only the one holding focus may consume keys.
      if (!root || !root.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!disabledRef.current && typeof closeRef.current === 'function') closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [open, initialFocusRef]);

  return {
    dialogRef,
    titleId,
    dialogProps: { ref: dialogRef, role: 'dialog', 'aria-modal': 'true' },
    titleProps: { id: titleId },
  };
}

export default useAdminDialog;
