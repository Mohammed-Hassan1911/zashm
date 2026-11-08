import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, ShoppingBag, Heart, Plus, Minus, Tag, Check, AlertCircle, CheckCircle, Truck, Banknote, CreditCard, PackageSearch, Headset } from 'lucide-react';
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
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
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
        <div role="alert" aria-live="assertive"
          style={{ border: '1px solid var(--red)', borderRadius: 6, padding: '12px 16px', background: 'rgba(192,57,43,0.07)' }}>
          <p style={{ color: 'var(--red)', fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
            {blocking.length === 1 ? 'One piece in your bag' : `${blocking.length} pieces in your bag`} can’t be ordered right now.
          </p>
          {detailed && (
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {blocking.map(i => (
                <li key={i.key} style={{ color: 'var(--red)', fontSize: 11, lineHeight: 1.6 }}>{i.message}</li>
              ))}
            </ul>
          )}
          <p style={{ color: 'var(--text2)', fontSize: 12, margin: '8px 0 0' }}>
            {detailed
              ? 'Remove the marked piece(s) to continue — nothing was taken out of your bag automatically.'
              : 'Each one is marked in your bag below with its own Remove button — nothing was taken out of your bag automatically.'}
          </p>
        </div>
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

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }} className="cart-page">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 'clamp(24px, 5vw, 40px) clamp(16px, 4vw, 24px)' }}>
        <motion.h1 initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }}
          style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(26px, 7vw, 40px)', fontWeight: 400, letterSpacing: 'clamp(1px, 0.5vw, 2px)', marginBottom: 'clamp(20px, 5vw, 40px)' }}>Shopping Bag</motion.h1>

        <LiveStockBanner issues={lineIssues} detailed={false} />

        {safeCart.length === 0 ? (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} style={{ textAlign: 'center', padding: '80px 0' }}>
            <ShoppingBag size={80} color="var(--border)" style={{ margin: '0 auto 24px', display: 'block' }} />
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(20px, 5.5vw, 28px)', marginBottom: 8, color: 'var(--text2)' }}>Your bag is empty</p>
            <p style={{ color: 'var(--text3)', marginBottom: 32 }}>Explore our collection to find your next luxury piece</p>
            <button className="gold-btn" onClick={() => setPage('shop')}>Explore Collection</button>
          </motion.div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 'clamp(20px, 5vw, 40px)' }} className="cart-grid">
            <div>
              <AnimatePresence>
                {safeCart.map(item => (
                  <motion.div key={item?.key} layout initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0, height:0, overflow:'hidden' }}
                    style={{ display: 'flex', gap: 'clamp(12px, 3vw, 20px)', padding: 'clamp(14px, 3.5vw, 20px) 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ position:'relative' }}>
                      <SafeImage src={item?.product?.images?.[0]} fallback={'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="110" height="138"%3E%3Crect fill="%23ccc" width="110" height="138"/%3E%3C/svg%3E'} alt={item?.product?.name ?? 'Product'}
                        style={{ width: 'clamp(74px, 22vw, 110px)', aspectRatio: '3 / 4', height: 'auto', objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} loading="lazy" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ color: 'var(--text3)', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>{item?.product?.category ?? 'General'}</p>
                      <p style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(15px, 4.3vw, 19px)', fontWeight: 500, marginBottom: 5 }}>{item?.product?.name ?? 'Unknown Product'}</p>
                      <p style={{ color: 'var(--text2)', fontSize: 'clamp(10px, 3vw, 11px)', marginBottom: 12 }}>Size: {item?.size ?? 'N/A'} · Color: {item?.color ?? 'N/A'}</p>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 2 }}>
                          <button onClick={() => (item?.qty ?? 0) > 1 ? changeQty(item, (item?.qty ?? 0) - 1) : removeFromCart(item?.key)}
                            type="button"
                            aria-label={`Decrease quantity of ${item?.product?.name || 'item'}`}
                            style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer' }}>
                            <Minus size={12} aria-hidden="true" />
                          </button>
                          <span style={{ padding: '0 8px', fontSize: 13, minWidth: 26, textAlign: 'center' }}>{item?.qty ?? 0}</span>
                          <button onClick={() => changeQty(item, (item?.qty ?? 0) + 1)}
                            type="button"
                            aria-label={`Increase quantity of ${item?.product?.name || 'item'}`}
                            style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer' }}>
                            <Plus size={12} aria-hidden="true" />
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ color: '#b9a06c', fontSize: 15, fontWeight: 600 }}>EGP {(effectivePrice(item?.product) * (item?.qty ?? 0)).toLocaleString()}</span>
                          <button onClick={() => removeFromCart(item?.key)}
                            type="button"
                            aria-label={`Remove ${item?.product?.name || 'item'} from bag`}
                            style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s', width: 44, height: 44, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}><Trash2 size={15} aria-hidden="true" /></button>
                        </div>
                      </div>
                      <LineStockIssue issue={issueByKey.get(item?.key)} onRemove={() => removeFromCart(item?.key)} />
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 24, position: 'sticky', top: 100 }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(17px, 4.6vw, 20px)', marginBottom: 20 }}>Order Summary</h3>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Subtotal</span>
                  <span style={{ fontSize: 13 }}>EGP {subtotal.toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>
                    Discount{appliedDiscount ? ` (${appliedDiscount.code})` : ''}
                  </span>
                  <span style={{ fontSize: 13, color: discountAmount > 0 ? '#27ae60' : 'var(--text3)' }}>
                    {discountAmount > 0 ? `-EGP ${discountAmount.toLocaleString()}` : 'EGP 0'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Shipping</span>
                  <span style={{ color: 'var(--text3)', fontSize: 13 }}>Calculated at next step</span>
                </div>
                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600 }}>Total</span>
                    <span style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: 'clamp(18px, 5vw, 22px)', fontWeight: 600 }}>EGP {total.toLocaleString()}</span>
                  </div>
                </div>

                {!appliedDiscount ? (
                  <div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: couponError ? 6 : 14 }}>
                      <div style={{ position:'relative', flex:1 }}>
                        <Tag size={12} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
                        <input value={coupon} onChange={e => { setCoupon(e.target.value); setCouponError(''); }}
                          onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                          onFocus={warmCouponEndpoint}
                          disabled={couponApplying}
                          placeholder="Discount code" style={{ width:'100%', paddingLeft:28, minHeight: 44, borderColor: couponError ? 'var(--red)' : undefined }} />
                      </div>
                      <button onClick={handleApplyCoupon} disabled={couponApplying} aria-busy={couponApplying}
                        style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)', padding: '10px 14px', borderRadius: 4, cursor: couponApplying ? 'default' : 'pointer', fontSize: 12, whiteSpace: 'nowrap', minWidth: 96, minHeight: 44, boxSizing: 'border-box', opacity: couponApplying ? 0.75 : 1 }}>
                        {couponApplying ? 'Checking…' : 'Apply'}
                      </button>
                    </div>
                    {couponError && (
                      <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:12 }}>
                        <AlertCircle size={12} color="var(--red)" />
                        <p style={{ color: 'var(--red)', fontSize: 11 }}>{couponError}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, padding: '8px 12px', background: 'rgba(39,174,96,0.08)', borderRadius: 4, border: '1px solid rgba(39,174,96,0.3)' }}>
                    <span style={{ color: '#27ae60', fontSize: 12 }}><Check size={12} style={{ display:'inline', marginRight:5 }} />{appliedDiscount.code}</span>
                    <button type="button" onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, minHeight: 44, padding: '0 8px' }}>Remove</button>
                  </div>
                )}

                <button className="gold-btn" style={{ width: '100%', marginBottom: 10 }} onClick={() => setPage('checkout')}>
                  Proceed to Checkout
                </button>
                <button className="outline-btn" style={{ width: '100%' }} onClick={() => setPage('shop')}>Continue Shopping</button>
              </div>
            </div>
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
      
      <motion.div
        className="order-confirmation-card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        style={{
          boxSizing: 'border-box',
          textAlign: 'center',
          padding: '30px 28px 26px',
          background: 'linear-gradient(145deg, #151515 0%, #0e0e0e 72%)',
          border: '1px solid rgba(201,168,76,0.28)',
          borderRadius: 16,
          maxWidth: 620,
          width: '100%',
          margin: '0 auto',
          boxShadow: '0 22px 70px rgba(0,0,0,0.5), 0 0 45px rgba(201,168,76,0.06)',
          color: '#f5f0e8',
        }}
      >
        {/* Success icon */}
        <motion.div
          className="order-confirmation-icon"
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
          style={{
            width: 60,
            height: 60,
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 14px',
            borderRadius: '50%',
            background: 'rgba(201,168,76,0.09)',
            border: '1px solid rgba(201,168,76,0.35)',
            boxShadow: '0 0 28px rgba(201,168,76,0.11)',
          }}
        >
          <CheckCircle
            size={30}
            color="#d5b65d"
            strokeWidth={1.6}
          />
        </motion.div>

        <div style={{ marginBottom: 18 }}>
          <p style={{ color: '#c9a84c', fontSize: 9, fontWeight: 700, letterSpacing: 3, marginBottom: 6 }}>
            ORDER CONFIRMED
          </p>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 4.2vw, 30px)', fontWeight: 500, lineHeight: 1.2, margin: '0 0 6px', color: '#f5f0e8' }}>
            Thank you for your order
          </h1>
        </div>

        {/* Order reference */}
        <div
          className="order-confirmation-reference"
          style={{
            boxSizing: 'border-box',
            background: 'linear-gradient(110deg, #211d12, #17150f)',
            border: '1px solid rgba(201,168,76,0.26)',
            borderRadius: 10,
            padding: '14px 16px',
            marginBottom: 12,
            width: '100%',
            textAlign: 'left',
          }}
        >
          <div
            style={{
              color: '#c9aa50',
              fontSize: 9,
              marginBottom: 5,
              textAlign: 'left',
              letterSpacing: 1.5,
              lineHeight: 1.6,
            }}
          >
            <div
              style={{
                direction: 'ltr',
                letterSpacing: 0,
              }}
            >
              ORDER ID
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              direction: 'ltr',
            }}
          >
            <span
              style={{
                color: '#e4c66d',
                fontSize: 'clamp(14px, 3vw, 17px)',
                fontWeight: 700,
                letterSpacing: 1.5,
                fontFamily: 'monospace',
                overflowWrap: 'anywhere',
                lineHeight: 1.6,
              }}
            >
              {success.id}
            </span>

            <button
              type="button"
              onClick={async () => {
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
              }}
              aria-label="Copy order reference"
              title="Copy Order ID"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#e4c66d',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
                borderRadius: 5,
                transition: 'color 0.25s ease, transform 0.25s ease',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#f0d78b';
                e.currentTarget.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
              e.currentTarget.style.color = '#e4c66d';
                e.currentTarget.style.transform = 'scale(1)';
              }}
              onFocus={(e) => {
                e.currentTarget.style.outline = '2px solid #c9aa50';
                e.currentTarget.style.outlineOffset = '3px';
              }}
              onBlur={(e) => {
                e.currentTarget.style.outline = 'none';
              }}
            >
              <svg
                width="18"
                height="18"
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
          </div>
        </div>

        <div className="order-confirmation-summary" style={{ textAlign: 'left', background: '#101010', border: '1px solid #292720', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
          <h3 style={{ color: '#f0ece4', fontSize: 12, fontWeight: 600, margin: '0 0 10px' }}>
            Order summary
          </h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {(Array.isArray(success.items) ? success.items : []).map((item, index) => (
              <div key={`${item.productId || item.name}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ color: '#e5e0d7', fontSize: 11, margin: 0, overflowWrap: 'anywhere' }}>{item.name}</p>
                  <p style={{ color: '#8f897e', fontSize: 9, margin: '2px 0 0' }}>{[item.size, item.color, `Qty ${item.qty}`].filter(Boolean).join(' · ')}</p>
                </div>
                <span style={{ color: '#d1b363', fontSize: 11, whiteSpace: 'nowrap' }}>EGP {Number(item.price || 0).toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div style={{ height: 1, background: '#292720', margin: '10px 0 9px' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, color: '#aaa398', fontSize: 10 }}>
            <span>Subtotal</span>
            <span>EGP {Number(success.subtotal || 0).toLocaleString()}</span>
          </div>
          {Number(success.discount || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, color: '#9fbd91', fontSize: 10 }}>
              <span>Discount</span>
              <span>− EGP {Number(success.discount).toLocaleString()}</span>
            </div>
          )}
          {Number(success.shippingCost || 0) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6, color: '#aaa398', fontSize: 10 }}>
              <span>Shipping</span>
              <span>EGP {Number(success.shippingCost).toLocaleString()}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6, color: '#aaa398', fontSize: 10 }}>
            <span><Truck size={13} style={{ verticalAlign: 'middle', marginInlineEnd: 5, color: '#c9a84c' }} />Delivery</span>
            <span>{success.city || 'Egypt'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8, color: '#aaa398', fontSize: 10 }}>
            <span><Banknote size={13} style={{ verticalAlign: 'middle', marginInlineEnd: 5, color: '#c9a84c' }} />Payment</span>
            <span style={{ textAlign: 'right', lineHeight: 1.4 }}>Cash on delivery</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, borderTop: '1px solid #292720', paddingTop: 10 }}>
            <span style={{ color: '#e5e0d7', fontSize: 11, fontWeight: 600 }}>Order total</span>
            <strong style={{ color: '#e4c66d', fontFamily: 'var(--font-display)', fontSize: 18 }}>EGP {Number(success.total || 0).toLocaleString()}</strong>
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
      </motion.div>
    </div>
  );
}

  if (safeCart.length === 0) {
    return (
      <div style={{ paddingTop: 90, minHeight: '80vh' }} className="cart-page">
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '60px 24px', textAlign: 'center' }}>
          {/* The bag only empties when the shopper removes a line themselves.
              A server-side rejection still needs its reason visible here. */}
          <StockFeedback notice={stockNotice} errors={stockErrors} />
          <ShoppingBag size={64} color="var(--border)" style={{ margin: '0 auto 20px', display: 'block' }} />
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 8, color: 'var(--text2)' }}>Your bag is empty</h1>
          <p style={{ color: 'var(--text3)', fontSize: 13, marginBottom: 24 }}>
            Add a piece to your bag before checking out.
          </p>
          <button className="gold-btn" onClick={() => setPage('shop')}>Explore Collection</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '40px 24px' }}>
        <motion.h1 initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }}
          style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400, letterSpacing: 2, marginBottom: 40 }}>{'Checkout'}</motion.h1>

        <StockFeedback notice={stockNotice} errors={stockErrors} />
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

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 40 }} className="checkout-grid">
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 28 }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, marginBottom: 22 }}>{'Delivery Information'}</h3>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
              gap: 14, 
              marginBottom: 14 
            }}>
              <div>
                <label htmlFor="checkout-name" style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Full Name *'}</label>
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
                  style={{ width:'100%', borderColor: errors.name ? 'var(--red)' : undefined }} 
                />
                {errors.name && <p id="checkout-name-error" role="alert" style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.name}</p>}
              </div>
              <div>
                <label htmlFor="checkout-phone" style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Phone Number *'}</label>
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
                  style={{ width:'100%', borderColor: errors.phone ? 'var(--red)' : undefined }} 
                />
                {errors.phone && <p id="checkout-phone-error" role="alert" style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.phone}</p>}
              </div>
            </div>

            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
              gap: 14, 
              marginBottom: 14,
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label htmlFor="checkout-phone-alt" style={{ 
                  display:'flex', 
                  alignItems: 'center',
                  fontSize:10, 
                  letterSpacing:1.5, 
                  color:'var(--text3)', 
                  marginBottom:6, 
                  textTransform:'uppercase',
                  minHeight: 30 
                }}>
                  {'Alternative Phone (Optional)'}
                </label>
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
                  style={{ width:'100%', borderColor: errors.phoneAlt ? 'var(--red)' : undefined }} 
                />
                {errors.phoneAlt && <p id="checkout-phone-alt-error" role="alert" style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.phoneAlt}</p>}
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label htmlFor="checkout-email" style={{ 
                  display:'flex', 
                  alignItems: 'center',
                  fontSize:10, 
                  letterSpacing:1.5, 
                  color:'var(--text3)', 
                  marginBottom:6, 
                  textTransform:'uppercase',
                  minHeight: 30 
                }}>
                  {'Email Address (Optional)'}
                </label>
                <input 
                  id="checkout-email"
                  name="email"
                  value={form.email ?? ''} 
                  onChange={e => update('email', e.target.value)} 
                  placeholder="your@email.com" 
                  aria-invalid={errors.email ? 'true' : undefined}
                  aria-describedby={errors.email ? 'checkout-email-error' : undefined}
                  style={{ width:'100%', borderColor: errors.email ? 'var(--red)' : undefined }} 
                  type="email" 
                  autoComplete="email"
                />
                {errors.email && <p id="checkout-email-error" role="alert" style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.email}</p>}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label htmlFor="checkout-address" style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Street Address *'}</label>
              <input 
                id="checkout-address"
                name="address"
                value={form.address ?? ''} 
                onChange={e => update('address', e.target.value)} 
                placeholder="District / neighborhood, street, building, floor or apartment..."
                autoComplete="street-address"
                aria-invalid={errors.address ? 'true' : undefined}
                aria-describedby={errors.address ? 'checkout-address-error' : undefined}
                style={{ width:'100%', borderColor: errors.address ? 'var(--red)' : undefined }} 
              />
              {errors.address && <p id="checkout-address-error" role="alert" style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.address}</p>}
            </div>

            <div className="checkout-location-grid" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
              <div>
                <label htmlFor="checkout-governorate" style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Governorate *'}</label>
                <CityAutocomplete
                  id="checkout-governorate"
                  value={form.city}
                  onChange={v => update('city', v)}
                  onSelect={v => update('city', v)}
                  error={errors.city}
                  describedBy={errors.city ? 'checkout-governorate-error' : undefined}
                />
                <p id="checkout-governorate-error" role={errors.city ? 'alert' : undefined} style={{ color:'var(--red)', fontSize:10, marginTop:3, minHeight:13 }}>{errors.city || ''}</p>
              </div>
            </div>

            <div>
              <label htmlFor="checkout-notes" style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Order Notes (OPTIONAL)'}</label>
              <textarea 
                id="checkout-notes"
                name="notes"
                value={form.notes ?? ''} 
                onChange={e => update('notes', e.target.value)} 
                rows={3}
                placeholder="Special requests, preferred delivery time..." 
                style={{ width:'100%', resize:'vertical' }} 
              />
            </div>
          </div>

          <div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 22, position:'sticky', top:100 }}>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 16 }}>{'Order Summary'}</h3>
              <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 14 }}>
                {safeCart.map(i => (
                  <div key={i?.key} style={{ display: 'flex', gap:10, justifyContent: 'space-between', marginBottom: 10, alignItems:'flex-start', width: '100%' }}>
                    <div style={{ display:'flex', gap:8 }}>
                      <SafeImage src={i?.product?.images?.[0]} fallback={'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="50"%3E%3Crect fill="%23222" width="40" height="50"/%3E%3C/svg%3E'} alt="" style={{ width:40, height:50, objectFit:'cover', borderRadius:2, flexShrink:0 }} loading="lazy" />
                      <div>
                        <p style={{ fontSize:11, fontWeight:500, lineHeight:1.3 }}>{i?.product?.name ?? 'Unknown Product'}</p>
                        <p style={{ fontSize:10, color:'var(--text3)' }}>{i?.size ?? 'N/A'}/{i?.color ?? 'N/A'} ×{i?.qty ?? 0}</p>
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:600, color:'var(--gold)', whiteSpace:'nowrap', marginLeft: 'auto', textAlign: 'right' }}>
                      EGP {(effectivePrice(i?.product) * (i?.qty ?? 0)).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>

              {!appliedDiscount ? (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: couponError ? 6 : 0 }}>
                    <div style={{ position:'relative', flex:1 }}>
                      <Tag size={12} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
                      <input value={coupon} onChange={e => { setCoupon(e.target.value); setCouponError(''); }}
                        onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                        onFocus={warmCouponEndpoint}
                        disabled={couponApplying}
                        placeholder={'Discount code'} style={{ width:'100%', paddingLeft:28, minHeight: 44, borderColor: couponError ? 'var(--red)' : undefined }} />
                    </div>
                    <button onClick={handleApplyCoupon} disabled={couponApplying} aria-busy={couponApplying}
                      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)', padding: '10px 14px', borderRadius: 4, cursor: couponApplying ? 'default' : 'pointer', fontSize: 12, whiteSpace: 'nowrap', minWidth: 96, minHeight: 44, boxSizing: 'border-box', opacity: couponApplying ? 0.75 : 1 }}>
                      {couponApplying ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {couponError && (
                    <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:6 }}>
                      <AlertCircle size={12} color="var(--red)" />
                      <p style={{ color: 'var(--red)', fontSize: 11 }}>{couponError}</p>
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: 'rgba(39,174,96,0.08)', borderRadius: 4, border: '1px solid rgba(39,174,96,0.3)' }}>
                  <span style={{ color: '#27ae60', fontSize: 12 }}><Check size={12} style={{ display:'inline', marginRight:5 }} />{appliedDiscount.code}</span>
                  <button type="button" onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, minHeight: 44, padding: '0 8px' }}>{'Remove'}</button>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Subtotal</span>
                  <span style={{ fontSize: 13 }}>EGP {(subtotal ?? 0).toLocaleString()}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>
                    Discount{appliedDiscount ? ` (${appliedDiscount.code})` : ''}
                  </span>
                  <span style={{ fontSize: 13, color: (discountAmount ?? 0) > 0 ? '#27ae60' : 'var(--text3)' }}>
                    {(discountAmount ?? 0) > 0 ? `-EGP ${(discountAmount ?? 0).toLocaleString()}` : 'EGP 0'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Shipping</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    {shippingCost === 0 ? 'Select City' : `EGP ${shippingCost}`}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 4, borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 4 }}>
                  <span style={{ fontSize:13 }}>Total</span>
                  <span style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: 20 }}>EGP {(finalTotal ?? 0).toLocaleString()}</span>
                </div>
              </div>

              {/* Payment method selector. COD is the only live option today;
                  card payments are shown as "Coming soon" so the shopper sees
                  the roadmap without being able to select them. */}
              <div
                role="radiogroup"
                aria-label="Payment method"
                style={{
                  marginTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}
              >
                {/* Cash on Delivery — live */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 6,
                    border: '1px solid var(--border-gold)',
                    background: 'rgba(201,168,76,0.07)',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="radio"
                    name="payment-method"
                    value="cod"
                    defaultChecked
                    style={{ marginTop: 3, accentColor: 'var(--gold)', flexShrink: 0 }}
                  />
                  <Banknote size={18} color="var(--gold)" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>
                        Cash on Delivery
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--gold)', padding: '2px 6px', borderRadius: 3, border: '1px solid var(--border-gold)', background: 'rgba(201,168,76,0.12)' }}>
                        Available
                      </span>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, margin: '3px 0 0' }}>
                      Pay in cash when your order arrives. No prepayment required.
                    </p>
                  </div>
                </label>

                {/* Card payments — coming soon */}
                <div
                  aria-disabled="true"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    opacity: 0.55,
                    cursor: 'not-allowed'
                  }}
                >
                  <input
                    type="radio"
                    name="payment-method"
                    value="card"
                    disabled
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <CreditCard size={18} color="var(--text3)" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', lineHeight: 1.4 }}>
                        Credit / Debit Card
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text3)', padding: '2px 6px', borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg2)' }}>
                        Coming soon
                      </span>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, margin: '3px 0 0' }}>
                      Visa, Mastercard and local cards — available in a future update.
                    </p>
                  </div>
                </div>
              </div>

              <motion.button 
                className="gold-btn" 
                style={{ width: '100%', marginTop: 16, opacity: (submitting || isPlacingOrder.current) ? 0.7 : 1 }}
                onClick={handleOrder} 
                disabled={submitting || isPlacingOrder.current} 
                whileTap={{ scale: 0.98 }}
              >
                {(submitting || isPlacingOrder.current) ? (
                  <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                    <motion.div animate={{ rotate:360 }} transition={{ duration:1, repeat:Infinity, ease:'linear' }}
                      style={{ width:14, height:14, border:'2px solid var(--bg)', borderTopColor:'transparent', borderRadius:'50%' }} />
                    <div style={{ textAlign: 'center', lineHeight: 1.2 }}>
                      <div>Placing Order…</div>
                    </div>
                  </span>
                ) : (
                    <div style={{ textAlign: 'center', lineHeight: 1.2 }}>
                      <div>PLACE ORDER</div>
                    </div>
                  )}
              </motion.button>
              <div style={{ color: 'var(--text3)', fontSize: 10, textAlign: 'center', marginTop: 10, lineHeight: 1.6 }}>
              </div>
            </div>
          </div>
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
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <p style={{ fontSize: 10, letterSpacing: 4, color: 'var(--gold)', textTransform: 'uppercase', marginBottom: 8 }}>{'Saved'}</p>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 48, fontWeight: 400 }}>{'Wishlist'}</h1>
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 24 }}>
            {wished.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export default CartPage;