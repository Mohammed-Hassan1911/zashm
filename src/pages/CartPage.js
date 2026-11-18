import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, ShoppingBag, Heart, Plus, Minus, Tag, Check, AlertCircle, CheckCircle, Truck, Banknote, CreditCard, PackageSearch, Headset, ArrowLeft } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import StockFeedback from '../components/shop/StockFeedback';
import SafeImage from '../components/ui/SafeImage';
import { cartWhatsAppMessage, isOutageError, whatsappUrl } from '../lib/resilience';
import { sanitizeInput, setPageMeta, normalizeEgyptPhone } from '../lib/security';
import { filterGovernorates, getShippingCost, toCanonicalGovernorate } from '../lib/egyptCities';
import { clearCheckoutIdempotencyKey, getCheckoutIdempotencyKey } from '../lib/orderIdempotency.mjs';
import { buildCheckoutErrorNotice, focusCheckoutField } from '../lib/checkoutErrors.mjs';
import { effectivePrice } from '../lib/pricing';
import { clearOrderConfirmation, readOrderConfirmation, saveOrderConfirmation } from '../lib/orderConfirmation.mjs';

// يطابق المحافظة المكتوبة (عربي/إنجليزي، بأي حالة أحرف) مع القائمة الرسمية،
// ويعيد '' لو مفيش تطابق — يمنع إرسال مدينة حرة يرفضها السيرفر.
function normalizeGovernorate(value) {
  return toCanonicalGovernorate(value);
}
import { toast } from '../components/ui/BackToTop';

