import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, ShoppingBag, Truck, RotateCcw, Shield, ChevronLeft, ChevronRight, AlertTriangle, X } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import { PageBack } from '../components/ui/BackToTop';

// 🛠️ التعديل: تم حذف الـ Import الخاطئ لـ toast وتأمين عمله
// إذا كنت تستخدم مكتبة خارجية مثل react-hot-toast فقم بفك التعليق عن السطر التالي:
// import { toast } from 'react-hot-toast'; 

export default function ProductPage() {
  const { selectedProduct: p, addToCart, toggleWishlist, wishlist, products, setPage, addRecentlyViewed } = useStore();
  const [selSize, setSelSize] = useState('');
  const [selColor, setSelColor] = useState('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [tab, setTab] = useState('description');

  // ستايت التحكم في مودال المخزون ومودال دليل المقاسات
  const [stockModal, setStockModal] = useState({ open: false, message: '' });
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);

  // مرجع لحفظ الـ ID الحالي لمنع التحديث المزدوج العشوائي الذي يسبب اختفاء الصورة
  const lastProductIdRef = useRef(null);

  // تأمين مصفوفة الصور لتجنب الكراش في حال عدم وجود صور للمنتج
  const productImages = p?.images && p.images.length > 0 ? p.images : ['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect fill="%23222" width="300" height="400"/%3E%3C/svg%3E'];

  // 🎯 ذكاء اصطناعي لاختيار أول مقاس ولون متوفرين أول ما الصفحة تفتح - تم التأمين ضد الاختفاء المزدوج 🚀
  useEffect(() => {
    if (p) {
      // إذا كان المنتج هو نفسه ولم يتغير فعلياً، لا تقم بتصفير الحقول أو الصور لكسر الأنيميشن والاختفاء
      if (lastProductIdRef.current === p.id) return;
      lastProductIdRef.current = p.id;

      // 🚀 حل مشكلة الـ Scroll: أول ما المنتج يتغير، الصفحة تطلع فوق فوراً من البداية
      window.scrollTo(0, 0);

      let foundAvailable = false;
      const pSizes = p.sizes || [];
      const pColors = p.colors || [];

      if (p.variantStock) {
        for (const size of pSizes) {
          for (const color of pColors) {
            if ((p.variantStock[`${size}-${color}`] || 0) > 0) {
              setSelSize(size);
              setSelColor(color);
              foundAvailable = true;
              break;
            }
          }
          if (foundAvailable) break;
        }
      }

      if (!foundAvailable) {
        setSelSize(pSizes[0] || '');
        setSelColor(pColors[0] || '');
      }
      setQty(1);
      setImgIdx(0);
    }
  }, [p]);

  // 🎯 تأثير جانبي لتسجيل المنتج في قائمة "المشاهدة مؤخراً" عند فتح الصفحة
  useEffect(() => {
    if (p && typeof addRecentlyViewed === 'function') {
      addRecentlyViewed(p.id);
    }
  }, [p, addRecentlyViewed]);

  if (!p) return (
    <div style={{ paddingTop: 120, textAlign: 'center', padding: '120px 24px' }}>
      <p style={{ color: 'var(--text2)' }}>No product selected.</p>
      <button className="gold-btn" style={{ marginTop: 24 }} onClick={() => setPage('shop')}>Back to Shop</button>
    </div>
  );

  const isWished = (wishlist || []).includes(p.id);
  const related = (products || []).filter(pr => pr.active !== false && (pr.category ?? 'General') === (p.category ?? 'General') && pr.id !== p.id).slice(0, 4);
  const discount = p.salePrice ? Math.round((1 - (p.salePrice ?? 0) / (p.price ?? 0)) * 100) : null;

  const currentVariantKey = `${selSize}-${selColor}`;
  const currentVariantStock = p.variantStock ? (p.variantStock[currentVariantKey] || 0) : (p.stock ?? 0);
  const isOutOfStock = currentVariantStock <= 0;

  // دالة داخلية بديلة للـ toast لحماية الكود من الانهيار إذا لم تكن المكتبة مثبتة
  const showToast = (msg, type) => {
    if (typeof toast !== 'undefined') {
      toast(msg, type);
    } else {
      alert(`${type.toUpperCase()}: ${msg}`); // Fallback آمن للمطورين
    }
  };

  const handleAddToCart = () => {
    if (!selSize) { showToast('Please select a size', 'error'); return; }
    if (!selColor) { showToast('Please select a color', 'error'); return; }
    if (qty > currentVariantStock) {
      setStockModal({ open: true, message: `Sorry, only ${currentVariantStock} pieces are available for Size: ${selSize} / Color: ${selColor}.` });
      return;
    }
    
    const result = addToCart(p, selSize, selColor, qty);
    
    if (result && result.success) {
      showToast(`${p.name ?? 'Product'} added to your bag!`, 'success');
    } else {
      setStockModal({ open: true, message: result?.error || "Requested quantity is not available." });
    }
  };

  return (
    <div style={{ paddingTop: 90 }}>
      <div style={{ maxWidth: 1300, margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: 16 }}>
          <PageBack />
        </div>
        {/* Breadcrumb */}
        <motion.div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 32 }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
          <button onClick={() => setPage('home')} style={{ color: 'var(--text3)', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>Home</button>
          <span style={{ color: 'var(--text3)' }}>/</span>
          <button onClick={() => setPage('shop')} style={{ color: 'var(--text3)', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer' }}>Shop</button>
          <span style={{ color: 'var(--text3)' }}>/</span>
          <span style={{ color: 'var(--text2)', fontSize: 12 }}>{p.name}</span>
        </motion.div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64 }} className="product-grid">
          {/* Images */}
          <motion.div initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6 }}>
            <div style={{ position: 'relative', aspectRatio: '3/4', overflow: 'hidden', borderRadius: 2, cursor: 'zoom-in' }}>
              <AnimatePresence mode="wait">
                <motion.img key={imgIdx}
                  src={productImages[imgIdx]}
                  alt={p.name}
                  initial={{ opacity: 0, scale: 1.05 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.4 }}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </AnimatePresence>
              {p.label && (
                <div style={{ position: 'absolute', top: 16, left: 16 }}>
                  <span 
                    style={{
                      display: 'inline-block',
                      background: 'rgba(10, 10, 10, 0.85)',
                      color: p.label === 'Limited Edition' || p.label === 'Best Seller' ? '#e74c3c' : 'var(--gold, #c9a84c)',
                      border: `1px solid ${p.label === 'Limited Edition' || p.label === 'Best Seller' ? '#e74c3c' : 'var(--gold, #c9a84c)'}`,
                      fontSize: 10,
                      fontWeight: 600,
                      padding: '4px 10px',
                      borderRadius: 2,
                      textTransform: 'uppercase',
                      letterSpacing: 1
                    }}
                  >
                    {p.label}
                  </span>
                </div>
              )}
              {productImages.length > 1 && (
                <>
                  <button onClick={() => setImgIdx((imgIdx - 1 + productImages.length) % productImages.length)}
                    style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', width: 36, height: 36, borderRadius: '50%', background: 'rgba(10,10,10,0.7)', border: 'none', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    <ChevronLeft size={16} />
                  </button>
                  <button onClick={() => setImgIdx((imgIdx + 1) % productImages.length)}
                    style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', width: 36, height: 36, borderRadius: '50%', background: 'rgba(10,10,10,0.7)', border: 'none', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    <ChevronRight size={16} />
                  </button>
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              {productImages.length > 1 && productImages.map((img, i) => (
                <motion.div key={i} onClick={() => setImgIdx(i)}
                  style={{ width: 80, height: 100, cursor: 'pointer', borderRadius: 1, overflow: 'hidden', border: `2px solid ${imgIdx === i ? 'var(--gold)' : 'transparent'}`, transition: 'border-color 0.2s' }}
                  whileHover={{ scale: 1.05 }}>
                  <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </motion.div>
              ))}
            </div>
          </motion.div>

          {/* Details */}
          <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, delay: 0.1 }}>
            <p style={{ color: 'var(--text3)', fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 }}>{p.category}</p>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 400, marginBottom: 16, lineHeight: 1.2 }}>{p.name}</h1>

            {/* Price */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, color: 'var(--gold)' }}>
                EGP {(p.salePrice || p.price).toLocaleString()}
              </span>
              {p.salePrice && (
                <>
                  <span style={{ color: 'var(--text3)', fontSize: 18, textDecoration: 'line-through' }}>EGP {p.price.toLocaleString()}</span>
                  <span style={{ background: 'var(--red)', color: 'white', fontSize: 11, padding: '3px 8px', borderRadius: 2, fontWeight: 700 }}>-{discount}%</span>
                </>
              )}
            </div>

            {/* Colors */}
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, letterSpacing: 2, color: 'var(--text2)', textTransform: 'uppercase', marginBottom: 10 }}>Color: <span style={{ color: 'var(--text)' }}>{selColor}</span></p>
              <div style={{ display: 'flex', gap: 8 }}>
                {(p.colors || []).map(c => {
                  const isColorOOS = p.variantStock ? !(p.sizes || []).some(s => (p.variantStock[`${s}-${c}`] || 0) > 0) : false;
                  
                  return (
                    <button key={c} onClick={() => { setSelColor(c); setQty(1); }}
                      style={{ padding: '6px 14px', borderRadius: 2, fontSize: 11, fontWeight: 500, border: `2px solid ${selColor === c ? 'var(--gold)' : 'var(--border)'}`, background: selColor === c ? 'rgba(201,168,76,0.1)' : 'transparent', color: selColor === c ? 'var(--gold)' : 'var(--text2)', cursor: 'pointer', transition: 'all 0.2s', opacity: isColorOOS ? 0.4 : 1 }}>
                      {c} {isColorOOS && '(OOS)'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sizes */}
<div style={{ marginBottom: 28 }}>
  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
    <p style={{ fontSize: 11, letterSpacing: 2, color: 'var(--text2)', textTransform: 'uppercase' }}>Size: <span style={{ color: 'var(--text)' }}>{selSize}</span></p>
    <button 
      onClick={() => setSizeGuideOpen(true)}
      style={{ color: 'var(--gold)', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', letterSpacing: 1 }}
    >
      Size Guide
    </button>
  </div>
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    {(p.sizes || []).map(s => {
      // تحويل الطرفين لنصوص لضمان دقة المقارنة والاختيار
      const isSelected = String(selSize) === String(s);
      const isSizeOOSWithSelectedColor = p.variantStock ? (p.variantStock[`${s}-${selColor}`] || 0) <= 0 : false;

      return (
        <motion.button 
          key={s} 
          type="button" // يمنع أي تعليق أو تداخل مع الفورم
          onClick={() => { setSelSize(s); setQty(1); }}
          style={{ 
            width: 48, height: 48, borderRadius: 2, fontSize: 12, fontWeight: 600, 
            border: `2px solid ${isSelected ? 'var(--gold)' : 'var(--border)'}`, 
            background: isSelected ? 'rgba(201,168,76,0.1)' : 'transparent', 
            color: isSelected ? 'var(--gold)' : 'var(--text2)', 
            cursor: 'pointer',
            textDecoration: isSizeOOSWithSelectedColor ? 'line-through' : 'none',
            opacity: isSizeOOSWithSelectedColor ? 0.4 : 1 
          }}
          // ترك الأنميشن بالكامل لـ Framer Motion لمنع أي تعليق فلاشي
          animate={{ borderColor: isSelected ? 'var(--gold)' : 'var(--border)' }}
          transition={{ duration: 0.1 }}
          whileHover={{ borderColor: 'var(--gold)' }} 
          whileTap={{ scale: 0.95 }}
        >
          {s}
        </motion.button>
      );
    })}
  </div>
</div>

            {/* Qty + Add */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 2, opacity: isOutOfStock ? 0.5 : 1, pointerEvents: isOutOfStock ? 'none' : 'auto' }}>
                <button onClick={() => setQty(Math.max(1, qty - 1))}
                  style={{ width: 44, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>−</button>
                <span style={{ width: 40, textAlign: 'center', fontSize: 14, fontWeight: 600 }}>{qty}</span>
                <button onClick={() => setQty(Math.min(currentVariantStock, qty + 1))}
                  style={{ width: 44, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>+</button>
              </div>
              
              <motion.button 
                className="gold-btn" 
                style={{ 
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  background: isOutOfStock ? '#333' : 'var(--gold)',
                  color: isOutOfStock ? '#888' : 'white',
                  borderColor: isOutOfStock ? '#444' : 'var(--gold)',
                  cursor: isOutOfStock ? 'not-allowed' : 'pointer'
                }}
                onClick={handleAddToCart} 
                disabled={isOutOfStock}
                whileTap={isOutOfStock ? {} : { scale: 0.98 }}
              >
                <ShoppingBag size={16} /> {isOutOfStock ? 'OUT OF STOCK' : 'ADD TO BAG'}
              </motion.button>

              <motion.button
                onClick={() => toggleWishlist(p.id)}
                style={{ width: 52, height: 52, borderRadius: 2, border: `2px solid ${isWished ? '#e74c3c' : 'var(--border)'}`, background: 'transparent', color: isWished ? '#e74c3c' : 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Heart size={18} fill={isWished ? '#e74c3c' : 'none'} />
              </motion.button>
            </div>

            <p style={{ color: isOutOfStock ? '#e74c3c' : currentVariantStock > 5 ? 'var(--green)' : '#f39c12', fontSize: 12, marginBottom: 24, fontWeight: 600 }}>
              {isOutOfStock 
                ? `✕ This variant (${selSize} - ${selColor}) is currently sold out!` 
                : currentVariantStock > 5 
                  ? `✓ In stock (${currentVariantStock} available for this selection)` 
                  : `⚠ Only ${currentVariantStock} left in stock for this selection!`}
            </p>

            {/* Features */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14, marginBottom: 28, background: 'rgba(255,255,255,0.02)', padding: '16px', borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--text2)', fontSize: 12, lineHeight: 1.5 }}>
                <Truck size={16} color="var(--gold)" style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <strong style={{ color: 'white', display: 'block', marginBottom: 2, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>Standard Shipping</strong>
                  Delivery within 4-8 business days across Egypt.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--text2)', fontSize: 12, lineHeight: 1.5 }}>
                <RotateCcw size={16} color="var(--gold)" style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <strong style={{ color: 'white', display: 'block', marginBottom: 2, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>7-Day Returns & Exchanges</strong>
                  Easy returns within 7 days. Items must be unworn, in original packaging, with all tags attached.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--text2)', fontSize: 12, lineHeight: 1.5 }}>
                <Shield size={16} color="var(--gold)" style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <strong style={{ color: 'white', display: 'block', marginBottom: 2, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' }}>Inspect Before You Pay</strong>
                  You have the full right to check and inspect fabric quality upon delivery before paying the courier.
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 24 }}>
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
                {['description', 'details', 'care'].map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{ padding: '10px 20px', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', background: 'none', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--gold)' : 'transparent'}`, color: tab === t ? 'var(--gold)' : 'var(--text2)', cursor: 'pointer', transition: 'all 0.2s', marginBottom: -1 }}>
                    {t}
                  </button>
                ))}
              </div>
              <AnimatePresence mode="wait">
                <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                  style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.8 }}>
                  {tab === 'description' && <p>{p.description}</p>}
                  {tab === 'details' && <ul style={{ paddingLeft: 16 }}>{['Premium quality fabric', 'Handcrafted finishing', 'Exclusive design', `Available in ${(p.colors || []).length} colors`, `Sizes: ${(p.sizes || []).join(', ')}`].map(d => <li key={d} style={{ marginBottom: 4 }}>{d}</li>)}</ul>}
                  {tab === 'care' && <ul style={{ paddingLeft: 16 }}>{['Dry clean only', 'Do not bleach', 'Cool iron if needed', 'Store in garment bag'].map(d => <li key={d} style={{ marginBottom: 4 }}>{d}</li>)}</ul>}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </div>

        {/* Related */}
        {related.length > 0 && (
          <div style={{ marginTop: 80 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 400, marginBottom: 32, textAlign: 'center', letterSpacing: 2 }}>You May Also Like</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 24 }}>
              {related.map((rp, i) => <ProductCard key={rp.id} product={rp} index={i} />)}
            </div>
          </div>
        )}
      </div>

      {/* ─── 1. مودال التنبيه للمخزون ─── */}
      <AnimatePresence>
        {stockModal.open && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: 20
          }} onClick={() => setStockModal({ open: false, message: '' })}>
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
              style={{
                background: '#111111', border: '1px solid var(--gold, #c9a84c)', borderRadius: 4,
                width: '100%', maxWidth: 420, padding: '32px 24px', position: 'relative',
                boxShadow: '0 20px 50px rgba(0,0,0,0.7), 0 0 20px rgba(201,168,76,0.15)', textAlign: 'center'
              }} onClick={e => e.stopPropagation()}
            >
              <button onClick={() => setStockModal({ open: false, message: '' })}
                style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text3, #888)', cursor: 'pointer' }}>
                <X size={18} />
              </button>

              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(201,168,76,0.1)', border: '1px solid var(--gold, #c9a84c)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <AlertTriangle size={24} color="var(--gold, #c9a84c)" />
              </div>

              <h3 style={{ fontFamily: 'var(--font-display, serif)', fontSize: 22, color: 'white', fontWeight: 400, letterSpacing: 1.5, marginBottom: 12 }}>STOCK NOTICE</h3>
              <p style={{ color: 'var(--text2, #ccc)', fontSize: 13, lineHeight: 1.6, marginBottom: 28 }}>{stockModal.message}</p>
              <button className="gold-btn" style={{ width: '100%', padding: '12px 0', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase' }} onClick={() => setStockModal({ open: false, message: '' })}>
                Acknowledge
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ─── 2. مودال دليل المقاسات ─── */}
      <AnimatePresence>
        {sizeGuideOpen && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: 20
          }} onClick={() => setSizeGuideOpen(false)}>
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 30 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 30 }}
              transition={{ duration: 0.3 }}
              style={{
                background: '#111111', border: '1px solid var(--gold, #c9a84c)', borderRadius: 4,
                width: '100%', maxWidth: 650, padding: '40px 32px', position: 'relative',
                boxShadow: '0 25px 60px rgba(0,0,0,0.8), 0 0 30px rgba(201,168,76,0.1)'
              }} onClick={e => e.stopPropagation()}
            >
              <button onClick={() => setSizeGuideOpen(false)}
                style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', color: '#888', cursor: 'pointer', zIndex: 10 }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--gold, #c9a84c)'}
                onMouseLeave={e => e.currentTarget.style.color = '#888'}
              >
                <X size={20} />
              </button>

              <h3 style={{ fontFamily: 'var(--font-display, serif)', fontSize: 24, color: 'white', fontWeight: 400, letterSpacing: 2, marginBottom: 8, textAlign: 'center' }}>
                SIZE GUIDE
              </h3>
              <p style={{ color: 'var(--text3, #888)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 24, textAlign: 'center' }}>
                {(p.category ?? 'Standard')} Measurements
              </p>

              {(p.sizeGuide || p.sizeguide || p.size_guide) ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', maxHeight: '60vh', overflowY: 'auto', borderRadius: 2, background: '#0a0a0a', padding: 12, border: '1px solid rgba(255,255,255,0.03)' }}>
                  <img 
                    src={p.sizeGuide || p.sizeguide || p.size_guide} 
                    alt={`Size Guide Chart for ${p.name}`} 
                    style={{ width: '100%', height: 'auto', maxHeight: '50vh', objectFit: 'contain' }} 
                  />
                </div>
              ) : (
                <>
                  <div style={{ overflowX: 'auto', marginBottom: 32 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'center', color: 'var(--text2, #ccc)' }}>
                      {(
                        ['pants', 'trousers', 'jeans', 'shorts', 'pant', 'trouser', 'jean', 'short', 'بناطيل', 'بنطلون', 'شورت'].some(word => (p.category ?? '').toLowerCase().includes(word)) ||
                        ['pants', 'trousers', 'jeans', 'shorts', 'pant', 'trouser', 'jean', 'short', 'بناطيل', 'بنطلون', 'شورت'].some(word => (p.name ?? '').toLowerCase().includes(word))
                      ) ? (
                        <>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--gold, #c9a84c)', color: 'var(--gold, #c9a84c)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Size</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Waist (الخصر)</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Hips (الأرداف)</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Length (الطول)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { s: 'S', w: '76-80 cm', h: '92-96 cm', l: '102 cm' },
                              { s: 'M', w: '81-85 cm', h: '97-101 cm', l: '104 cm' },
                              { s: 'L', w: '86-90 cm', h: '102-106 cm', l: '106 cm' },
                              { s: 'XL', w: '91-95 cm', h: '107-111 cm', l: '108 cm' }
                            ].map((row, idx) => (
                              <tr key={row.s} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: idx % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                                <td style={{ padding: '14px 8px', fontWeight: 600, color: 'white' }}>{row.s}</td>
                                <td style={{ padding: '14px 8px' }}>{row.w}</td>
                                <td style={{ padding: '14px 8px' }}>{row.h}</td>
                                <td style={{ padding: '14px 8px' }}>{row.l}</td>
                              </tr>
                            ))}
                          </tbody>
                        </>
                      ) : (
                        <>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--gold, #c9a84c)', color: 'var(--gold, #c9a84c)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Size</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Chest (الصدر)</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Shoulder (الكتف)</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Length (الطول)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { s: 'S', c: '92-96 cm', sh: '44 cm', l: '68 cm' },
                              { s: 'M', c: '97-101 cm', sh: '46 cm', l: '70 cm' },
                              { s: 'L', c: '102-106 cm', sh: '48 cm', l: '72 cm' },
                              { s: 'XL', c: '107-111 cm', sh: '50 cm', l: '74 cm' }
                            ].map((row, idx) => (
                              <tr key={row.s} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: idx % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                                <td style={{ padding: '14px 8px', fontWeight: 600, color: 'white' }}>{row.s}</td>
                                <td style={{ padding: '14px 8px' }}>{row.c}</td>
                                <td style={{ padding: '14px 8px' }}>{row.sh}</td>
                                <td style={{ padding: '14px 8px' }}>{row.l}</td>
                              </tr>
                            ))}
                          </tbody>
                        </>
                      )}
                    </table>
                  </div>

                  <p style={{ color: 'var(--text3, #888)', fontSize: 11, fontStyle: 'italic', lineHeight: 1.5, textAlign: 'center', marginBottom: 0 }}>
                    * Note: Measurements may vary by 1-2 cm depending on the luxury cut and style.
                  </p>
                </>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}