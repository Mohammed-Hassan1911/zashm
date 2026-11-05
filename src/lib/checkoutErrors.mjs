// Checkout validation → user-facing error notice.
//
// The inline per-field errors stay the source of truth; this module turns the
// same `errors` object into ONE short notice that names the first wrong field
// and lists any other fields that also need attention. Keeping it pure makes
// the wording and the field order testable without rendering React.
//
// Order matters: it must match the visual order of the checkout form, so the
// shopper is always pointed at the first field on the page.
export const CHECKOUT_FIELDS = [
  { key: 'name', label: 'Full Name', id: 'checkout-name' },
  { key: 'phone', label: 'Phone Number', id: 'checkout-phone' },
  { key: 'phoneAlt', label: 'Alternative Phone', id: 'checkout-phone-alt' },
  { key: 'email', label: 'Email Address', id: 'checkout-email' },
  { key: 'address', label: 'Street Address', id: 'checkout-address' },
  { key: 'city', label: 'Governorate', id: 'checkout-governorate' },
];

/**
 * Build the notice for a failed Place Order attempt.
 *
 * @param {Record<string, string>} errors field key → validation message
 * @returns {{ message: string, field: string, label: string, id: string, alsoCheck: string[] } | null}
 *   null when the form has no errors, so callers never show an empty toast.
 */
export function buildCheckoutErrorNotice(errors) {
  const invalid = CHECKOUT_FIELDS.filter((field) => {
    const message = errors && errors[field.key];
    return typeof message === 'string' && message.trim() !== '';
  });
  if (invalid.length === 0) return null;

  const [first, ...rest] = invalid;
  const lines = [`${first.label}: ${errors[first.key].trim()}`];
  if (rest.length > 0) {
    lines.push(`Also check: ${rest.map((field) => field.label).join(', ')}.`);
  }

  return {
    message: lines.join('\n'),
    field: first.key,
    label: first.label,
    id: first.id,
    alsoCheck: rest.map((field) => field.label),
  };
}

/**
 * Move the shopper to the field the notice names. Focus is what makes the
 * inline message reachable for keyboard and screen-reader users; the scroll is
 * skipped when the browser prefers reduced motion.
 */
export function focusCheckoutField(id, doc = typeof document === 'undefined' ? null : document) {
  if (!doc || !id) return false;
  const el = doc.getElementById(id);
  if (!el) return false;
  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  try {
    el.focus({ preventScroll: true });
  } catch (e) {
    el.focus();
  }
  return true;
}
