import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, ShoppingBag, Heart, Plus, Minus, Tag, Check, AlertCircle, CheckCircle } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import { validateOrderForm, sanitizeInput, setPageMeta } from '../lib/security';
import { filterGovernorates, getShippingCost } from '../lib/egyptCities'; 

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
        placeholder="Cairo"
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
      if (typeof toast !== 'undefined') {
        toast(`${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% off' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!`, 'success');
      } else {
        console.log('Coupon applied successfully');
      }
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
                        style={{ width: 110, height: 138, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} loading="lazy" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ color: 'var(--text3)', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 }}>{item?.product?.category ?? 'General'}</p>
                      <p style={{ fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 500, marginBottom: 5 }}>{item?.product?.name ?? 'Unknown Product'}</p>
                      <p style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 12 }}>Size: {item?.size ?? 'N/A'} · Color: {item?.color ?? 'N/A'}</p>
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
                          <span style={{ color: 'var(--gold)', fontSize: 15, fontWeight: 600 }}>EGP {(((item?.product?.salePrice || item?.product?.price) ?? 0) * (item?.qty ?? 0)).toLocaleString()}</span>
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
      <style>{`@media (max-width: 768px) { .cart-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

// ─── CHECKOUT PAGE (MODIFIED FOR PRODUCTION ORDER TRACKING & TELEGRAM BOT) ──────────────────────────────
export function CheckoutPage() {
  const {
    cart, cartTotal, cartSubtotal, cartDiscountAmount, placeOrder, setPage,
    appliedDiscount, applyDiscount, removeAppliedDiscount, refreshAppliedDiscount,
  } = useStore();
  
  const [form, setForm] = useState({ name: '', phone: '', phoneAlt: '', email: '', address: '', city: '', notes: '' });
  const [errors, setErrors] = useState({});
  const [stockErrors, setStockErrors] = useState([]);
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [copied, setCopied] = useState(false); 

  // 🔒 الحارس الذري لمنع استدعاء الدالة مرتين بشكل متزامن في نفس الجزء من الثانية
  const isPlacingOrder = React.useRef(false);

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
      if (typeof toast !== 'undefined') {
        toast(`${result.discount?.code ?? 'Code'} applied — ${(result.discount?.type ?? 'percentage') === 'percentage' ? (result.discount?.value ?? 0) + '% off' : 'EGP ' + (result.discount?.value ?? 0) + ' off'}!`, 'success');
      } else {
        console.log('Coupon applied successfully');
      }
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
    if (!fields.name || !fields.name.trim()) errs.name = 'Full name is required';
    
    const egyptianPhoneRegex = /^01[0125][0-9]{8}$/;
    
    if (!fields.phone || !fields.phone.trim()) {
      errs.phone = 'Phone number is required';
    } else if (!egyptianPhoneRegex.test(fields.phone.trim())) {
      errs.phone = 'Invalid phone number. Must be 11 digits starting with 01';
    }

    if (fields.phoneAlt && fields.phoneAlt.trim()) {
      const trimmedPhone = fields.phone.trim();
      const trimmedPhoneAlt = fields.phoneAlt.trim();

      if (!egyptianPhoneRegex.test(trimmedPhoneAlt)) {
        errs.phoneAlt = 'Invalid alternative phone number. Must be 11 digits';
      } else if (trimmedPhone === trimmedPhoneAlt) {
        errs.phoneAlt = 'Alternative phone cannot be the same as the primary phone number';
      }
    }

    if (fields.email && fields.email.trim()) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fields.email.trim())) {
        errs.email = 'Please enter a valid email address (e.g., name@example.com)';
      }
    }

    if (!fields.address || !fields.address.trim()) errs.address = 'Street address is required';
    if (!fields.city || !fields.city.trim() || fields.city === 'Select City') errs.city = 'City is required';
    
    return errs;
  };

  const handleOrder = async () => {
    if (isPlacingOrder.current || submitting) return;

    const errs = validateOrderFormCustom(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    isPlacingOrder.current = true;
    setSubmitting(true);
    setStockErrors([]);

    try {
      const sanitizedCustomer = sanitizeInput(form.name.trim());
      const sanitizedPhone = form.phone.trim();
      const sanitizedPhoneAlt = form.phoneAlt ? form.phoneAlt.trim() : ''; 
      const sanitizedEmail = sanitizeInput(form.email.trim());
      const sanitizedAddress = sanitizeInput(form.address.trim());
      const sanitizedNotes = sanitizeInput(form.notes.trim());

      const result = await placeOrder({ 
        customer: sanitizedCustomer, 
        phone: sanitizedPhone,
        phoneAlt: sanitizedPhoneAlt, 
        email: sanitizedEmail, 
        address: sanitizedAddress, 
        city: form.city, 
        shippingCost: shippingCost,
        notes: sanitizedNotes,       
        total: finalTotal
      });

      if (!result || !result.success) {
        setStockErrors(result?.errors || ['Order failed. Please try again.']);
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
      isPlacingOrder.current = false;
      setSubmitting(false);
    }
  };
  
  if (success) {
    return (
      <div style={{ paddingTop: 160, paddingBottom: 60, minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: '20px', paddingRight: '20px', position: 'relative' }}>
        
        <AnimatePresence>
          {copied && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }} 
              animate={{ opacity: 1, y: 0 }} 
              exit={{ opacity: 0, y: -20 }}
              style={{
                position: 'fixed',
                top: '40px',
                backgroundColor: 'var(--gold, #D4AF37)',
                color: '#000000',
                padding: '12px 24px',
                borderRadius: '30px',
                fontWeight: '600',
                fontSize: '14px',
                boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
                zIndex: 9999,
                direction: 'rtl'
              }}
            >
              تم نسخ رقم الطلب بنجاح! 🎉
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div initial={{ opacity:0, scale:0.9 }} animate={{ opacity:1, scale:1 }}
          style={{ textAlign: 'center', padding: '50px 30px', background: 'var(--surface)', border: '1px solid var(--border-gold)', borderRadius: 12, maxWidth: 520, width: '100%', boxShadow: '0 10px 30px rgba(0,0,0,0.2)' }}>
          
          <motion.div animate={{ scale: [1, 1.15, 1] }} transition={{ duration: 0.5 }}>
            <CheckCircle size={72} color="#D4AF37" style={{ margin: '0 auto 20px' }} />
          </motion.div>      
          
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 28, marginBottom: 12, color: 'var(--gold)', letterSpacing: 0.5 }}>
             ! تم تسجيل طلبك بنجاح
          </h2>
          
          <p style={{ color: 'var(--text2)', fontSize: 15, marginBottom: 24 }}>
           ZASHM يسعدنا دائماً اختيارك
          </p>
          <div style={{ background: 'rgba(212, 175, 55, 0.04)', border: '1px dashed var(--border-gold)', borderRadius: 8, padding: '20px', marginBottom: 28, position: 'relative' }}>
            <span style={{ 
              display: 'block', 
              color: 'var(--text2)', // 🔥 غيرنا اللون لدرجة أنصع وأوضح
              fontSize: 13,          // 📐 تكبير حجم الخط درجة واحدة لزيادة الوضوح
              fontWeight: 700,       // 💪 جعل الخط Bold (عريض وقوي)
              textTransform: 'uppercase', 
              marginBottom: 8, 
              letterSpacing: 1 
            }}>
              الرقم المرجعي للطلب (Order ID)
            </span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <h3 style={{ fontFamily: 'monospace', color: 'var(--gold)', fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: 1 }}>
                {success.id}
              </h3>
              <button 
                onClick={() => {
                  navigator.clipboard.writeText(success.id);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 4, fontSize: '18px' }}
                title="Copy Order ID"
              >
                📋
              </button>
            </div>
          </div>

                    {/* 📦 قسم تتبع الطلب الاحترافي المتكامل مع موقعك والدعم */}
          <div style={{ 
            borderTop: '1px solid rgba(212, 175, 55, 0.15)', 
            paddingTop: 24, 
            marginBottom: 32, 
            textAlign: 'center' 
          }}>
            <h4 style={{ 
              fontFamily: 'var(--font-display)', 
              color: 'var(--gold)', 
              fontSize: 14, 
              letterSpacing: 1.5, 
              textTransform: 'uppercase', 
              marginBottom: 10 
            }}>
              Track Your Order
            </h4>
            
            <p style={{ 
              color: 'var(--text2)', 
              fontSize: 13, 
              lineHeight: 1.6, 
              margin: '0 auto 20px', 
              maxWidth: '440px',
              direction: 'rtl' 
            }}>
              يمكنك الآن تتبع حالة شحنتك وخط سيرها بسهولة بالانتقال إلى صفحة <strong style={{ color: 'var(--gold)' }}>Track Your Order</strong> باستخدام الرقم المرجعي الموضح أعلاه، أو عبر التواصل المباشر مع فريق الدعم الفني.
            </p>

            {/* الأزرار التفاعلية المزدوجة */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'center', 
              gap: '12px', 
              flexWrap: 'wrap' 
            }}>
              {/* زر التوجيه لصفحة التتبع بالموقع */}
              <button 
                onClick={() => setPage('track')} // يفترض أن اسم الصفحة بالـ store لديك هو 'track' أو غيرها حسب الـ routing عندك
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '12px 24px',
                  borderRadius: '30px',
                  border: '1px solid var(--gold)',
                  background: 'var(--gold)',
                  color: '#000000',
                  fontSize: '12px',
                  fontWeight: '700',
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  transition: 'all 0.3s ease',
                  cursor: 'pointer'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--gold)';
                  e.currentTarget.style.boxShadow = '0 4px 15px rgba(212, 175, 55, 0.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--gold)';
                  e.currentTarget.style.color = '#000000';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                🔍 Track Your Order
              </button>

                            {/* زر التواصل الاحتياطي مع الدعم الفني */}
                            {/* زر التواصل الاحتياطي مع الدعم الفني */}
              <a 
                href={`https://wa.me/201013380313?text=${encodeURIComponent(`مرحباً ZASHM، أود الاستفسار عن حالة طلبي ذو الرقم المرجعي: ${success.id}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '12px 24px',
                  borderRadius: '30px',
                  border: '1px solid var(--gold)',
                  background: 'var(--gold)', // اللون الأصفر مثبت افتراضياً
                  color: '#000000',          // الخط أسود افتراضياً
                  fontSize: '12px',
                  fontWeight: '600',
                  letterSpacing: '1px',
                  textDecoration: 'none',
                  textTransform: 'uppercase',
                  transition: 'all 0.3s ease',
                  cursor: 'pointer'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'transparent'; // يفرغ ويبقى شفاف لما تقف بالماوس
                  e.currentTarget.style.color = 'var(--gold)';      // الخط يتحول للذهبي
                  e.currentTarget.style.boxShadow = '0 4px 15px rgba(212, 175, 55, 0.15)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--gold)'; // يرجع أصفر لما تشيل الماوس
                  e.currentTarget.style.color = '#000000';          // الخط يرجع أسود
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                💬 Contact Support
              </a>
            </div>
          </div>

          <button 
            className="gold-btn" 
            style={{ width: '100%', padding: '14px', borderRadius: 6, fontWeight: 600, letterSpacing: 0.5 }} 
            onClick={() => setPage('home')}
          >
            Continue Shopping
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 940, margin: '0 auto', padding: '40px 24px' }}>
        <motion.h1 initial={{ opacity:0, y:16 }} animate={{ opacity:1, y:0 }}
          style={{ fontFamily: 'var(--font-display)', fontSize: 40, fontWeight: 400, letterSpacing: 2, marginBottom: 40 }}>Checkout</motion.h1>

        <AnimatePresence>
          {stockErrors.length > 0 && (
            <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }}
              style={{ background:'rgba(192,57,43,0.08)', border:'1px solid rgba(192,57,43,0.3)', borderRadius:6, padding:'14px 18px', marginBottom:24 }}>
              <p style={{ color:'var(--red)', fontWeight:600, marginBottom:8, fontSize:13 }}>⚠ Stock issues detected:</p>
              {stockErrors.map((e, i) => <p key={i} style={{ color:'var(--red)', fontSize:12, marginBottom:2 }}>• {e}</p>)}
            </motion.div>
          )}
        </AnimatePresence>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 40 }} className="checkout-grid">
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 28 }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 20, marginBottom: 22 }}>Delivery Information</h3>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', 
              gap: 14, 
              marginBottom: 14 
            }}>
              <div>
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>Full Name *</label>
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
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>Phone Number *</label>
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
                  Alternative Phone (Optional)
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
                  Email Address (Optional)
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
              <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>Street Address *</label>
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
                <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>City *</label>
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
              <label style={{ display:'block', fontSize:10, letterSpacing:1.5, color:'var(--text3)', marginBottom:6, textTransform:'uppercase' }}>Order Notes</label>
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
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 18, marginBottom: 16 }}>Order Summary</h3>
              <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 14 }}>
                {safeCart.map(i => (
                  <div key={i?.key} style={{ display: 'flex', gap:10, justifyContent: 'space-between', marginBottom: 10, alignItems:'flex-start', width: '100%' }}>
                    <div style={{ display:'flex', gap:8 }}>
                      <img src={i?.product?.images?.[0] ?? ''} alt="" style={{ width:40, height:50, objectFit:'cover', borderRadius:2, flexShrink:0 }} loading="lazy" />
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
                        placeholder="Discount code" style={{ width:'100%', paddingLeft:28, borderColor: couponError ? 'var(--red)' : undefined }} />
                    </div>
                    <button onClick={handleApplyCoupon}
                      style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)', padding: '10px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                      Apply
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
                  <span onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</span>
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
                    Placing Order...
                  </span>
                ) : 'Place Order'}
              </motion.button>
              <p style={{ color: 'var(--text3)', fontSize: 10, textAlign: 'center', marginTop: 10 }}>
                🔒 طلب آمن · سيتم تسجيل طلبك وتأكيده فوراً عبر الموقع
              </p>
            </div>
          </div>
        </div>
      </div>
      <style>{`@media (max-width: 768px) { .checkout-grid { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

// ─── WISHLIST PAGE ────────────────────────────────────────────────────────────
export function WishlistPage() {
  const { products, wishlist, setPage } = useStore();
  const wished = products.filter(p => wishlist.includes(p.id));

  React.useEffect(() => { setPageMeta({ title: 'Wishlist', description: 'Your saved luxury pieces' }); }, []);

  return (
    <div style={{ paddingTop: 90, minHeight: '80vh' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <p style={{ fontSize: 10, letterSpacing: 4, color: 'var(--gold)', textTransform: 'uppercase', marginBottom: 8 }}>Saved</p>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 48, fontWeight: 400 }}>Wishlist</h1>
          <p style={{ color: 'var(--text3)', marginTop: 8 }}>{wished.length} item{wished.length !== 1 ? 's' : ''} saved</p>
        </div>
        {wished.length === 0 ? (
          <motion.div initial={{ opacity:0 }} animate={{ opacity:1 }} style={{ textAlign: 'center', padding: '60px 0' }}>
            <Heart size={80} color="var(--border)" style={{ margin: '0 auto 24px', display: 'block' }} />
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 24, marginBottom: 8, color: 'var(--text2)' }}>Nothing saved yet</p>
            <p style={{ color: 'var(--text3)', marginBottom: 32 }}>Save your favourite pieces for later</p>
            <button className="gold-btn" onClick={() => setPage('shop')}>Explore Collection</button>
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