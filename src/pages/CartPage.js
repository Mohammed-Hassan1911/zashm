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
                    <button onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</button>
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

// ─── CHECKOUT PAGE (MODIFIED FOR PRODUCTION ORDER TRACKING) ──────────────────────────────
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

  const subtotal = cartSubtotal() ?? 0;
  const discountAmount = cartDiscountAmount() ?? 0;
  const safeCart = cart ?? []; 

  const shippingCost = getShippingCost(form.city);
  const finalTotal = subtotal + shippingCost - discountAmount;

  React.useEffect(() => { setPageMeta({ title: 'Checkout', description: 'Complete your order' }); }, []);
  React.useEffect(() => { refreshAppliedDiscount(); }, []);
  React.useEffect(() => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }, []);

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

    // 🎯 دالة التحقق المحدثة لمنع تكرار نفس الرقم في الهاتف البديل
  const validateOrderFormCustom = (fields) => {
    const errs = {};
    if (!fields.name || !fields.name.trim()) errs.name = 'Full name is required';
    
    const egyptianPhoneRegex = /^01[0125][0-9]{8}$/;
    
    // فحص الهاتف الأساسي
    if (!fields.phone || !fields.phone.trim()) {
      errs.phone = 'Phone number is required';
    } else if (!egyptianPhoneRegex.test(fields.phone.trim())) {
      errs.phone = 'Invalid phone number. Must be 11 digits starting with 01';
    }

    // فحص الهاتف البديل
    if (fields.phoneAlt && fields.phoneAlt.trim()) {
      const trimmedPhone = fields.phone.trim();
      const trimmedPhoneAlt = fields.phoneAlt.trim();

      if (!egyptianPhoneRegex.test(trimmedPhoneAlt)) {
        errs.phoneAlt = 'Invalid alternative phone number. Must be 11 digits';
      } else if (trimmedPhone === trimmedPhoneAlt) {
        // 🛑 الشرط الجديد: منع تطابق الرقمين
        errs.phoneAlt = 'Alternative phone cannot be the same as the primary phone number';
      }
    }

    // فحص الإيميل
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
    const errs = validateOrderFormCustom(form);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }

    setSubmitting(true);
    setStockErrors([]);

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
    
    setSubmitting(false);

    if (!result || !result.success) {
      setStockErrors(result?.errors || ['Order failed. Please try again.']);
      return;
    }

    const orderId = result.order?.id || 'N/A';
    const trackingUrl = `${window.location.origin}/?track=${orderId}`;

    const orderItemsText = safeCart.map(i => {
      const price = ((i?.product?.salePrice || i?.product?.price) ?? 0);
      return `• *${i?.product?.name ?? 'Unknown'}* (${i?.size ?? 'N/A'}/${i?.color ?? 'N/A'}) x${i?.qty ?? 0} → _EGP ${(price * (i?.qty ?? 0)).toLocaleString()}_`;
    }).join('\n');

    const whatsappMessage = `
✨ *طلب جديد من متجر ZASHM* ✨
--------------------------------🟩

👤 *بيانات العميل:*
• *الاسم:* ${sanitizedCustomer}
• *رقم الهاتف الأساسي:* ${sanitizedPhone}
${sanitizedPhoneAlt ? `• *رقم الهاتف البديل:* ${sanitizedPhoneAlt}` : '• *رقم الهاتف البديل:* لا يوجد'}
• *البريد الإلكتروني:* ${sanitizedEmail || 'غير محدد'}

📍 *تفاصيل الشحن:*
• *المدينة:* ${form.city}
• *العنوان:* ${sanitizedAddress}
• *ملاحظات الطلب:* ${sanitizedNotes || 'لا توجد'}

🛍 *المنتجات المطلوبة:*
${orderItemsText}

--------------------------------🟨
💰 *الملخص المالي:*
• *المجموع الفرعي:* EGP ${subtotal.toLocaleString()}
• *قيمة الخصم:* EGP ${discountAmount.toLocaleString()}
• *مصاريف الشحن:* EGP ${shippingCost.toLocaleString()}
• *الإجمالي الكلي:* *EGP ${finalTotal.toLocaleString()}*

--------------------------------
🔗 *رابط تتبع الطلب الخاص بك:*
${trackingUrl}

--------------------------------
🔒 _رقم الطلب المرجعي: ${orderId}_
_تم إرسال الطلب تلقائياً وتأكيده بأمان عبر الموقع_
`.trim();

    const encodedMessage = encodeURIComponent(whatsappMessage);
    const whatsappNumber = "201013380313"; 

    const directWhatsappUrl = `https://api.whatsapp.com/send/?phone=${whatsappNumber}&text=${encodedMessage}&type=phone_number&app_absent=0`;
    
    window.open(directWhatsappUrl, '_blank');
    setSuccess(result.order);
  };

    if (success) return (
    <div style={{ paddingTop: 90, minHeight: '80vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <motion.div initial={{ opacity:0, scale:0.9 }} animate={{ opacity:1, scale:1 }}
        style={{ textAlign: 'center', padding: '60px 40px', background: 'var(--surface)', border: '1px solid var(--border-gold)', borderRadius: 8, maxWidth: 520, width: '100%' }}>
        <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ duration: 0.5 }}><CheckCircle size={64} color="#D4AF37" style={{ margin: '0 auto 16px' }} /></motion.div>      
        
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, marginBottom: 16, color: 'var(--gold)', letterSpacing: 1 }}>تم تسجيل طلبك بنجاح!</h2>
        
        <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24 }}>
          رقم الطلب المرجعي: <span style={{ fontFamily: 'monospace', color: 'var(--gold)', fontWeight: 600 }}>{success.id}</span>
        </p>

        <div style={{ background: 'rgba(212, 175, 55, 0.05)', border: '1px solid var(--border-gold)', borderRadius: 6, padding: '18px 20px', marginBottom: 32, textAlign: 'right', direction: 'rtl' }}>
          <p style={{ color: 'var(--text)', fontSize: 14, fontWeight: 600, marginBottom: 8, lineHeight: 1.5 }}>💡 ملاحظة لتسريع شحن طلبك:</p>
          <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            يُرجى الضغط على زر <strong style={{ color: 'var(--gold)' }}>"إرسال" (Send)</strong> في تطبيق الواتساب الذي فُتح لك تلقائياً؛ لمساعدتنا في تأكيد بياناتك وبدء تجهيز الشحنة فوراً.
            
            {/* 🎯 تعديل التباين والوضوح هنا */}
            <span style={{ 
              display: 'block', 
              marginTop: 12, 
              paddingTop: 10,
              borderTop: '1px dashed rgba(212, 175, 55, 0.2)',
              color: 'var(--text)', // خليناه نفس وضوح النص الأساسي بدلاً من الباهت
              fontSize: 12,
              fontWeight: 500 // زيادة السمك بسيطة لسهولة القراءة
            }}>
              📌 يمكنك تتبع حالة الشحنة مباشرةً في أي وقت من خلال <strong style={{ color: 'var(--gold)' }}>رابط التتبع</strong> المرفق مع رسالة الواتساب.
            </span>
          </p>
        </div>

        <button className="gold-btn" style={{ width: '100%' }} onClick={() => setPage('home')}>Continue Shopping</button>
      </motion.div>
    </div>
  );
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
                {/* 🎯 حقل الإيميل الذكي مع قلب الحواف للون الأحمر عند الخطأ برمجياً */}
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
                  <button onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</button>
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
              
              <motion.button className="gold-btn" style={{ width: '100%', marginTop: 16, opacity: submitting ? 0.7 : 1 }}
                onClick={handleOrder} disabled={submitting} whileTap={{ scale: 0.98 }}>
                {submitting ? (
                  <span style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}>
                    <motion.div animate={{ rotate:360 }} transition={{ duration:1, repeat:Infinity, ease:'linear' }}
                      style={{ width:14, height:14, border:'2px solid var(--bg)', borderTopColor:'transparent', borderRadius:'50%' }} />
                    Placing Order...
                  </span>
                ) : 'Place Order via WhatsApp'}
              </motion.button>
              <p style={{ color: 'var(--text3)', fontSize: 10, textAlign: 'center', marginTop: 10 }}>
                🔒 طلب آمن · سيتم تحويلك لتأكيد الطلب عبر الواتساب
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