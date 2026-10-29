import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, ShoppingBag, Heart, Plus, Minus, Tag, Check, AlertCircle, CheckCircle } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import { sanitizeInput, setPageMeta, normalizeEgyptPhone } from '../lib/security';
import { filterGovernorates, getShippingCost, GOVERNORATE_AR, toCanonicalGovernorate } from '../lib/egyptCities';

// يطابق المحافظة المكتوبة (عربي/إنجليزي، بأي حالة أحرف) مع القائمة الرسمية،
// ويعيد '' لو مفيش تطابق — يمنع إرسال مدينة حرة يرفضها السيرفر.
function normalizeGovernorate(value) {
  return toCanonicalGovernorate(value);
}
import { toast } from '../components/ui/BackToTop';

function CityAutocomplete({ value, onChange, onSelect, error }) {
  const [open, setOpen] = React.useState(false);
  const suggestions = React.useMemo(() => filterGovernorates(value), [value]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        value={value ?? ''}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={'Cairo'}
        style={{ width: '100%', borderColor: error ? 'var(--red)' : undefined }}
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 50,
          background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 4,
          maxHeight: 180, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}>
          {suggestions.map(city => (
            <button
              key={city}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onSelect(city); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 13,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              {city}
              {GOVERNORATE_AR[city] && <span style={{ color: 'var(--text3)', marginInlineStart: 8 }}>{GOVERNORATE_AR[city]}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── CART PAGE ────────────────────────────────────────────────────────────────
export function CartPage() {
  const { cart, removeFromCart, updateCartQty, cartTotal, cartSubtotal, cartDiscountAmount, setPage, appliedDiscount, applyDiscount, removeAppliedDiscount } = useStore();
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const total = cartTotal() ?? 0;
  const subtotal = cartSubtotal() ?? 0;
  const discountAmount = cartDiscountAmount() ?? 0;
  const safeCart = cart ?? [];

  React.useEffect(() => { setPageMeta({ title: 'Shopping Bag', description: 'Review your selected luxury pieces' }); }, []);

  const handleApplyCoupon = () => {
    setCouponError('');
    const cleanCoupon = (coupon ?? '').trim().toUpperCase();
    
    const result = applyDiscount(cleanCoupon);
    if (result.success) {
      toast(`Code ${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% off' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!
تم تطبيق الكود بنجاح!`, 'success');
    } else {
      setCouponError(result.error ?? 'Invalid code');
    }
  };

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px' }}>
        <motion.h1 initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }}
          style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400, letterSpacing: 2, marginBottom: 40 }}>Shopping Bag</motion.h1>

        {safeCart.length === 0 ? (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} style={{ textAlign: 'center', padding: '80px 0' }}>
            <ShoppingBag size={80} color="var(--border)" style={{ margin: '0 auto 24px', display: 'block' }} />
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginBottom: 8, color: 'var(--text2)' }}>Your bag is empty</p>
            <p style={{ color: 'var(--text3)', marginBottom: 32 }}>Explore our collection to find your next luxury piece</p>
            <button className="gold-btn" onClick={() => setPage('shop')}>Explore Collection</button>
          </motion.div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 40 }} className="cart-grid">
            <div>
              <AnimatePresence>
                {safeCart.map(item => (
                  <motion.div key={item?.key} layout initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0, height:0, overflow:'hidden' }}
                    style={{ display: 'flex', gap: 20, padding: '20px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ position:'relative', cursor:'pointer' }}>
                      <img src={item?.product?.images?.[0] ?? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="110" height="138"%3E%3Crect fill="%23ccc" width="110" height="138"/%3E%3C/svg%3E'} alt={item?.product?.name ?? 'Product'}
                        onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="110" height="138"%3E%3Crect fill="%23ccc" width="110" height="138"/%3E%3C/svg%3E'; }}
                        style={{ width: 110, height: 138, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} loading="lazy" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ color: 'var(--text3)', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>{item?.product?.category ?? 'General'}</p>
                      <p style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 500, marginBottom: 5 }}>{item?.product?.name ?? 'Unknown Product'}</p>
                      <p style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 12 }}>Size: {item?.size ?? 'N/A'} · Color: {item?.color ?? 'N/A'}</p>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 2 }}>
                          <button onClick={() => (item?.qty ?? 0) > 1 ? updateCartQty(item?.key, (item?.qty ?? 0) - 1) : removeFromCart(item?.key)}
                            style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer' }}>
                            <Minus size={12} />
                          </button>
                          <span style={{ padding: '0 10px', fontSize: 13, minWidth: 28, textAlign: 'center' }}>{item?.qty ?? 0}</span>
                          <button onClick={() => updateCartQty(item?.key, (item?.qty ?? 0) + 1)}
                            style={{ width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer' }}>
                            <Plus size={12} />
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                          <span style={{ color: '#b9a06c', fontSize: 15, fontWeight: 600 }}>EGP {(((item?.product?.salePrice || item?.product?.price) ?? 0) * (item?.qty ?? 0)).toLocaleString()}</span>
                          <button onClick={() => removeFromCart(item?.key)}
                            style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s' }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'var(--text3)'}><Trash2 size={15} /></button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            <div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 24, position: 'sticky', top: 100 }}>
                <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, marginBottom: 20 }}>Order Summary</h3>
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
                    <span style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>EGP {total.toLocaleString()}</span>
                  </div>
                </div>

                {!appliedDiscount ? (
                  <div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: couponError ? 6 : 14 }}>
                      <div style={{ position:'relative', flex:1 }}>
                        <Tag size={12} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text3)' }} />
                        <input value={coupon} onChange={e => { setCoupon(e.target.value); setCouponError(''); }}
                          onKeyDown={e => e.key === 'Enter' && handleApplyCoupon()}
                          placeholder="Discount code" style={{ width:'100%', paddingLeft:28, borderColor: couponError ? 'var(--red)' : undefined }} />
                      </div>
                      <button onClick={handleApplyCoupon}
                        style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)', padding: '10px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                        Apply
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
                    <span onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</span>
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
  } = useStore();
  const [form, setForm] = useState({ name: '', phone: '', phoneAlt: '', email: '', address: '', city: '', notes: '' });
  const [errors, setErrors] = useState({});
  const [stockErrors, setStockErrors] = useState([]);
  const [stockNotice, setStockNotice] = useState([]);
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [copied, setCopied] = useState(false); 

  // 🔒 الحارس الذري لمنع استدعاء الدالة مرتين بشكل متزامن في نفس الجزء من الثانية
  const isPlacingOrder = React.useRef(false);

  // 🔑 مفتاح idempotency ثابت لكل جلسة Checkout: يُعاد استخدامه عند إعادة
  // المحاولة بعد فشل الشبكة حتى لا يتكرر الطلب، ويُجدَّد تلقائيًا عند فتح
  // صفحة Checkout جديدة (أي سلة جديدة) — يمنع الازدواج على مستوى قاعدة البيانات.
  const idempotencyKey = React.useRef(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  ).current;

  const subtotal = cartSubtotal() ?? 0;
  const discountAmount = cartDiscountAmount() ?? 0;
  const safeCart = cart ?? []; 

  const shippingCost = getShippingCost(form.city);
  const finalTotal = subtotal + shippingCost - discountAmount;

  React.useEffect(() => { setPageMeta({ title: 'Checkout', description: 'Complete your order' }); }, []);
  React.useEffect(() => { refreshAppliedDiscount(); }, []);
  
  // 🔝 السكرول المبدئي عند فتح الصفحة لأول مرة
  React.useEffect(() => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }, []);

  // 🚀 سكرول لأعلى الصفحة فوراً عند نجاح الأوردر وتحديث الـ success state
  React.useEffect(() => {
    if (success) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [success]);

  const handleApplyCoupon = () => {
    setCouponError('');
    const cleanCoupon = (coupon ?? '').trim().toUpperCase();
    
    const result = applyDiscount(cleanCoupon);
    if (result.success) {
      toast(`${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% off' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!`, 'success');
    } else {
      setCouponError(result.error ?? 'Invalid code');
    }
  };

  const update = (k, v) => { 
    setForm(f => ({ ...f, [k]: v })); 
    setErrors(e => ({ ...e, [k]: null })); 
  };

  const validateOrderFormCustom = (fields) => {
    const errs = {};
    if (!fields.name || !fields.name.trim()) errs.name = 'Full name is required.\nهذا الحقل مطلوب.';
    else if (fields.name.trim().length < 2) errs.name = 'Please enter your full name (at least 2 characters).\nيرجى إدخال الاسم الكامل بشكل صحيح.';
    
    const egyptianPhoneRegex = /^01[0125][0-9]{8}$/;
    const normPhone = normalizeEgyptPhone(fields.phone);
    
    if (!fields.phone || !fields.phone.trim()) {
      errs.phone = 'Phone number is required.\nهذا الحقل مطلوب.';
    } else if (!egyptianPhoneRegex.test(normPhone)) {
      errs.phone = 'Invalid phone number. Must be 11 digits starting with 01.\nرقم الهاتف غير صحيح، يجب أن يبدأ بـ 01 ويتكون من 11 رقمًا.';
    }

    if (fields.phoneAlt && fields.phoneAlt.trim()) {
      const trimmedPhone = normPhone;
      const trimmedPhoneAlt = normalizeEgyptPhone(fields.phoneAlt);

      if (!egyptianPhoneRegex.test(trimmedPhoneAlt)) {
        errs.phoneAlt = 'Invalid alternative phone number. Must be 11 digits.\nرقم الهاتف البديل غير صحيح، يجب أن يتكون من 11 رقمًا.';
      } else if (trimmedPhone === trimmedPhoneAlt) {
        errs.phoneAlt = 'Alternative phone cannot be the same as the primary phone number.\nلا يمكن استخدام نفس رقم الهاتف الأساسي كرقم بديل.';
      }
    }

    if (fields.email && fields.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fields.email.trim())) {
        errs.email = 'Please enter a valid email address.\nيرجى إدخال بريد إلكتروني صحيح.';
      }
    }

    if (!fields.address || !fields.address.trim()) errs.address = 'Street address is required.\nهذا الحقل مطلوب.';
    else if (fields.address.trim().length < 5) errs.address = 'Please enter a complete street address (at least 5 characters).\nيرجى إدخال عنوان كامل (5 أحرف على الأقل).';
    if (!fields.city || !fields.city.trim() || fields.city === 'Select City' || !normalizeGovernorate(fields.city)) {
      errs.city = 'Please select your governorate from the list.\nيرجى اختيار المحافظة من القائمة.';
    }
    
    return errs;
  };

  const handleOrder = async () => {
    if (isPlacingOrder.current || submitting) return;

    const errs = validateOrderFormCustom(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    isPlacingOrder.current = true;
    setSubmitting(true);
    setStockErrors([]);
    setStockNotice([]);

    try {
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
        setStockErrors(result?.errors || ['Order failed. Please try again.']);

        // خفّض الكميات تلقائيًا حسب ما أخبرنا به السيرفر،
        // واعرض تنبيهًا بالعربي والإنجليزي يوضح التغيير.
        if (result?.stockIssues && result.stockIssues.length) {
          const { reduced, removed } = reduceCartForStockIssues(result.stockIssues);
          const notices = [];
          reduced.forEach(r => {
            notices.push(
              `تم تقليل كمية "${r.name}" تلقائياً من ${r.from} إلى ${r.to} قطعة. المتبقي حالياً: ${r.to} قطعة فقط. ` +
              `/ The quantity of "${r.name}" was automatically reduced from ${r.from} to ${r.to} — only ${r.to} left in stock.`
            );
          });
          removed.forEach(r => {
            notices.push(
              `تمت إزالة "${r.name}" من سلة التسوق تلقائياً لأن المخزون نفد. ` +
              `/ "${r.name}" was automatically removed from your bag because it's out of stock.`
            );
          });
          setStockNotice(notices);
          if (notices.length) toast(notices[0], 'info');
        } else {
          setStockNotice([]);
        }

        isPlacingOrder.current = false;
        setSubmitting(false);
        return;
      }

      // 🛑 تم حذف وإلغاء كود تكرار إرسال التليجرام من هنا نهائياً
      // العملية الآن تتم بأمان من داخل الـ Store لضمان إرسال رسالة واحدة فقط!

      setSuccess(result.order);
      setSubmitting(false);

    } catch (error) {
      console.error("Order completion failed logic:", error);
      const raw = error && error.message ? String(error.message) : '';
      setStockErrors([raw ? raw : ('Order failed. Please try again.')]);
      setStockNotice([]);
      isPlacingOrder.current = false;
      setSubmitting(false);
    }
  };
  
  if (success) {
  return (
    <div
      style={{
        background: '#080808',
        minHeight: 'calc(100vh - 90px)',
        padding: '85px 16px 70px',
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
            🎉! تم نسخ رقم الطلب بنجاح 
          </motion.div>
        )}
      </AnimatePresence>
      
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        style={{
          boxSizing: 'border-box',
          textAlign: 'center',
          padding: '48px 30px 40px',
          background: '#151515',
          border: '1px solid rgba(190, 157, 70, 0.30)',
          borderRadius: 12,
          maxWidth: 555,
          width: '100%',
          margin: '0 auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
          color: '#d0b56f',
        }}
      >
        {/* Success icon */}
        <motion.div
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5 }}
        >
          <CheckCircle
            size={76}
            color="#c9aa50"
            style={{
              display: 'block',
              margin: '0 auto 34px',
              strokeWidth: 1.7,
            }}
          />
        </motion.div>

        {/* Arabic confirmation */}
        <div style={{ marginBottom: 26 }}>
          <div style={{ marginBottom: 8 }}>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 27,
                lineHeight: 1.6,
                margin: '0 0 4px',
                color: '#d1b363',
                fontWeight: 700,
                letterSpacing: 0,
              }}
            >
            </h2>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 27,
                lineHeight: 1.6,
                margin: 0,
                color: '#d1b363',
                fontWeight: 700,
                direction: 'rtl',
                letterSpacing: 0,
              }}
            >
              تم تسجيل طلبك بنجاح !
            </h2>
          </div>

          <p
            style={{
              color: '#999999',
              fontSize: 14,
              margin: 0,
              textAlign: 'center',
              lineHeight: 1.9,
            }}
          >
            <br />
            <span style={{ direction: 'rtl' }}> ZASHM يسعدنا دائمًا اختيارك  </span>
          </p>
        </div>

        {/* Order reference */}
        <div
          style={{
            boxSizing: 'border-box',
            background: '#201e18',
            border: '1px dashed rgba(190, 157, 70, 0.48)',
            borderRadius: 10,
            padding: '21px 16px',
            marginBottom: 30,
            width: '100%',
          }}
        >
          <div
            style={{
              color: '#c9aa50',
              fontSize: 12,
              marginBottom: 12,
              textAlign: 'center',
              letterSpacing: 2,
              lineHeight: 1.9,
            }}
          >
            <div
              style={{
                direction: 'rtl',
                letterSpacing: 0,
              }}
            >
              الرقم المرجعي للطلب (ORDER ID)
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              flexWrap: 'wrap',
              direction: 'ltr',
            }}
          >
            <span
              style={{
                color: '#d1b363',
                fontSize: 'clamp(15px, 3.5vw, 21px)',
                fontWeight: 700,
                letterSpacing: 2,
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
                color: '#d1b363',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 6,
                borderRadius: 5,
                transition: 'color 0.25s ease, transform 0.25s ease',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#f0d78b';
                e.currentTarget.style.transform = 'scale(1.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#d1b363';
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
                width="22"
                height="22"
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

        {/* Divider */}
        <div
          style={{
            height: 1,
            background:
              'linear-gradient(90deg, transparent, rgba(190,157,70,0.55), transparent)',
            margin: '0 0 28px',
            width: '100%',
          }}
        />

        {/* Tracking section */}
        <div style={{ marginBottom: 30, textAlign: 'center' }}>
          <h4
            style={{
              fontFamily: 'var(--font-display)',
              color: '#c9aa50',
              fontSize: 14,
              letterSpacing: 5,
              textTransform: 'uppercase',
              margin: '0 0 14px',
              fontWeight: 500,
              lineHeight: 1.8,
            }}
          >
            TRACK YOUR ORDER
          </h4>

          <div
            style={{
              color: '#a5a5a5',
              fontSize: 13,
              lineHeight: 2,
              margin: '0 auto 25px',
              maxWidth: 420,
            }}
          >
            <div style={{ direction: 'rtl', marginTop: 6 }}>يمكنك الآن تتبع حالة شحنتك وخط سيرها بسهولة بالانتقال إلى صفحة <span style={{ color: '#d1b363', fontWeight: 600 }}>Track Your Order</span> باستخدام الرقم المرجعي الموضح أعلاه، أو عبر التواصل المباشر مع فريق الدعم الفني.</div>
          </div>

          {/* Two equal buttons on the same row */}
          <div
            data-order-actions="true"
            style={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'stretch',
              gap: 12,
              marginBottom: 20,
              width: '100%',
              direction: 'ltr',
            }}
          >
            <button
              type="button"
              onClick={() => {
                const url =
                  success.tracking_url ||
                  '/?track=' + encodeURIComponent(success.id);

                window.location.assign(url);
              }}
              style={{
                boxSizing: 'border-box',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: '20px 10px',
                minWidth: 0,
                flex: '1 1 0',
                borderRadius: 50,
                border: '1px solid #c9aa50',
                background:
                  'linear-gradient(135deg, #b89a43 0%, #d1b363 52%, #c4a44c 100%)',
                color: '#101010',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.1,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                textTransform: 'uppercase',
                cursor: 'pointer',
                boxShadow: '0 3px 12px rgba(0,0,0,0.12)',
                transition:
                  'background 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  'linear-gradient(135deg, #c9aa50 0%, #e0c779 55%, #d1b363 100%)';
                e.currentTarget.style.boxShadow =
                  '0 5px 18px rgba(201,170,80,0.22)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  'linear-gradient(135deg, #b89a43 0%, #d1b363 52%, #c4a44c 100%)';
                e.currentTarget.style.boxShadow =
                  '0 3px 12px rgba(0,0,0,0.12)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
              onFocus={(e) => {
                e.currentTarget.style.outline = '2px solid #e0c779';
                e.currentTarget.style.outlineOffset = '3px';
              }}
              onBlur={(e) => {
                e.currentTarget.style.outline = 'none';
              }}
            >
              <span aria-hidden="true">🔍</span> TRACK YOUR ORDER
            </button>

            <a
              href={
                'https://wa.me/201013380313?text=' +
                encodeURIComponent(
                  'مرحباً ZASHM، أود الاستفسار عن حالة طلبي ذو الرقم المرجعي: ' +
                    success.id
                )
              }
              target="_blank"
              rel="noopener noreferrer"
              style={{
                boxSizing: 'border-box',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: '20px 10px',
                minWidth: 0,
                flex: '1 1 0',
                borderRadius: 50,
                border: '1px solid #c9aa50',
                background:
                  'linear-gradient(135deg, #b89a43 0%, #d1b363 52%, #c4a44c 100%)',
                color: '#101010',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.1,
                lineHeight: 1.5,
                whiteSpace: 'nowrap',
                textDecoration: 'none',
                textTransform: 'uppercase',
                cursor: 'pointer',
                boxShadow: '0 3px 12px rgba(0,0,0,0.12)',
                transition:
                  'background 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  'linear-gradient(135deg, #c9aa50 0%, #e0c779 55%, #d1b363 100%)';
                e.currentTarget.style.boxShadow =
                  '0 5px 18px rgba(201,170,80,0.22)';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background =
                  'linear-gradient(135deg, #b89a43 0%, #d1b363 52%, #c4a44c 100%)';
                e.currentTarget.style.boxShadow =
                  '0 3px 12px rgba(0,0,0,0.12)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
              onFocus={(e) => {
                e.currentTarget.style.outline = '2px solid #e0c779';
                e.currentTarget.style.outlineOffset = '3px';
              }}
              onBlur={(e) => {
                e.currentTarget.style.outline = 'none';
              }}
            >
              <span aria-hidden="true">💬</span> CONTACT SUPPORT
            </a>
          </div>
        </div>

        {/* Continue shopping */}
        <button
          type="button"
          onClick={() => setPage('home')}
          style={{
            boxSizing: 'border-box',
            width: '100%',
            padding: '21px 12px',
            borderRadius: 50,
            fontWeight: 700,
            letterSpacing: 3,
            lineHeight: 1.6,
            textTransform: 'uppercase',
            background:
              'linear-gradient(100deg, #b89a43 0%, #d1b363 55%, #e0c779 100%)',
            color: '#101010',
            border: '1px solid rgba(224,199,121,0.35)',
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: '0 3px 12px rgba(0,0,0,0.12)',
            transition:
              'background 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background =
              'linear-gradient(100deg, #c9aa50 0%, #e0c779 55%, #f0d78b 100%)';
            e.currentTarget.style.boxShadow =
              '0 5px 20px rgba(201,170,80,0.23)';
            e.currentTarget.style.transform = 'translateY(-2px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background =
              'linear-gradient(100deg, #b89a43 0%, #d1b363 55%, #e0c779 100%)';
            e.currentTarget.style.boxShadow =
              '0 3px 12px rgba(0,0,0,0.12)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
          onFocus={(e) => {
            e.currentTarget.style.outline = '2px solid #e0c779';
            e.currentTarget.style.outlineOffset = '3px';
          }}
          onBlur={(e) => {
            e.currentTarget.style.outline = 'none';
          }}
        >
          CONTINUE SHOPPING
        </button>
      </motion.div>
    </div>
  );
}

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '40px 24px' }}>
        <motion.h1 initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }}
          style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400, letterSpacing: 2, marginBottom: 40 }}>{'Checkout'}</motion.h1>

        <AnimatePresence>
          {stockNotice.length > 0 && (
            <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }}
              style={{ background:'rgba(201,168,76,0.10)', border:'1px solid var(--border-gold)', borderRadius:6, padding:'14px 18px', marginBottom:16 }}>
              <p style={{ color:'var(--gold)', fontWeight:600, marginBottom:4, fontSize:13 }}>
                Your bag has been updated automatically.
              </p>
              <p style={{ color:'var(--gold)', fontWeight:600, marginBottom:8, fontSize:13, direction: 'rtl', textAlign: 'right' }}>
                تم تحديث سلة التسوق تلقائيًا.
              </p>
              {stockNotice.map((e, i) => {
                const s = String(e || '');
                const hasArabic = /[\u0600-\u06FF]/.test(s);
                if (hasArabic) {
                  const parts = s.split(/\n+/);
                  const en = parts.find(p => /^[A-Za-z]/.test(p.trim())) || parts[0];
                  const ar = parts.find(p => /[\u0600-\u06FF]/.test(p.trim())) || parts[parts.length-1];
                  return (
                    <div key={i} style={{ color:'var(--text)', fontSize:12, marginBottom:10, lineHeight:1.7 }}>
                      <div>{en}</div>
                      <div style={{ direction: 'rtl', textAlign: 'right' }}>{ar}</div>
                    </div>
                  );
                } else {
                  // English only - add Arabic if known
                  if (s.includes('updated automatically') || s.includes('bag has been updated')) {
                    return (
                      <div key={i} style={{ color:'var(--text)', fontSize:12, marginBottom:10, lineHeight:1.7 }}>
                        <div>{s}</div>
                        <div style={{ direction: 'rtl', textAlign: 'right' }}>تم تحديث سلة التسوق تلقائيًا.</div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} style={{ color:'var(--text)', fontSize:12, marginBottom:10, lineHeight:1.7 }}>
                      <div>{s}</div>
                    </div>
                  );
                }
              })}
            </motion.div>
          )}

          {stockErrors.length > 0 && (
            <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }}
              style={{ background:'rgba(192,57,43,0.08)', border:'1px solid rgba(192,57,43,0.3)', borderRadius:6, padding:'14px 18px', marginBottom:24 }}>
              <p style={{ color:'var(--red)', fontWeight:600, marginBottom:4, fontSize:13 }}>
                Stock availability issue:
              </p>
              <p style={{ color:'var(--red)', fontWeight:600, marginBottom:8, fontSize:13, direction: 'rtl', textAlign: 'right' }}>
                مشكلة في توفر المخزون:
              </p>
              {stockErrors.map((e, i) => {
                const s = String(e || '');
                const hasArabic = /[\u0600-\u06FF]/.test(s);
                if (hasArabic) {
                  const parts = s.split(/\n+/);
                  const en = parts.find(p => /^[A-Za-z]/.test(p.trim()));
                  const ar = parts.find(p => /[\u0600-\u06FF]/.test(p.trim())) || parts[parts.length-1];
                  if (en) {
                    return (
                      <div key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                        <div>• {en}</div>
                        <div style={{ direction: 'rtl' }}>• {ar}</div>
                      </div>
                    );
                  } else {
                    return (
                      <div key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                        <div>• There was a problem with your order.</div>
                        <div style={{ direction: 'rtl' }}>• {ar}</div>
                      </div>
                    );
                  }
                } else {
                  if (s.includes('Order failed')) {
                    return (
                      <div key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                        <div>• {s}</div>
                        <div style={{ direction: 'rtl' }}>• فشل الطلب. يرجى المحاولة مرة أخرى.</div>
                      </div>
                    );
                  }
                  if (s.includes('problem')) {
                    return (
                      <div key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                        <div>• {s}</div>
                        <div style={{ direction: 'rtl' }}>• حدث خطأ في عملية الطلب.</div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                      <div>• {s}</div>
                    </div>
                  );
                }
              })}
            </motion.div>
          )}
        </AnimatePresence>

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
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Full Name *'}</label>
                <input 
                  type="text" 
                  value={form.name ?? ''} 
                  onChange={e => update('name', e.target.value)} 
                  placeholder="John Doe"
                  style={{ width:'100%', borderColor: errors.name ? 'var(--red)' : undefined }} 
                />
                {errors.name && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.name}</p>}
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Phone Number *'}</label>
                <input 
                  type="tel" 
                  value={form.phone ?? ''} 
                  onChange={e => update('phone', e.target.value)} 
                  placeholder="01XXXXXXXXX"
                  style={{ width:'100%', borderColor: errors.phone ? 'var(--red)' : undefined }} 
                />
                {errors.phone && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.phone}</p>}
              </div>
            </div>

            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
              gap: 14, 
              marginBottom: 14,
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label style={{ 
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
                  type="tel" 
                  value={form.phoneAlt ?? ''} 
                  onChange={e => update('phoneAlt', e.target.value)} 
                  placeholder="01XXXXXXXXX"
                  style={{ width:'100%', borderColor: errors.phoneAlt ? 'var(--red)' : undefined }} 
                />
                {errors.phoneAlt && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.phoneAlt}</p>}
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label style={{ 
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
                  value={form.email ?? ''} 
                  onChange={e => update('email', e.target.value)} 
                  placeholder="your@email.com" 
                  style={{ width:'100%', borderColor: errors.email ? 'var(--red)' : undefined }} 
                  type="email" 
                />
                {errors.email && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.email}</p>}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Street Address *'}</label>
              <input 
                value={form.address ?? ''} 
                onChange={e => update('address', e.target.value)} 
                placeholder="Building no, Street name, Apartment..."
                style={{ width:'100%', borderColor: errors.address ? 'var(--red)' : undefined }} 
              />
              {errors.address && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.address}</p>}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
              <div>
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'City *'}</label>
                <CityAutocomplete
                  value={form.city}
                  onChange={v => update('city', v)}
                  onSelect={v => update('city', v)}
                  error={errors.city}
                />
                {errors.city && <p style={{ color:'var(--red)', fontSize:10, marginTop:3 }}>{errors.city}</p>}
              </div>
            </div>

            <div>
              <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>{'Order Notes (OPTIONAL)'}</label>
              <textarea 
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
                      <img src={i?.product?.images?.[0] ?? ''} alt="" onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.style.visibility = 'hidden'; }} style={{ width:40, height:50, objectFit:'cover', borderRadius:2, flexShrink:0 }} loading="lazy" />
                      <div>
                        <p style={{ fontSize:11, fontWeight:500, lineHeight:1.3 }}>{i?.product?.name ?? 'Unknown Product'}</p>
                        <p style={{ fontSize:10, color:'var(--text3)' }}>{i?.size ?? 'N/A'}/{i?.color ?? 'N/A'} ×{i?.qty ?? 0}</p>
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:600, color:'var(--gold)', whiteSpace:'nowrap', marginLeft: 'auto', textAlign: 'right' }}>
                      EGP {((((i?.product?.salePrice || i?.product?.price) ?? 0) * (i?.qty ?? 0))).toLocaleString()}
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
                        placeholder={'Discount code'} style={{ width:'100%', paddingLeft:28, borderColor: couponError ? 'var(--red)' : undefined }} />
                    </div>
                    <button onClick={handleApplyCoupon}
                      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)', padding: '10px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {'Apply'}
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
                  <span onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>{'Remove'}</span>
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
                      <div style={{ fontSize: '11px', marginTop: 2, letterSpacing: '1px' }}>جاري تنفيذ الطلب…</div>
                    </div>
                  </span>
                ) : (
                    <div style={{ textAlign: 'center', lineHeight: 1.2 }}>
                      <div>PLACE ORDER</div>
                      <div style={{ fontSize: '11px', marginTop: 2, letterSpacing: '1px' }}>تأكيد الطلب</div>
                    </div>
                  )}
              </motion.button>
              <div style={{ color: 'var(--text3)', fontSize: 10, textAlign: 'center', marginTop: 10, lineHeight: 1.6 }}>
                <div>🔒 Secure order · Your order will be confirmed via the website</div>
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

  React.useEffect(() => { setPageMeta({ title: 'Wishlist', description: 'Your saved luxury pieces' }); }, []);

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