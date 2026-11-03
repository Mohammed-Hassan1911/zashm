// Focus utilities for modal surfaces (cart drawer and future dialogs).
//
// Kept DOM-only and dependency-free so the tab-cycle behaviour can be tested
// with jsdom without rendering React. The drawer owns scroll locking and focus
// restoration; this module answers "what is tabbable", "where should Tab land"
// and "should a stray focus be pulled back inside".

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// True when the element is rendered and can actually receive keyboard focus.
// The important part is walking ancestors: `display: none`, `visibility:
// hidden`, `inert` and a disabled fieldset on a parent all remove descendants
// from the tab order, but the descendant's own computed style still looks
// normal. Missing that made the old boundary check treat an invisible control
// as the last stop, so Tab from the real last control fell out of the dialog.
function isVisible(element) {
  if (!element || element.nodeType !== 1) return false;
  if (element.hasAttribute('hidden')) return false;

  const view = element.ownerDocument && element.ownerDocument.defaultView;
  const getStyle = view && typeof view.getComputedStyle === 'function'
    ? (node) => {
      try {
        return view.getComputedStyle(node);
      } catch {
        return null;
      }
    }
    : null;

  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute('hidden') || node.hasAttribute('inert')) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    if (node.tagName === 'FIELDSET' && node.hasAttribute('disabled')) return false;

    if (getStyle) {
      const style = getStyle(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    }
  }
  return true;
}

function tabIndexOf(element) {
  const raw = element.getAttribute('tabindex');
  if (raw === null || raw === '') return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

// Document order, except that positive tabindex values come first (ascending),
// which is how browsers build their sequential focus order.
function compareFocusOrder(a, b) {
  const aIndex = tabIndexOf(a);
  const bIndex = tabIndexOf(b);
  const aPositive = aIndex > 0;
  const bPositive = bIndex > 0;
  if (aPositive && bPositive && aIndex !== bIndex) return aIndex - bIndex;
  if (aPositive !== bPositive) return aPositive ? -1 : 1;
  if (a === b) return 0;
  const position = a.compareDocumentPosition(b);
  if (position & 4) return -1; // b follows a
  if (position & 2) return 1; // b precedes a
  return 0;
}

export function getFocusableElements(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => tabIndexOf(element) >= 0 && isVisible(element))
    .sort(compareFocusOrder);
}

// Focus the first focusable descendant, or the container itself when the
// surface has no controls (the container must be tabindex="-1").
export function focusFirstElement(container) {
  if (!container) return false;
  const [first] = getFocusableElements(container);
  return focusElement(first || container);
}

function focusElement(element) {
  if (!element || typeof element.focus !== 'function') return false;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
  return true;
}

function firstAfter(items, element) {
  return items.find((item) => {
    const position = element.compareDocumentPosition(item);
    return item !== element && (position & 4) === 4; // item follows element
  }) || null;
}

function lastBefore(items, element) {
  return [...items].reverse().find((item) => {
    const position = element.compareDocumentPosition(item);
    return item !== element && (position & 2) === 2; // item precedes element
  }) || null;
}

// Cycle focus inside `container` for a Tab / Shift+Tab keydown. Returns true
// when the event was handled (and prevented) so callers can stop there.
//
// Middle elements are left to the browser so the natural order survives; only
// the edges (and elements that are not part of the tabbable list, such as the
// container itself) are intercepted.
export function trapTabKey(event, container) {
  if (!event || event.key !== 'Tab' || !container) return false;

  const doc = container.ownerDocument || (typeof document === 'undefined' ? null : document);
  const active = doc ? doc.activeElement : null;
  const items = getFocusableElements(container);

  if (items.length === 0) {
    event.preventDefault();
    focusElement(container);
    return true;
  }

  const inside = !!active && typeof container.contains === 'function' && container.contains(active);
  const index = active ? items.indexOf(active) : -1;

  if (event.shiftKey) {
    if (index > 0) return false; // natural backwards step
    event.preventDefault();
    if (index === 0) {
      items[items.length - 1].focus();
      return true;
    }
    // Focus outside the dialog, on the container, or on a filtered node.
    const previous = inside && active ? lastBefore(items, active) : null;
    (previous || items[items.length - 1]).focus();
    return true;
  }

  if (index > -1 && index < items.length - 1) return false; // natural forwards step
  event.preventDefault();
  if (index === items.length - 1) {
    items[0].focus();
    return true;
  }
  const next = inside && active ? firstAfter(items, active) : null;
  (next || items[0]).focus();
  return true;
}

// Safety net for focus that lands outside the dialog without a Tab keydown
// (programmatic focus, a control removed while focused, assistive tech). Keeps
// the dialog modal no matter how focus moved. Returns true when it redirected.
export function redirectOutsideFocus(event, container) {
  if (!event || !container) return false;
  const target = event.target;
  if (!target || target.nodeType !== 1) return false;
  if (typeof container.contains === 'function' && container.contains(target)) return false;
  return focusFirstElement(container);
}