// Warm the coupon endpoint as soon as the shopper touches the discount field.
// A cold serverless start is the slowest part of the first apply; this OPTIONS
// probe short-circuits before the handler's rate limit and has no side effects.
// At most one probe per minute so repeated focus/blur cannot spam the API.
let couponWarmupAt = 0;
function warmCouponEndpoint() {
  const now = Date.now();
  if (now - couponWarmupAt < 60000) return;
  couponWarmupAt = now;
  try {
    fetch('/api/coupons/validate', {
      method: 'OPTIONS',
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => {});
  } catch (e) {
    /* warm-up is best effort */
  }
}

function CityAutocomplete({ value, onChange, onSelect, error, id = 'governorate', describedBy }) {
  const [open, setOpen] = React.useState(false);
  const [dropUp, setDropUp] = React.useState(false);
  const wrapRef = React.useRef(null);
  const suggestions = React.useMemo(() => filterGovernorates(value), [value]);

  const openList = React.useCallback(() => {
    const el = wrapRef.current;
    if (el && typeof window !== 'undefined') {
      const rect = el.getBoundingClientRect();
      // Open upward when the list would not fit below the fold, so the
      // suggestions are reachable without the browser scrolling the page.
      setDropUp(window.innerHeight - rect.bottom < 200 && rect.top > 200);
    }
    setOpen(true);
  }, []);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        id={id}
        value={value ?? ''}
        onChange={e => { onChange(e.target.value); openList(); }}
        onFocus={openList}
        onPointerDown={(e) => {
          // Mouse: stop the browser's click-to-focus scroll and the native
          // address-autofill popup, then focus without scrolling. Touch keeps
          // the default behaviour so the on-screen keyboard still opens.
          if (e.pointerType !== 'mouse') return;
          e.preventDefault();
          if (typeof e.currentTarget.focus === 'function') {
            e.currentTarget.focus({ preventScroll: true });
          }
          openList();
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={'Cairo'}
        style={{ width: '100%', borderColor: error ? 'var(--red)' : undefined }}
        autoComplete="off"
        aria-autocomplete="list"
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', [dropUp ? 'bottom' : 'top']: '100%', left: 0, right: 0,
          marginTop: dropUp ? 0 : 4, marginBottom: dropUp ? 4 : 0, zIndex: 50,
          background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045) 0%, rgba(255, 255, 255, 0.012) 100%), rgba(18, 17, 15, 0.92)', border: '1px solid rgba(255, 255, 255, 0.12)', borderRadius: 8,
          maxHeight: 180, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}>
          {suggestions.map(city => (
            <button
              key={city}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={(e) => { e.preventDefault(); onSelect(city); setOpen(false); }}
              tabIndex={-1}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 13,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {city}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Summary of the proactive check, shown on the bag and on the checkout form
// before the shopper presses the button. Blocking lines must be removed;
// warnings only say the quantity is above what is left.
//
// `detailed` is false on the bag page, where every problem already names itself
// on its own line (LineStockIssue) — the banner then counts the pieces instead of
// repeating the same sentence twice. The checkout form has no per-line strips, so
// it keeps the full messages.
function LiveStockBanner({ issues, detailed = true }) {
  const blocking = issues.filter(i => i.blocking);
  const warnings = issues.filter(i => !i.blocking);
  if (blocking.length === 0 && warnings.length === 0) return null;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return (
    <div style={{ marginBottom: 20 }}>
      {blocking.length > 0 && (
        blocking.length === 1 ? (
          <div role="alert" aria-live="assertive"
            style={{ border: '1px solid var(--red)', borderRadius: 6, padding: '12px 16px', background: 'rgba(192,57,43,0.07)' }}>
            <p style={{ color: 'var(--red)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
              {blocking[0].message} Remove it to continue — nothing was taken out of your bag automatically.
            </p>
          </div>
        ) : (
          <div role="alert" aria-live="assertive"
            style={{ border: '1px solid var(--red)', borderRadius: 6, padding: '12px 16px', background: 'rgba(192,57,43,0.07)' }}>
            <p style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              {blocking.length} pieces in your bag can’t be ordered right now.
            </p>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {blocking.map(i => (
                <li key={i.key} style={{ color: 'var(--red)', fontSize: 11, lineHeight: 1.6 }}>{i.message}</li>
              ))}
            </ul>
            <p style={{ color: 'var(--text2)', fontSize: 12, margin: '8px 0 0' }}>
              Remove the marked piece(s) to continue — nothing was taken out of your bag automatically.
            </p>
          </div>
        )
      )}
      {warnings.length > 0 && (
        <div role="status" aria-live="polite" style={{ marginTop: blocking.length ? 10 : 0,
          border: '1px solid #f39c12', borderRadius: 6, padding: '10px 16px', background: 'rgba(243,156,18,0.07)' }}>
          {detailed ? (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {warnings.map(i => (
                <li key={i.key} style={{ color: '#f39c12', fontSize: 11, lineHeight: 1.6 }}>{i.message}</li>
              ))}
            </ul>
          ) : (
            <p style={{ color: '#f39c12', fontSize: 11, margin: 0, lineHeight: 1.6 }}>
              {count(warnings.length, 'piece is', 'pieces are')} above the quantity left in stock — see the marks below.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// One bag line that the live catalogue says cannot be ordered (blocking) or is
// over the available quantity (warning). The shopper decides: the only action
// offered is Remove — nothing is deleted from the bag automatically.
function LineStockIssue({ issue, onRemove }) {
  if (!issue) return null;
  const blocking = issue.blocking;
  const color = blocking ? 'var(--red)' : '#f39c12';
  return (
    <div
      role={blocking ? 'alert' : 'status'}
      style={{
        display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center',
        justifyContent: 'space-between', marginTop: 10, padding: '8px 12px',
        border: `1px solid ${color}`, borderRadius: 4,
        background: blocking ? 'rgba(192,57,43,0.08)' : 'rgba(243,156,18,0.08)',
      }}
    >
      <span style={{ color, fontSize: 11, lineHeight: 1.5, flex: '1 1 220px' }}>{issue.message}</span>
      {blocking && (
        <button
          type="button"
          onClick={onRemove}
          style={{
            background: 'none', border: `1px solid ${color}`, color, borderRadius: 3,
            padding: '5px 12px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ─── CART PAGE ────────────────────────────────────────────────────────────────
export function CartPage() {
  const { cart, removeFromCart, updateCartQty, cartTotal, cartSubtotal, cartDiscountAmount, setPage, appliedDiscount, applyDiscount, removeAppliedDiscount, cartLineIssues } = useStore();
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [couponApplying, setCouponApplying] = useState(false);
  const total = cartTotal() ?? 0;
  const subtotal = cartSubtotal() ?? 0;
  const discountAmount = cartDiscountAmount() ?? 0;
  const safeCart = cart ?? [];

  // Checked against the live catalogue on every render — nothing here mutates the
  // bag: an unavailable line is shown with its own Remove control.
  const lineIssues = cartLineIssues();
  const issueByKey = new Map(lineIssues.map(i => [i.key, i]));

  const changeQty = (item, nextQty) => {
    const result = updateCartQty(item?.key, nextQty);
    if (result && result.success === false) {
      toast(result.error || 'Maximum available quantity reached.', 'warning');
    }
  };

  React.useEffect(() => { setPageMeta({ title: 'Shopping Bag', description: 'Review your selected luxury pieces', robots: 'noindex, nofollow' }); }, []);
  // Warm the coupon function while the shopper is still reading the bag, so the
  // first Apply is not paying for a cold serverless start. Throttled to once a
  // minute by warmCouponEndpoint().
  React.useEffect(() => { if (safeCart.length) warmCouponEndpoint(); }, []);

  const handleApplyCoupon = async () => {
    if (couponApplying) return;
    setCouponError('');
    const cleanCoupon = (coupon ?? '').trim().toUpperCase();
    if (!cleanCoupon) {
      setCouponError('Please enter a discount code.');
      return;
    }

    setCouponApplying(true);
    try {
      const result = await applyDiscount(cleanCoupon);
      if (result.success) {
        toast(`Code ${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% off' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!`, 'success');
      } else {
        setCouponError(result.error ?? 'Invalid code');
      }
    } finally {
      setCouponApplying(false);
    }
  };

  const bagCount = safeCart.reduce((sum, item) => sum + (item?.qty || 0), 0);

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }} className="cart-page">
      <div className="bag-shell">
        <motion.header
          className="bag-head"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="bag-eyebrow">{'Your selection'}</p>
          <h1 className="bag-title">{'Shopping Bag'}</h1>
          <p className="bag-sub">
            {safeCart.length === 0
              ? 'A quiet wardrobe starts with one piece.'
              : `${bagCount} ${bagCount === 1 ? 'piece' : 'pieces'} selected`}
          </p>
        </motion.header>

        {safeCart.length === 0 ? (
          <motion.div className="bag-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="bag-empty-icon" aria-hidden="true">
              <ShoppingBag size={30} strokeWidth={1.2} />
            </span>
            <p className="bag-empty-title">{'Your bag is empty'}</p>
            <p className="bag-empty-copy">{'Explore the collection to find your next piece.'}</p>
            <button className="gold-btn" onClick={() => setPage('shop')}>{'Explore Collection'}</button>
          </motion.div>
        ) : (
          <div className="cart-grid bag-grid">
            <div className="bag-lines">
              <div className="bag-lines-head">
                <span>{'Pieces'}</span>
                <span>{bagCount} {bagCount === 1 ? 'item' : 'items'}</span>
              </div>

              <AnimatePresence initial={false}>
                {safeCart.map(item => (
                  <motion.article
                    key={item?.key}
                    layout
                    className="bag-line"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                  >
                    <div className="bag-line-media">
                      <SafeImage
                        src={item?.product?.images?.[0]}
                        fallback={'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="110" height="138"%3E%3Crect fill="%23ccc" width="110" height="138"/%3E%3C/svg%3E'}
                        alt={item?.product?.name ?? 'Product'}
                        loading="lazy"
                      />
                    </div>

                    <div className="bag-line-body">
                      <div className="bag-line-head">
                        <div className="bag-line-copy">
                          <p className="bag-line-cat">{item?.product?.category ?? 'General'}</p>
                          <p className="bag-line-name">{item?.product?.name ?? 'Unknown Product'}</p>
                          <p className="bag-line-variant">
                            <span>{'Size'} {item?.size ?? 'N/A'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{item?.color ?? 'N/A'}</span>
                          </p>
                        </div>
                        <button
                          onClick={() => removeFromCart(item?.key)}
                          type="button"
                          className="bag-remove"
                          aria-label={`Remove ${item?.product?.name || 'item'} from bag`}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>

                      <div className="bag-line-foot">
                        <div className="bag-qty">
                          <button
                            onClick={() => (item?.qty ?? 0) > 1 ? changeQty(item, (item?.qty ?? 0) - 1) : removeFromCart(item?.key)}
                            type="button"
                            aria-label={`Decrease quantity of ${item?.product?.name || 'item'}`}
                            style={{ width: 44, height: 44 }}
                          >
                            <Minus size={12} aria-hidden="true" />
                          </button>
                          <span aria-live="polite">{item?.qty ?? 0}</span>
                          <button
                            onClick={() => changeQty(item, (item?.qty ?? 0) + 1)}
                            type="button"
                            aria-label={`Increase quantity of ${item?.product?.name || 'item'}`}
                            style={{ width: 44, height: 44 }}
                          >
                            <Plus size={12} aria-hidden="true" />
                          </button>
                        </div>
                        <span className="bag-line-price">
                          EGP {(effectivePrice(item?.product) * (item?.qty ?? 0)).toLocaleString()}
                        </span>
                      </div>

                      <LineStockIssue issue={issueByKey.get(item?.key)} onRemove={() => removeFromCart(item?.key)} />
                    </div>
                  </motion.article>
                ))}
              </AnimatePresence>

              <button type="button" className="bag-continue" onClick={() => setPage('shop')}>
                <ArrowLeft size={14} aria-hidden="true" />
                {'Continue shopping'}
              </button>
            </div>

            <aside className="bag-summary" aria-label="Order summary">
              <div className="bag-summary-head">
                <h2 className="bag-summary-title">{'Order Summary'}</h2>
                <span className="bag-summary-rule" aria-hidden="true" />
              </div>

              <div className="bag-totals">
                <div className="bag-total-row">
                  <span>{'Subtotal'}</span>
                  <span>EGP {subtotal.toLocaleString()}</span>
                </div>
                <div className="bag-total-row">
                  <span>Discount{appliedDiscount ? ` (${appliedDiscount.code})` : ''}</span>
                  <span className={discountAmount > 0 ? 'is-discount' : 'is-muted'}>
                    {discountAmount > 0 ? `-EGP ${discountAmount.toLocaleString()}` : 'EGP 0'}
                  </span>
                </div>
                <div className="bag-total-row">
                  <span>{'Shipping'}</span>
                  <span className="is-muted">{'Calculated at next step'}</span>
                </div>
              </div>

              {!appliedDiscount ? (
                <div className="bag-coupon">
                  <label className="bag-coupon-label" htmlFor="bag-coupon">{'Discount code'}</label>
                  <div className="bag-coupon-row">
                    <div className="bag-coupon-field">
                      <Tag size={12} aria-hidden="true" />
                      <input
                        id="bag-coupon"
                        value={coupon}
                        onChange={e => { setCoupon(e.target.value); setCouponError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                        onFocus={warmCouponEndpoint}
                        disabled={couponApplying}
                        placeholder="Promo code"
                        style={{ borderColor: couponError ? 'var(--red)' : undefined }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleApplyCoupon}
                      disabled={couponApplying}
                      aria-busy={couponApplying}
                      className="bag-coupon-apply"
                      style={{ minWidth: 96 }}
                    >
                      {couponApplying ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {couponError && (
                    <div className="bag-coupon-error" role="alert">
                      <AlertCircle size={12} aria-hidden="true" />
                      <p>{couponError}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bag-coupon-applied">
                  <span>
                    <Check size={13} aria-hidden="true" />
                    {appliedDiscount.code}
                  </span>
                  <button type="button" onClick={removeAppliedDiscount}>{'Remove'}</button>
                </div>
              )}

              <div className="bag-grand-total">
                <span>{'Total'}</span>
                <span className="bag-grand-value">EGP {total.toLocaleString()}</span>
              </div>

              <button className="gold-btn bag-checkout-btn" onClick={() => setPage('checkout')}>
                {'Proceed to Checkout'}
              </button>
              <button className="outline-btn bag-shop-btn" onClick={() => setPage('shop')}>
                {'Continue Shopping'}
              </button>

              <div className="bag-trust">
                <span><Truck size={14} aria-hidden="true" />{'Delivery across Egypt'}</span>
                <span><Banknote size={14} aria-hidden="true" />{'Cash on delivery'}</span>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── CHECKOUT PAGE (MODIFIED FOR PRODUCTION ORDER TRACKING & TELEGRAM BOT) ──────────────────────────────
export function CheckoutPage() {
  const {
    cart, cartTotal, cartSubtotal, cartDiscountAmount, placeOrder, setPage,
    appliedDiscount, applyDiscount, removeAppliedDiscount, refreshAppliedDiscount,
    reduceCartForStockIssues,
    cartLineIssues,
  } = useStore();
  const [form, setForm] = useState({ name: '', phone: '', phoneAlt: '', email: '', address: '', city: '', notes: '' });
  const [errors, setErrors] = useState({});
  const [stockErrors, setStockErrors] = useState([]);
  const [stockNotice, setStockNotice] = useState([]);
  // True only when the order failed because the server/database was unreachable
  // (network, timeout, 5xx) — then we hand the customer to WhatsApp.
  const [orderOutage, setOrderOutage] = useState(false);
  const [success, setSuccess] = useState(() => readOrderConfirmation());
  const [submitting, setSubmitting] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [couponApplying, setCouponApplying] = useState(false);
  const [copied, setCopied] = useState(false); 

  // 🔒 الحارس الذري لمنع استدعاء الدالة مرتين بشكل متزامن في نفس الجزء من الثانية
  const isPlacingOrder = React.useRef(false);

  const subtotal = cartSubtotal() ?? 0;
  const discountAmount = cartDiscountAmount() ?? 0;
  const safeCart = cart ?? []; 

  const shippingCost = getShippingCost(form.city);
  const finalTotal = subtotal + shippingCost - discountAmount;
  // Same proactive check as the bag: the shopper sees an unorderable line before
  // filling the form, not only after pressing Place Order.
  const liveIssues = cartLineIssues();

  React.useEffect(() => { setPageMeta({ title: 'Checkout', description: 'Complete your order', robots: 'noindex, nofollow' }); }, []);
  React.useEffect(() => { refreshAppliedDiscount(); }, []);
  // Same warm-up as the bag: checkout is the likeliest place to paste a code.
  React.useEffect(() => { warmCouponEndpoint(); }, []);
  
  // 🔝 السكرول المبدئي عند فتح الصفحة لأول مرة.
  // فوري (auto) بدل الانسيابي حتى لا تبدو الشاشة وكأنها تتحرك أثناء تعبئة الفورم.
  React.useEffect(() => {
    window.scrollTo({
      top: 0,
      behavior: 'auto'
    });
  }, []);

  // 🚀 سكرول لأعلى الصفحة فوراً عند نجاح الأوردر وتحديث الـ success state
  React.useEffect(() => {
    if (success) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [success]);

  const handleApplyCoupon = async () => {
    if (couponApplying) return;
    setCouponError('');
    const cleanCoupon = (coupon ?? '').trim().toUpperCase();
    if (!cleanCoupon) {
      setCouponError('Please enter a discount code.');
      return;
    }

    setCouponApplying(true);
    try {
      const result = await applyDiscount(cleanCoupon);
      if (result.success) {
        toast(`${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% offer' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!`, 'success');
      } else {
        setCouponError(result.error ?? 'Invalid code');
      }
    } finally {
      setCouponApplying(false);
    }
  };

  const update = (k, v) => { 
    setForm(f => ({ ...f, [k]: v })); 
    setErrors(e => ({ ...e, [k]: null })); 
  };

  const validateOrderFormCustom = (fields) => {
    const errs = {};
    if (!fields.name || !fields.name.trim()) errs.name = 'Full name is required.';
    else if (fields.name.trim().length < 2) errs.name = 'Please enter your full name (at least 2 characters).';
    
    const egyptianPhoneRegex = /^01[0125][0-9]{8}$/;
    const normPhone = normalizeEgyptPhone(fields.phone);
    
    if (!fields.phone || !fields.phone.trim()) {
      errs.phone = 'Phone number is required.';
    } else if (!egyptianPhoneRegex.test(normPhone)) {
      errs.phone = 'Invalid phone number. Must be 11 digits starting with 01.';
    }

    if (fields.phoneAlt && fields.phoneAlt.trim()) {
      const trimmedPhone = normPhone;
      const trimmedPhoneAlt = normalizeEgyptPhone(fields.phoneAlt);

      if (!egyptianPhoneRegex.test(trimmedPhoneAlt)) {
        errs.phoneAlt = 'Invalid alternative phone number. Must be 11 digits.';
      } else if (trimmedPhone === trimmedPhoneAlt) {
        errs.phoneAlt = 'Alternative phone cannot be the same as the primary phone number.';
      }
    }

    if (fields.email && fields.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fields.email.trim())) {
        errs.email = 'Please enter a valid email address.';
      }
    }

    if (!fields.address || !fields.address.trim()) errs.address = 'Street address is required.';
    else if (fields.address.trim().length < 5) errs.address = 'Please enter a complete street address (at least 5 characters).';
    if (!fields.city || !fields.city.trim() || fields.city === 'Select City' || !normalizeGovernorate(fields.city)) {
      errs.city = 'Please select your governorate from the list.';
    }
    
    return errs;
  };

  const handleOrder = async () => {
    if (isPlacingOrder.current || submitting) return;
    if (safeCart.length === 0) {
      setStockErrors(['Your bag is empty. Add a piece before placing an order.']);
      return;
    }

    // Block submission when a line cannot be ordered (out of stock / bad variant).
    // The server would reject it anyway; this avoids a wasted round-trip and
    // keeps the shopper on the form with the existing banner.
    const blockingNow = (typeof cartLineIssues === 'function' ? cartLineIssues() : []).filter(i => i.blocking);
    if (blockingNow.length > 0) {
      toast('Remove the marked piece(s) before placing the order.', 'warning');
      return;
    }

    const errs = validateOrderFormCustom(form);
    if (Object.keys(errs).length > 0) {
      // The inline errors stay (they sit under the exact field), but the shopper
      // may be scrolled away from the field they need to fix. One short notice
      // names the first wrong field and its reason, lists any others, then takes
      // the shopper straight to it.
      setErrors(errs);
      const notice = buildCheckoutErrorNotice(errs);
      if (notice) {
        toast(notice.message, 'error');
        const focusField = () => focusCheckoutField(notice.id);
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(focusField);
        } else {
          focusField();
        }
      }
      return;
    }

    isPlacingOrder.current = true;
    setSubmitting(true);
    setStockErrors([]);
    setStockNotice([]);
    setOrderOutage(false);

    try {
      const idempotencyKey = getCheckoutIdempotencyKey(safeCart);
      const sanitizedCustomer = sanitizeInput(form.name.trim());
      const sanitizedPhone = normalizeEgyptPhone(form.phone);
      const sanitizedPhoneAlt = form.phoneAlt ? normalizeEgyptPhone(form.phoneAlt) : ''; 
      const sanitizedEmail = sanitizeInput(form.email.trim());
      const sanitizedAddress = sanitizeInput(form.address.trim());
      const sanitizedNotes = sanitizeInput(form.notes.trim());

      const result = await placeOrder({ 
        customer: sanitizedCustomer, 
        phone: sanitizedPhone,
        phoneAlt: sanitizedPhoneAlt, 
        email: sanitizedEmail, 
        address: sanitizedAddress, 
        city: normalizeGovernorate(form.city) || form.city, 
        shippingCost: shippingCost,
        notes: sanitizedNotes,       
        total: finalTotal
      }, idempotencyKey);

      if (!result || !result.success) {
        // Quantities the server says are too high are lowered (and announced).
        // Lines that cannot be ordered at all stay in the bag and are marked with
        // their own Remove button — the bag is never edited silently.
        let reduced = [];
        let unavailable = [];
        if (result?.stockIssues && result.stockIssues.length) {
          const outcome = reduceCartForStockIssues(result.stockIssues);
          reduced = outcome.reduced;
          unavailable = outcome.unavailable;
        }

        // The banner above and the strip on each line already name every line the
        // live catalogue rejects, in the same wording the server uses. Repeating the
        // server list under them is the duplication customers complained about, so a
        // message is only added here when the catalogue could not show it (a product
        // the list has not loaded, for instance).
        const shownIssues = cartLineIssues();
        const shownMessages = new Set(shownIssues.map(i => i.message));
        const blockingKeys = new Set(shownIssues.filter(i => i.blocking).map(i => i.key));
        const extraErrors = (result?.errors || []).filter(e => !shownMessages.has(e));
        setStockErrors(extraErrors.length > 0
          ? extraErrors
          : (shownIssues.length > 0 ? [] : ['Order failed. Please try again.']));

        const notices = [];
        reduced.forEach(r => {
          const where = (r.size || r.color) ? ` (${r.size} - ${r.color})` : '';
          notices.push(
            `The quantity of "${r.name}"${where} was lowered from ${r.from} to ${r.to} — only ${r.to} left in stock.`
          );
        });
        unavailable.filter(r => !blockingKeys.has(r.key)).forEach(r => {
          const where = (r.size || r.color) ? ` (${r.size} - ${r.color})` : '';
          notices.push(
            `"${r.name}"${where} can't be ordered right now. It stays in your bag until you remove it.`
          );
        });
        setStockNotice(notices);
        setOrderOutage(isOutageError(result?.status));
        if (notices.length) {
          toast(notices[0], 'info');
        } else if (result?.blockedLocally) {
          toast(result.error || 'Some pieces in your bag can’t be ordered right now.', 'warning');
        }

        isPlacingOrder.current = false;
        setSubmitting(false);
        return;
      }

      // 🛑 تم حذف وإلغاء كود تكرار إرسال التليجرام من هنا نهائياً
      // العملية الآن تتم بأمان من داخل الـ Store لضمان إرسال رسالة واحدة فقط!

      clearCheckoutIdempotencyKey(idempotencyKey);
      if (!saveOrderConfirmation(result.order)) {
        toast(
          'Order confirmed, but this browser could not save the confirmation for refresh. Please keep your order ID.',
          'warning'
        );
      }
      setSuccess(result.order);
      setSubmitting(false);

    } catch (error) {
      console.error("Order completion failed logic:", error);
      const raw = error && error.message ? String(error.message) : '';
      setStockErrors([raw ? raw : ('Order failed. Please try again.')]);
      setStockNotice([]);
      setOrderOutage(isOutageError(error && error.status));
      isPlacingOrder.current = false;
      setSubmitting(false);
    }
  };
  
  if (success) {
    // All three confirmation actions share one identical pill style: a calm
    // black surface with muted-gold text and a thin warm border.
    const orderActionStyle = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      flex: '1 1 150px',
      minWidth: 0,
      minHeight: 44,
      padding: '12px 12px',
      borderRadius: 50,
      border: '1px solid rgba(201,176,108,0.38)',
      background:
        'linear-gradient(135deg, #161513 0%, #1d1b17 55%, #141312 100%)',
      color: '#cbb075',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: 1.1,
      lineHeight: 1.5,
      whiteSpace: 'nowrap',
      textDecoration: 'none',
      textTransform: 'uppercase',
      cursor: 'pointer',
      boxShadow: '0 4px 14px rgba(0,0,0,0.38)',
      transition:
        'background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease, color 0.25s ease',
    };
    const orderActionHover = {
      onMouseEnter: (e) => {
        e.currentTarget.style.background =
          'linear-gradient(135deg, #201d18 0%, #272319 55%, #1d1a15 100%)';
        e.currentTarget.style.borderColor = 'rgba(201,176,108,0.66)';
        e.currentTarget.style.color = '#e0c98f';
        e.currentTarget.style.boxShadow = '0 10px 26px rgba(201,176,108,0.16)';
        e.currentTarget.style.transform = 'translateY(-2px)';
      },
      onMouseLeave: (e) => {
        e.currentTarget.style.background =
          'linear-gradient(135deg, #161513 0%, #1d1b17 55%, #141312 100%)';
        e.currentTarget.style.borderColor = 'rgba(201,176,108,0.38)';
        e.currentTarget.style.color = '#cbb075';
        e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,0.38)';
        e.currentTarget.style.transform = 'translateY(0)';
      },
      onFocus: (e) => {
        e.currentTarget.style.outline = '2px solid #cbb075';
        e.currentTarget.style.outlineOffset = '3px';
      },
      onBlur: (e) => {
        e.currentTarget.style.outline = 'none';
      },
    };
    const orderActionIcon = {
      flexShrink: 0,
      color: 'inherit',
    };

    // The invoice is dated from the stored order, never from "now": a refresh
    // of this page must not move the issue date forward.
    const placedAt = success.placedAt || success.timestamps?.created || success.date || '';
    const placedDate = (() => {
      const d = placedAt ? new Date(placedAt) : new Date();
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    })();
    const invoiceItems = Array.isArray(success.items) ? success.items : [];
    const invoiceCount = invoiceItems.reduce((n, item) => n + (Number(item.qty) || 0), 0);

    const copyOrderId = async () => {
      try {
        await navigator.clipboard.writeText(success.id);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        const textArea = document.createElement('textarea');
        textArea.value = success.id;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();

        try {
          document.execCommand('copy');
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } finally {
          document.body.removeChild(textArea);
        }
      }
    };

  return (
    <div
      className="order-confirmation-page"
      style={{
        background: 'radial-gradient(ellipse at 50% 0%, rgba(201,168,76,0.12), transparent 42%), #080808',
        minHeight: 'calc(100vh - 90px)',
        padding: '104px 16px 56px',
        position: 'relative',
        boxSizing: 'border-box',
      }}
    >
      <AnimatePresence>
        {copied && (
          <motion.div
            data-copy-toast="true"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            style={{
              position: 'fixed',
              top: 30,
              left: 0,
              right: 0,
              margin: '0 auto',
              width: 'fit-content',
              maxWidth: '90vw',
              background: '#d1b363',
              color: '#000000',
              padding: '10px 20px',
              borderRadius: 30,
              fontWeight: 600,
              fontSize: 16,
              boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
              zIndex: 9999,
              whiteSpace: 'nowrap',
              textAlign: 'center',
            }}
          >
            Order number copied!
          </motion.div>
        )}
      </AnimatePresence>

      <div className="order-receipt">
        <motion.article
          className="order-confirmation-card"
          data-invoice="true"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          style={{
            boxSizing: 'border-box',
            textAlign: 'center',
            padding: '34px 26px 22px',
            background: 'linear-gradient(160deg, #17150f 0%, #100f0d 46%, #0b0b0b 100%)',
            border: '1px solid rgba(201,168,76,0.30)',
            width: '100%',
            color: '#f5f0e8',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {/* One slow specular pass over the paper, then nothing. It is a
              transform on a single element, so it costs the compositor one layer
              and never repaints the invoice text underneath. */}
          <span className="order-invoice-sheen" aria-hidden="true" />

          <header className="order-invoice-head">
            <div className="order-invoice-brand">
              <span className="order-invoice-wordmark" aria-hidden="true">
                {'ZASHM'.split('').map((letter, index) => (
                  <span key={`${letter}-${index}`} style={{ '--letter-index': index }}>{letter}</span>
                ))}
              </span>
              <span className="order-invoice-brand-sub">Luxury Menswear · Egypt</span>
            </div>
            <div className="order-invoice-stamp">
              <span className="order-invoice-stamp-label">{'Invoice'}</span>
              <span className="order-invoice-stamp-id">{success.id}</span>
            </div>
          </header>

          <div className="order-invoice-perf" aria-hidden="true" />

          <div className="order-invoice-status">
            <motion.div
              className="order-invoice-seal"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.1, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              aria-hidden="true"
            >
              <CheckCircle size={22} color="#0b0b0b" strokeWidth={2.2} />
            </motion.div>

            <div className="order-invoice-status-copy">
              <p className="order-invoice-eyebrow">{'Order confirmed'}</p>
              <h1 className="order-invoice-title">{'Thank you for your order'}</h1>

              {/* Five gold stars: the receipt opens on a rating, not a tick. */}
              <div className="order-invoice-stars" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((index) => (
                  <motion.span
                    key={index}
                    className="order-invoice-star"
                    style={{ '--star-index': index }}
                    initial={{ opacity: 0, scale: 0.5, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    transition={{ delay: 0.16 + index * 0.08, duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
                  >
                    ★
                  </motion.span>
                ))}
              </div>
            </div>
          </div>

          {success.pending && (
            <p className="order-invoice-pending">
              هنكلمك على رقمك لتأكيد تفاصيل الأوردر قبل الشحن.
              <span>We&apos;ll contact you to confirm your order before shipping.</span>
            </p>
          )}

          <dl className="order-invoice-meta">
            <div>
              <dt>{'Issued'}</dt>
              <dd>{placedDate || '—'}</dd>
            </div>
            <div>
              <dt>{'Items'}</dt>
              <dd>{invoiceCount}</dd>
            </div>
            <div>
              <dt>{'Payment'}</dt>
              <dd>{'Cash on delivery'}</dd>
            </div>
            <div>
              <dt>{'Delivery'}</dt>
              <dd>{success.city || 'Egypt'}</dd>
            </div>
          </dl>

          <div className="order-confirmation-summary">
            <div className="order-invoice-summary-head">
              <span>{'Reference'}</span>
              <span className="order-invoice-ref">
                {success.id}
                <button
                  type="button"
                  onClick={copyOrderId}
                  aria-label="Copy order reference"
                  title="Copy Order ID"
                  className="order-invoice-copy"
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
              </span>
            </div>

            <ul className="order-invoice-lines">
              {invoiceItems.map((item, index) => (
                <li
                  key={`${item.productId || item.name}-${index}`}
                  style={{ '--row-index': index }}
                >
                  <div className="order-invoice-line-copy">
                    <p className="order-invoice-line-name">{item.name}</p>
                    <p className="order-invoice-line-meta">
                      {[item.size, item.color, `Qty ${item.qty}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="order-invoice-line-price">EGP {Number(item.price || 0).toLocaleString()}</span>
                </li>
              ))}
            </ul>

            <div className="order-invoice-totals">
              <div>
                <span>{'Subtotal'}</span>
                <span>EGP {Number(success.subtotal || 0).toLocaleString()}</span>
              </div>
              {Number(success.discount || 0) > 0 && (
                <div className="is-credit">
                  <span>{'Discount'}</span>
                  <span>− EGP {Number(success.discount).toLocaleString()}</span>
                </div>
              )}
              {Number(success.shippingCost || 0) > 0 && (
                <div>
                  <span>{'Shipping'}</span>
                  <span>EGP {Number(success.shippingCost).toLocaleString()}</span>
                </div>
              )}
              <div className="order-invoice-total-row">
                <span>{'Total paid on delivery'}</span>
                <strong>EGP {Number(success.total || 0).toLocaleString()}</strong>
              </div>
            </div>
          </div>

          {/* Uniform actions */}
          <div
            data-order-actions="true"
            className="order-confirmation-actions"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              alignItems: 'stretch',
              gap: 8,
              width: '100%',
              direction: 'ltr',
            }}
          >
            {!success.pending && (
              <button
                type="button"
                className="order-confirmation-primary"
                onClick={() => {
                  const url = success.tracking_url || '/track';

                  clearOrderConfirmation();
                  window.location.assign(url);
                }}
                style={orderActionStyle}
                {...orderActionHover}
              >
                <PackageSearch
                  size={15}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  style={orderActionIcon}
                />
                <span>TRACK YOUR ORDER</span>
              </button>
            )}

            <a
              className="order-confirmation-secondary"
              href={
                'https://wa.me/201013380313?text=' +
                encodeURIComponent(
                  'Hello ZASHM, I would like to ask about my order with reference number: ' +
                    success.id
                )
              }
              target="_blank"
              rel="noopener noreferrer"
              style={orderActionStyle}
              {...orderActionHover}
            >
              <Headset
                size={15}
                strokeWidth={1.8}
                aria-hidden="true"
                style={orderActionIcon}
              />
              <span>CONTACT SUPPORT</span>
            </a>

            <button
              type="button"
              className="order-confirmation-continue"
              onClick={() => {
                clearOrderConfirmation();
                setPage('home');
              }}
              style={orderActionStyle}
              {...orderActionHover}
            >
              <ShoppingBag
                size={15}
                strokeWidth={1.8}
                aria-hidden="true"
                style={orderActionIcon}
              />
              <span>CONTINUE SHOPPING</span>
            </button>
          </div>

          <p className="order-invoice-foot">
            <Truck size={13} aria-hidden="true" />
            {'Our team will call before delivery.'}
          </p>
        </motion.article>
      </div>
    </div>
  );
}

  if (safeCart.length === 0) {
    return (
      <div style={{ paddingTop: 90, minHeight: '80vh' }} className="cart-page">
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '60px 24px', textAlign: 'center' }}>
          {/* The bag only empties when the shopper removes a line themselves.
              A server-side rejection still needs its reason visible here. */}
          <StockFeedback notice={stockNotice} errors={stockErrors} title={orderOutage ? 'Couldn’t place the order:' : undefined} />
          <ShoppingBag size={64} color="var(--border)" style={{ margin: '0 auto 20px', display: 'block' }} />
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 8, color: 'var(--gold-1)' }}>Your bag is empty</h1>
          <p style={{ color: 'var(--text3)', fontSize: 13, marginBottom: 24 }}>
            Add a piece to your bag before checking out.
          </p>
          <button className="gold-btn" onClick={() => setPage('shop')}>Explore Collection</button>
        </div>
      </div>
    );
  }

  const blocked = Boolean(liveIssues && liveIssues.some(i => i.blocking));
  const placing = submitting || isPlacingOrder.current;

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div className="checkout-shell">
        <motion.header
          className="checkout-head"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        >
          <h1 className="checkout-title">{'Checkout'}</h1>
        </motion.header>

        <StockFeedback notice={stockNotice} errors={stockErrors} title={orderOutage ? 'Couldn’t place the order:' : undefined} />
        {orderOutage && (
          <div className="outage-order-cta" role="status">
            <p>
              تعذّر إرسال الطلب للسيرفر دلوقتي. ابعتلنا طلبك على واتساب وهنكمّله معاك فورًا.
              <br />
              We couldn&apos;t reach the server. Send your order on WhatsApp and our team will complete it.
            </p>
            <a
              className="gold-btn"
              href={whatsappUrl(cartWhatsAppMessage(safeCart, finalTotal))}
              target="_blank"
              rel="noopener noreferrer"
            >
              اطلب عبر واتساب / Order on WhatsApp
            </a>
          </div>
        )}
        <LiveStockBanner issues={liveIssues} />

        <div className="checkout-grid">
          {/* ── Left column: the details the shopper types ── */}
          <section className="checkout-form-card" aria-labelledby="checkout-delivery-title">
            <div className="checkout-card-head">
              <span className="checkout-step" aria-hidden="true"><Truck size={15} strokeWidth={1.6} /></span>
              <div>
                <h2 id="checkout-delivery-title" className="checkout-card-title">{'Delivery details'}</h2>
              </div>
            </div>

            <div className="checkout-field-row">
              <div className="checkout-field">
                <label htmlFor="checkout-name" className="checkout-label">{'Full Name *'}</label>
                <input
                  id="checkout-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={form.name ?? ''}
                  onChange={e => update('name', e.target.value)}
                  placeholder="Mohammed Hassan"
                  aria-invalid={errors.name ? 'true' : undefined}
                  aria-describedby={errors.name ? 'checkout-name-error' : undefined}
                  style={{ borderColor: errors.name ? 'var(--red)' : undefined }}
                />
                {errors.name && <p id="checkout-name-error" role="alert" className="checkout-error">{errors.name}</p>}
              </div>

              <div className="checkout-field">
                <label htmlFor="checkout-phone" className="checkout-label">{'Phone Number *'}</label>
                <input
                  id="checkout-phone"
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={form.phone ?? ''}
                  onChange={e => update('phone', e.target.value)}
                  placeholder="01XXXXXXXXX"
                  aria-invalid={errors.phone ? 'true' : undefined}
                  aria-describedby={errors.phone ? 'checkout-phone-error' : undefined}
                  style={{ borderColor: errors.phone ? 'var(--red)' : undefined }}
                />
                {errors.phone && <p id="checkout-phone-error" role="alert" className="checkout-error">{errors.phone}</p>}
              </div>
            </div>

            <div className="checkout-field-row">
              <div className="checkout-field">
                <label htmlFor="checkout-phone-alt" className="checkout-label">{'Alternative phone'}</label>
                <input
                  id="checkout-phone-alt"
                  name="phoneAlt"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={form.phoneAlt ?? ''}
                  onChange={e => update('phoneAlt', e.target.value)}
                  placeholder="01XXXXXXXXX"
                  aria-invalid={errors.phoneAlt ? 'true' : undefined}
                  aria-describedby={errors.phoneAlt ? 'checkout-phone-alt-error' : undefined}
                  style={{ borderColor: errors.phoneAlt ? 'var(--red)' : undefined }}
                />
                {errors.phoneAlt && <p id="checkout-phone-alt-error" role="alert" className="checkout-error">{errors.phoneAlt}</p>}
              </div>

              <div className="checkout-field">
                <label htmlFor="checkout-email" className="checkout-label">{'Email address'}</label>
                <input
                  id="checkout-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={form.email ?? ''}
                  onChange={e => update('email', e.target.value)}
                  placeholder="your@email.com"
                  aria-invalid={errors.email ? 'true' : undefined}
                  aria-describedby={errors.email ? 'checkout-email-error' : undefined}
                  style={{ borderColor: errors.email ? 'var(--red)' : undefined }}
                />
                {errors.email && <p id="checkout-email-error" role="alert" className="checkout-error">{errors.email}</p>}
              </div>
            </div>

            <div className="checkout-field">
              <label htmlFor="checkout-address" className="checkout-label">{'Street Address *'}</label>
              <input
                id="checkout-address"
                name="address"
                value={form.address ?? ''}
                onChange={e => update('address', e.target.value)}
                placeholder="District / neighborhood, street, building, floor or apartment..."
                autoComplete="street-address"
                aria-invalid={errors.address ? 'true' : undefined}
                aria-describedby={errors.address ? 'checkout-address-error' : undefined}
                style={{ borderColor: errors.address ? 'var(--red)' : undefined }}
              />
              {errors.address && <p id="checkout-address-error" role="alert" className="checkout-error">{errors.address}</p>}
            </div>

            <div className="checkout-field">
              <label htmlFor="checkout-governorate" className="checkout-label">{'Governorate *'}</label>
              <CityAutocomplete
                id="checkout-governorate"
                value={form.city}
                onChange={v => update('city', v)}
                onSelect={v => update('city', v)}
                error={errors.city}
                describedBy={errors.city ? 'checkout-governorate-error' : undefined}
              />
              <p id="checkout-governorate-error" role={errors.city ? 'alert' : undefined} className="checkout-error checkout-error--slot">{errors.city || ''}</p>
            </div>

            <div className="checkout-field">
              <label htmlFor="checkout-notes" className="checkout-label">{'Order notes'}</label>
              <textarea
                id="checkout-notes"
                name="notes"
                value={form.notes ?? ''}
                onChange={e => update('notes', e.target.value)}
                rows={3}
                placeholder="Special requests, preferred delivery time..."
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>
          </section>

          {/* ── Right column: one Order Summary card, in the original order:
              pieces, then the discount, then the running total, then payment,
              then the CTA. ── */}
          <aside className="checkout-card checkout-summary" aria-labelledby="checkout-summary-title">
            <div className="checkout-card-head checkout-card-head--tight">
              <span className="checkout-step" aria-hidden="true"><ShoppingBag size={15} strokeWidth={1.6} /></span>
              <h2 id="checkout-summary-title" className="checkout-card-title">{'Order Summary'}</h2>
            </div>
            <ul className="checkout-item-list">
              {safeCart.map(item => (
                <li key={item?.key}>
                  <SafeImage
                    src={item?.product?.images?.[0]}
                    fallback={'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="50"%3E%3Crect fill="%23222" width="40" height="50"/%3E%3C/svg%3E'}
                    alt=""
                    style={{ width: 40, height: 50, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }}
                    loading="lazy"
                  />
                  <div className="checkout-item-copy">
                    <p className="checkout-item-name">{item?.product?.name ?? 'Unknown Product'}</p>
                    <p className="checkout-item-meta">{item?.size ?? 'N/A'} / {item?.color ?? 'N/A'} × {item?.qty ?? 0}</p>
                  </div>
                  <span className="checkout-item-price">
                    EGP {(effectivePrice(item?.product) * (item?.qty ?? 0)).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>

            <section className="checkout-summary-block checkout-summary-discount" aria-labelledby="checkout-coupon-title">
              <h3 id="checkout-coupon-title" className="checkout-mini-title">{'Discount code'}</h3>
              {!appliedDiscount ? (
                <>
                  <div className="checkout-coupon-row">
                    <div className="checkout-coupon-field">
                      <Tag size={12} aria-hidden="true" />
                      <input
                        value={coupon}
                        onChange={e => { setCoupon(e.target.value); setCouponError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                        onFocus={warmCouponEndpoint}
                        disabled={couponApplying}
                        placeholder={'Promo code'}
                        aria-label="Discount code"
                        aria-invalid={couponError ? 'true' : undefined}
                        style={{ borderColor: couponError ? 'var(--red)' : undefined }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleApplyCoupon}
                      disabled={couponApplying}
                      aria-busy={couponApplying}
                      className="checkout-coupon-apply"
                      style={{ minWidth: 72 }}
                    >
                      {couponApplying ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {couponError && (
                    <div className="checkout-coupon-error" role="alert">
                      <AlertCircle size={12} aria-hidden="true" />
                      <p>{couponError}</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="checkout-coupon-applied">
                  <span>
                    <Check size={13} aria-hidden="true" />
                    {appliedDiscount.code}
                  </span>
                  <button type="button" onClick={removeAppliedDiscount}>{'Remove'}</button>
                </div>
              )}
            </section>

            <section className="checkout-summary-block checkout-summary-totals" aria-label="Order total">
              <div className="checkout-total-row">
                <span>{'Subtotal'}</span>
                <span>EGP {(subtotal ?? 0).toLocaleString()}</span>
              </div>
              <div className="checkout-total-row">
                <span>
                  Discount{appliedDiscount ? ` (${appliedDiscount.code})` : ''}
                </span>
                <span className={(discountAmount ?? 0) > 0 ? 'is-credit' : 'is-muted'}>
                  {(discountAmount ?? 0) > 0 ? `-EGP ${(discountAmount ?? 0).toLocaleString()}` : 'EGP 0'}
                </span>
              </div>
              <div className="checkout-total-row">
                <span>{'Shipping'}</span>
                <span className={shippingCost === 0 ? 'is-muted' : undefined}>
                  {shippingCost === 0 ? 'Select city' : `EGP ${shippingCost}`}
                </span>
              </div>
              <div className="checkout-grand-row">
                <span>{'Total'}</span>
                <strong>EGP {(finalTotal ?? 0).toLocaleString()}</strong>
              </div>
            </section>

            <section className="checkout-summary-block checkout-summary-payment" aria-labelledby="checkout-payment-title">
              <h3 id="checkout-payment-title" className="checkout-mini-title">{'Payment method'}</h3>
              {/* Payment method selector. COD is the only live option today;
                  card payments are shown as "Coming soon" so the shopper sees
                  the roadmap without being able to select them. */}
              <div
                role="radiogroup"
                aria-label="Payment method"
                className="checkout-payment-options"
              >
                {/* Cash on Delivery — live */}
                <label className="checkout-payment-option is-live">
                  <input
                    type="radio"
                    name="payment-method"
                    value="cod"
                    defaultChecked
                    style={{ marginTop: 9, accentColor: 'var(--gold)', flexShrink: 0 }}
                  />
                  <span className="checkout-payment-icon" aria-hidden="true">
                    <Banknote size={17} color="var(--gold)" />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="checkout-payment-head">
                      <span className="checkout-payment-name">
                        Cash on Delivery
                      </span>
                      <span className="checkout-payment-badge is-live">
                        Available
                      </span>
                    </div>
                    <p className="checkout-payment-copy">
                      Pay in cash when it arrives.
                    </p>
                  </div>
                </label>

                {/* Card payments — coming soon */}
                <div className="checkout-payment-option is-soon" aria-disabled="true">
                  <input
                    type="radio"
                    name="payment-method"
                    value="card"
                    disabled
                    style={{ marginTop: 9, flexShrink: 0 }}
                  />
                  <span className="checkout-payment-icon" aria-hidden="true">
                    <CreditCard size={17} color="var(--text3)" />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="checkout-payment-head">
                      <span className="checkout-payment-name">
                        Credit / Debit Card
                      </span>
                      <span className="checkout-payment-badge is-soon">
                        Coming soon
                      </span>
                    </div>
                    <p className="checkout-payment-copy">
                      In a future update.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <div className="checkout-side-submit">
              <motion.button
                className="gold-btn checkout-place-order"
                style={{ opacity: placing ? 0.7 : 1 }}
                onClick={handleOrder}
                disabled={placing || blocked}
                whileTap={{ scale: 0.98 }}
              >
                {placing ? (
                  <span className="checkout-placing">
                    <motion.span
                      className="checkout-spinner"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                      aria-hidden="true"
                    />
                    <span>Placing Order…</span>
                  </span>
                ) : (
                  <span>PLACE ORDER</span>
                )}
              </motion.button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── WISHLIST PAGE ────────────────────────────────────────────────────────────
export function WishlistPage() {
  const { products, wishlist, setPage } = useStore();
  // 🎯 إخفاء المنتجات غير النشطة عن العملاء في قائمة المفضلة
  const wished = products.filter(p => p.active !== false && wishlist.includes(p.id));

  React.useEffect(() => { setPageMeta({ title: 'Wishlist', description: 'Your saved luxury pieces', robots: 'noindex, nofollow' }); }, []);

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: 'clamp(28px, 6vw, 40px) clamp(16px, 4vw, 24px)' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <p style={{ fontSize: 10, letterSpacing: 4, color: 'var(--gold)', textTransform: 'uppercase', marginBottom: 8 }}>{'Saved'}</p>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(30px, 7vw, 48px)', fontWeight: 400 }}>{'Wishlist'}</h1>
          <p style={{ color: 'var(--text3)', marginTop: 8 }}>{wished.length} {wished.length === 1 ? 'item' : 'items'} saved</p>
        </div>
        {wished.length === 0 ? (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} style={{ textAlign: 'center', padding: '60px 0' }}>
            <Heart size={80} color="var(--border)" style={{ margin: '0 auto 24px', display: 'block' }} />
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginBottom: 8, color: 'var(--text2)' }}>{'Nothing saved yet'}</p>
            <p style={{ color: 'var(--text3)', marginBottom: 32 }}>{'Save your favourite pieces for later'}</p>
            <button className="gold-btn" onClick={() => setPage('shop')}>{'Explore Collection'}</button>
          </motion.div>
        ) : (
          <div className="product-collection-grid">
            {wished.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export default CartPage;