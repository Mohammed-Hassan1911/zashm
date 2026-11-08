import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Heart, ShoppingBag, Truck, RotateCcw, Shield, ChevronLeft, ChevronRight, AlertTriangle, X, Ruler } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import ProductReviews from '../components/shop/ProductReviews';
import SafeImage, { useImageFallback } from '../components/ui/SafeImage';
import { ProductPageSkeleton } from '../components/ui/PageSkeletons';
import { toast } from '../components/ui/BackToTop';
import { setPageMeta, setProductJsonLd, clearProductJsonLd, clearCanonical } from '../lib/seo';
import { discountPercent, effectivePrice, hasInvalidVariantConfig, hasVariantStock, regularPrice, sellableStockFor } from '../lib/pricing';
import { resolveRoute } from '../lib/routes';
import { getColorSwatch } from '../lib/productColors.mjs';

const FALLBACK_IMG = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect fill="%23222" width="300" height="400"/%3E%3C/svg%3E';

// Shared pill used by "Size Guide" and the selected-size readout, so both keep
// exactly the same border, radius, background and height at every breakpoint.
const sizePillStyle = {
  color: 'var(--gold)',
  fontSize: 12,
  fontWeight: 600,
  background: 'rgba(201,168,76,0.10)',
  border: '1px solid var(--border-gold, rgba(201,168,76,0.5))',
  borderRadius: 999,
  letterSpacing: 1,
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '7px 14px',
  minHeight: 44,
  textTransform: 'uppercase',
  lineHeight: 1,
  transition: 'background 0.2s, border-color 0.2s',
};

export default function ProductPage() {
  const { selectedProduct, addToCart, toggleWishlist, wishlist, products, productsLoading, productsLoadStatus, setPage, addRecentlyViewed } = useStore();
  const productId = resolveRoute().productId;
  const p = (products || []).find(product => String(product.id) === String(productId)) ||
    (productId == null ? selectedProduct : null);
  const [selSize, setSelSize] = useState('');
  const [selColor, setSelColor] = useState('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const [tab, setTab] = useState('description');

  // ستايت التحكم في مودال المخزون ومودال دليل المقاسات
  const [stockModal, setStockModal] = useState({ open: false, message: '' });
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const imageSwipeStartRef = useRef(null);

  // مرجع لحفظ الـ ID الحالي لمنع التحديث المزدوج العشوائي الذي يسبب اختفاء الصورة
  const lastProductIdRef = useRef(null);
  const stockCloseRef = useRef(null);
  const sizeGuideCloseRef = useRef(null);
  const buyRowRef = useRef(null);
  const [showStickyBuy, setShowStickyBuy] = useState(false);

  // كل مودالات الصفحة: Escape يقفل، والتركيز يبدأ على زر الإغلاق.
  useEffect(() => {
    if (!stockModal.open && !sizeGuideOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (stockModal.open) setStockModal({ open: false, message: '' });
      if (sizeGuideOpen) setSizeGuideOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [stockModal.open, sizeGuideOpen]);

  useEffect(() => {
    if (stockModal.open) stockCloseRef.current?.focus();
  }, [stockModal.open]);

  useEffect(() => {
    if (sizeGuideOpen) sizeGuideCloseRef.current?.focus();
  }, [sizeGuideOpen]);

  // Lock the page behind modals so the size chart can be read without the
  // catalogue scrolling underneath it on a phone.
  useEffect(() => {
    if (!sizeGuideOpen && !stockModal.open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [sizeGuideOpen, stockModal.open]);

  // Phone-only sticky buy bar: appears once the real Add to Bag row has
  // scrolled above the viewport, so the first screen stays clean.
  useEffect(() => {
    const update = () => {
      if (window.innerWidth > 768 || !buyRowRef.current) {
        setShowStickyBuy(false);
        return;
      }
      setShowStickyBuy(buyRowRef.current.getBoundingClientRect().bottom < 0);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [p?.id]);

  useEffect(() => {
    document.body.classList.toggle('has-sticky-buy', showStickyBuy);
    return () => document.body.classList.remove('has-sticky-buy');
  }, [showStickyBuy]);

  // تأمين مصفوفة الصور لتجنب الكراش في حال عدم وجود صور للمنتج
  const productImages = p?.images && p.images.length > 0 ? p.images : ['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect fill="%23222" width="300" height="400"/%3E%3C/svg%3E'];
  // Live Supabase image → R2 mirror → placeholder.
  const mainImage = useImageFallback(productImages[imgIdx] || productImages[0], FALLBACK_IMG);

  const changeImage = (direction) => {
    setImgIdx(index => (index + direction + productImages.length) % productImages.length);
  };
  const handleImagePointerDown = (event) => {
    if (event.pointerType === 'mouse') return;
    imageSwipeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };
  const handleImagePointerUp = (event) => {
    const start = imageSwipeStartRef.current;
    imageSwipeStartRef.current = null;
    if (!start || start.pointerId !== event.pointerId || productImages.length < 2) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    changeImage(deltaX < 0 ? 1 : -1);
  };

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

  // 🎯 بيانات SEO الخاصة بالمنتج (عنوان، وصف، صورة، وبيانات منظمة Schema.org)
  useEffect(() => {
    if (!p) return undefined;
    setPageMeta({
      title: p.name,
      description: p.description || `${p.name} — ${p.category || 'Luxury fashion'} at ZASHM.`,
      image: (Array.isArray(p.images) && p.images[0]) || undefined,
    });
    setProductJsonLd(p);
    return () => clearProductJsonLd();
  }, [p]);

  // A URL for a product that does not exist must never enter the search index.
  // Crawlers get a real 404 from middleware.ts; this keeps the client-rendered
  // state honest too (noindex + no canonical pointing at a dead URL).
  useEffect(() => {
    if (p) return undefined;
    if (productsLoading || productsLoadStatus === 'idle' || productsLoadStatus === 'loading') return undefined;
    setPageMeta({ title: 'Product Not Found', robots: 'noindex, nofollow' });
    clearCanonical();
    return undefined;
  }, [p, productsLoading, productsLoadStatus]);

  // A cold /product/:id load has no product row yet. Show the product-shaped
  // skeleton while the catalogue is still loading instead of a short "not
  // found" box that later grows into the full page (that growth shifted the
  // footer). Only a settled, successful load without the row is a real 404.
  const productPending = !p && (
    productsLoading ||
    productsLoadStatus === 'idle' ||
    productsLoadStatus === 'loading'
  );
  if (!p) return productPending ? (
    <ProductPageSkeleton />
  ) : (
    <div style={{ paddingTop: 120, textAlign: 'center', padding: '120px 24px' }}>
      <p style={{ color: 'var(--text2)' }}>{'Product not found.'}</p>
      <button className="gold-btn" style={{ marginTop: 24 }} onClick={() => setPage('shop')}>Back to Shop</button>
    </div>
  );

  const isWished = (wishlist || []).includes(p.id);
  const related = (products || []).filter(pr => pr.active !== false && (pr.category ?? 'General') === (p.category ?? 'General') && pr.id !== p.id).slice(0, 4);
  const discount = discountPercent(p);

  // Only offer a Description tab when the product actually has one, and build
  // Details from the real catalogue row instead of invented copy.
  const descriptionText = String(p.description || '').trim();
  const availableTabs = descriptionText ? ['description', 'details', 'care'] : ['details', 'care'];
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0];
  const detailRows = [
    ['Category', p.category || '—'],
    ...((p.colors || []).length ? [['Colours', (p.colors || []).join(', ')]] : []),
    ...((p.sizes || []).length ? [['Sizes', (p.sizes || []).join(', ')]] : []),
    ...(p.sku ? [['SKU', p.sku]] : []),
    ...(p.label ? [['Collection', p.label]] : []),
  ];

  // المخزون القابل للبيع هو التوليفة المعرّفة فقط — src/lib/pricing.js هو المرجع
  // الواحد للواجهة والخادم: مفتاح متبقٍّ من لون محذوف لا يُباع، ووجود
  // variantStock بلا مقاسات/ألوان معرّفة إعداد غير صالح ولا يُشترى إطلاقًا.
  const currentVariantStock = sellableStockFor(p, selSize, selColor);
  const variantConfigInvalid = hasInvalidVariantConfig(p);
  const isOutOfStock = variantConfigInvalid || currentVariantStock <= 0;

  const showToast = (msg, type) => {
    toast(msg, type);
  };

  const handleAddToCart = () => {
    if (!selSize) { showToast('Please select a size.', 'warning'); return; }
    if (!selColor) { showToast('Please select a color.', 'warning'); return; }
    if (qty > currentVariantStock) {
      setStockModal({ open: true, message: `Sorry, only ${currentVariantStock} pieces are available for Size: ${selSize} / Color: ${selColor}.` });
      return;
    }
    
    const result = addToCart(p, selSize, selColor, qty);
    
    if (result && result.success) {
      showToast(`${p.name ?? 'Product'} added to your bag!`, 'success');
    } else {
      setStockModal({ open: true, message: result?.error || 'Requested quantity is not available.' });
    }
  };

  return (
    <div className="product-page" style={{ paddingTop: 90, width: '100%', minWidth: 0 }}>
      <div className="product-page-container" style={{ maxWidth: 1300, margin: '0 auto', padding: 'clamp(16px, 4vw, 40px) clamp(12px, 4vw, 24px)', width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
        {/* Breadcrumb — the single back affordance on this page. Each link keeps a
            44px-tall hit area without adding the extra row the old Back button used. */}
        <motion.nav aria-label="Breadcrumb" style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', minWidth: 0 }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
          <button type="button" onClick={() => setPage('home')} className="product-breadcrumb-link" style={{ color: 'var(--text3)', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 6px', minWidth: 44, minHeight: 44 }}>Home</button>
          <span aria-hidden="true" style={{ color: 'var(--text3)' }}>/</span>
          <button type="button" onClick={() => setPage('shop')} className="product-breadcrumb-link" style={{ color: 'var(--text3)', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 6px', minWidth: 44, minHeight: 44 }}>Shop</button>
          <span aria-hidden="true" style={{ color: 'var(--text3)' }}>/</span>
          <span aria-current="page" style={{ color: 'var(--text2)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{p.name}</span>
        </motion.nav>

        <div
          className="product-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: 'clamp(20px, 5vw, 64px)',
            width: '100%',
            minWidth: 0,
          }}
        >
          {/* Images */}
          <motion.div initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6 }}>
            {p.label && (
              <div className="product-card-label-row" aria-label="Product label">
                <span className="label-badge">{p.label}</span>
              </div>
            )}
            <div
              className="product-card-image"
              onPointerDown={handleImagePointerDown}
              onPointerUp={handleImagePointerUp}
              onPointerCancel={() => { imageSwipeStartRef.current = null; }}
              style={{ position: 'relative', width: '100%', minWidth: 0, aspectRatio: '4 / 5', overflow: 'hidden', borderRadius: 2, cursor: 'default', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
            >
              <AnimatePresence mode="wait">
                <motion.img key={imgIdx}
                  src={mainImage.src}
                  alt={p.name}
                  draggable={false}
                  onError={mainImage.onError}
                  initial={{ opacity: 0, scale: 1.05 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.4 }}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    objectPosition: 'center',
                  }}
                />
              </AnimatePresence>
              {productImages.length > 1 && (
                <>
                  <button onClick={() => changeImage(-1)}
                    type="button"
                    aria-label="Previous image"
                    style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(10,10,10,0.62)', border: '1px solid rgba(255,255,255,0.14)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button onClick={() => changeImage(1)}
                    type="button"
                    aria-label="Next image"
                    style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(10,10,10,0.62)', border: '1px solid rgba(255,255,255,0.14)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                  <span aria-hidden="true" className="product-image-counter" style={{ position: 'absolute', right: 10, bottom: 10, padding: '4px 9px', borderRadius: 999, background: 'rgba(10,10,10,0.72)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.92)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, lineHeight: 1.4 }}>
                    {imgIdx + 1} / {productImages.length}
                  </span>
                </>
              )}
            </div>
            <div className="product-thumbs" style={{ display: 'flex', gap: 8, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
              {productImages.length > 1 && productImages.map((img, i) => (
                <motion.button key={i} type="button" onClick={() => setImgIdx(i)}
                  aria-label={`View image ${i + 1} of ${productImages.length}`}
                  aria-current={imgIdx === i ? 'true' : undefined}
                  style={{ width: 64, height: 80, flex: '0 0 auto', padding: 0, background: 'none', cursor: 'pointer', borderRadius: 1, overflow: 'hidden', border: `2px solid ${imgIdx === i ? 'var(--gold)' : 'transparent'}`, transition: 'border-color 0.2s' }}
                  whileHover={{ scale: 1.04 }}>
                  <SafeImage src={img} alt="" fallback={FALLBACK_IMG} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </motion.button>
              ))}
            </div>
          </motion.div>

          {/* Details */}
          <motion.div initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, delay: 0.1 }}>
            <p style={{ color: 'var(--text3)', fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 8 }}>{p.category}</p>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 400, marginBottom: 16, lineHeight: 1.2 }}>{p.name}</h1>

            {/* Price */}
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 24,
                minWidth: 0,
              }}
            >
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, color: 'var(--gold)' }}>
                EGP {effectivePrice(p).toLocaleString()}
              </span>
              {discount !== null && (
                <>
                  <span style={{ color: 'var(--text3)', fontSize: 18, textDecoration: 'line-through' }}>EGP {regularPrice(p).toLocaleString()}</span>
                  <span style={{ background: 'var(--red)', color: '#fff', fontSize: 11, padding: '3px 8px', borderRadius: 2, fontWeight: 700, letterSpacing: 0.5 }}>-{discount}%</span>
                </>
              )}
            </div>

            {/* Colors */}
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, letterSpacing: 2, color: 'var(--text2)', textTransform: 'uppercase', marginBottom: 10 }}>Color: <span style={{ color: 'var(--text)' }}>{selColor}</span></p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(p.colors || []).map(c => {
                  const isColorOOS = hasVariantStock(p) ? !(p.sizes || []).some(s => sellableStockFor(p, s, c) > 0) : false;
                  const isSelected = selColor === c;
                  
                  return (
                    <button key={c} onClick={() => { setSelColor(c); setQty(1); }}
                      type="button"
                      aria-pressed={isSelected}
                      aria-label={`Color ${c}${isColorOOS ? ' (out of stock)' : ''}`}
                      title={`${c}${isColorOOS ? ' (Out of stock)' : ''}`}
                      style={{ width:44, height:44, borderRadius:'50%', display:'inline-flex', alignItems:'center', justifyContent:'center', border:`2px solid ${isSelected ? 'var(--gold)' : 'var(--border)'}`, background:'transparent', cursor:'pointer', transition:'border-color 0.2s, opacity 0.2s', opacity:isColorOOS ? 0.45 : 1, boxShadow:isSelected ? '0 0 0 2px rgba(201,168,76,0.2)' : 'none' }}>
                      <span aria-hidden="true" style={{ width:28, height:28, borderRadius:'50%', background:getColorSwatch(c), border:'1px solid rgba(255,255,255,0.35)', display:'block' }} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sizes */}
<div style={{ marginBottom: 28 }}>
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
    <span
      data-size-value="true"
      aria-label={selSize ? `Selected size: ${selSize}` : 'Selected size: none'}
      style={sizePillStyle}
    >
      Size:
      <span style={{ color: 'var(--gold)', fontSize: 14, fontWeight: 700, letterSpacing: 0.5 }}>
        {selSize || '—'}
      </span>
    </span>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button 
        data-size-guide="true"
        onClick={() => setSizeGuideOpen(true)}
        type="button"
        style={{ ...sizePillStyle, cursor: 'pointer' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(201,168,76,0.20)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(201,168,76,0.10)'; }}
      >
        <Ruler size={14} aria-hidden="true" />
        Size Guide
      </button>
    </div>
  </div>
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    {(p.sizes || []).map(s => {
      // تحويل الطرفين لنصوص لضمان دقة المقارنة والاختيار
      const isSelected = String(selSize) === String(s);
      const isSizeOOSWithSelectedColor = sellableStockFor(p, s, selColor) <= 0;

      return (
        <motion.button 
          key={s} 
          type="button" // يمنع أي تعليق أو تداخل مع الفورم
          onClick={() => { setSelSize(s); setQty(1); }}
          aria-pressed={isSelected}
          aria-label={`Size ${s}${isSizeOOSWithSelectedColor ? ' (out of stock in the selected color)' : ''}`}
          style={{ 
            width: 48, height: 48, borderRadius: 2, fontSize: 12, fontWeight: 600, 
            border: `2px solid ${isSelected ? 'var(--gold)' : 'var(--border)'}`, 
            background: isSelected ? 'rgba(201,168,76,0.1)' : 'transparent', 
            color: isSelected ? 'var(--gold)' : isSizeOOSWithSelectedColor ? 'var(--text3)' : 'var(--text2)', 
            cursor: 'pointer',
            textDecoration: isSizeOOSWithSelectedColor ? 'line-through' : 'none',
            textDecorationColor: 'rgba(160,153,138,0.65)'
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
            <div
              className="product-buy-row"
              ref={buyRowRef}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginBottom: 16,
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 2, opacity: isOutOfStock ? 0.5 : 1, pointerEvents: isOutOfStock ? 'none' : 'auto' }}>
                <button onClick={() => setQty(Math.max(1, qty - 1))}
                  type="button" aria-label="Decrease quantity"
                  style={{ width: 44, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>−</button>
                <span style={{ width: 40, textAlign: 'center', fontSize: 14, fontWeight: 600 }}>{qty}</span>
                <button onClick={() => setQty(Math.min(currentVariantStock, qty + 1))}
                  type="button" aria-label="Increase quantity"
                  style={{ width: 44, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>+</button>
              </div>
              
              <motion.button 
                className="gold-btn add-to-bag-btn" 
                style={{ 
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  whiteSpace: 'nowrap',
                  minHeight: 52,
                  background: isOutOfStock ? '#2a2a2a' : 'var(--gold)',
                  color: isOutOfStock ? '#9a9488' : 'var(--bg)',
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
                aria-label={isWished ? 'Remove from wishlist' : 'Add to wishlist'}
                aria-pressed={isWished}
                onClick={() => {
                  toggleWishlist(p.id);
                  toast(isWished ? 'Removed from wishlist' : 'Added to wishlist', isWished ? 'error' : 'success');
                }}
                style={{ width: 52, height: 52, borderRadius: 2, border: `2px solid ${isWished ? '#e74c3c' : 'var(--border)'}`, background: 'transparent', color: isWished ? '#e74c3c' : 'var(--text2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Heart size={18} fill={isWished ? '#e74c3c' : 'none'} />
              </motion.button>
            </div>

            <p role="status" aria-live="polite" style={{ color: isOutOfStock ? '#e08a82' : currentVariantStock > 5 ? 'var(--green)' : '#d8a94a', fontSize: 12, marginBottom: 24, fontWeight: 600 }}>
              {variantConfigInvalid
                ? 'This product is not available to order right now.'
                : isOutOfStock
                ? 'This size and colour is sold out.'
                : currentVariantStock > 5 
                  ? 'In stock — ready to ship' 
                  : `Only ${currentVariantStock} left in this size and colour`}
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
              <div
                role="tablist"
                aria-label="Product information"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 0,
                  borderBottom: '1px solid var(--border)',
                  marginBottom: 16,
                }}
              >
                {availableTabs.map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    type="button"
                    role="tab"
                    id={`product-tab-${t}`}
                    aria-selected={activeTab === t}
                    aria-controls={`product-panel-${t}`}
                    tabIndex={activeTab === t ? 0 : -1}
                    onKeyDown={(event) => {
                      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
                      event.preventDefault();
                      const index = availableTabs.indexOf(t);
                      const next = event.key === 'Home'
                        ? availableTabs[0]
                        : event.key === 'End'
                          ? availableTabs[availableTabs.length - 1]
                          : availableTabs[(index + (event.key === 'ArrowRight' ? 1 : availableTabs.length - 1)) % availableTabs.length];
                      setTab(next);
                      document.getElementById(`product-tab-${next}`)?.focus();
                    }}
                    style={{
                      flex: '1 1 80px',
                      minWidth: 0,
                      minHeight: 44,
                      padding: '10px 6px',
                      fontSize: 'clamp(11px, 2.8vw, 12px)',
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      background: 'none',
                      border: 'none',
                      borderBottom: `2px solid ${activeTab === t ? 'var(--gold)' : 'transparent'}`,
                      color: activeTab === t ? 'var(--gold)' : 'var(--text2)',
                      cursor: 'pointer',
                      transition: 'color 0.2s, border-color 0.2s',
                      marginBottom: -1,
                      overflowWrap: 'anywhere',
                    }}>
                    {t}
                  </button>
                ))}
              </div>
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  role="tabpanel"
                  id={`product-panel-${activeTab}`}
                  aria-labelledby={`product-tab-${activeTab}`}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                  style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.8 }}>
                  {activeTab === 'description' && <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{descriptionText}</p>}
                  {activeTab === 'details' && (
                    <dl className="product-detail-list" style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '8px 16px', margin: 0 }}>
                      {detailRows.map(([label, value]) => (
                        <React.Fragment key={label}>
                          <dt style={{ color: 'var(--text3)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', margin: 0 }}>{label}</dt>
                          <dd style={{ margin: 0, color: 'var(--text)', overflowWrap: 'anywhere' }}>{value}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  )}
                  {activeTab === 'care' && <ul style={{ paddingLeft: 18, margin: 0 }}>{['Dry clean recommended', 'Do not bleach', 'Cool iron if needed', 'Store in a garment bag'].map(d => <li key={d} style={{ marginBottom: 4 }}>{d}</li>)}</ul>}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </div>

        <ProductReviews product={p} />

        {/* Related */}
        {related.length > 0 && (
          <div style={{ marginTop: 80 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 400, marginBottom: 32, textAlign: 'center', letterSpacing: 2 }}>{'You May Also Like'}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 24 }}>
              {related.map((rp, i) => <ProductCard key={rp.id} product={rp} index={i} />)}
            </div>
          </div>
        )}
      </div>

      {/* Phone-only sticky buy bar — keeps the primary action reachable once the
          real Add to Bag row scrolls out of view. */}
      {showStickyBuy && !sizeGuideOpen && !stockModal.open && (
        <div className="product-sticky-buy" role="region" aria-label="Quick purchase">
          <div style={{ minWidth: 0, lineHeight: 1.25 }}>
            <span style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, color: 'var(--gold)', whiteSpace: 'nowrap' }}>
              EGP {effectivePrice(p).toLocaleString()}
              {discount !== null && (
                <span style={{ marginLeft: 6, fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 400, color: 'var(--text3)', textDecoration: 'line-through' }}>
                  {' '}EGP {regularPrice(p).toLocaleString()}
                </span>
              )}
            </span>
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {selSize || '—'} · {selColor || '—'}
            </span>
          </div>
          <motion.button
            type="button"
            className="gold-btn add-to-bag-btn"
            onClick={handleAddToCart}
            disabled={isOutOfStock}
            whileTap={isOutOfStock ? {} : { scale: 0.98 }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              whiteSpace: 'nowrap', minHeight: 48, padding: '0 18px', flexShrink: 0,
              background: isOutOfStock ? '#2a2a2a' : 'var(--gold)',
              color: isOutOfStock ? '#9a9488' : 'var(--bg)',
              borderColor: isOutOfStock ? '#444' : 'var(--gold)',
              cursor: isOutOfStock ? 'not-allowed' : 'pointer',
            }}
          >
            <ShoppingBag size={16} aria-hidden="true" /> {isOutOfStock ? 'OUT OF STOCK' : 'ADD TO BAG'}
          </motion.button>
        </div>
      )}

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
              role="dialog"
              aria-modal="true"
              aria-labelledby="stock-availability-title"
              initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 20 }}
              style={{
                background: 'linear-gradient(160deg, #17150f, #101010 58%)',
                border: '1px solid rgba(201,168,76,0.55)',
                borderRadius: 8,
                width: '100%',
                maxWidth: 440,
                padding: 'clamp(24px, 6vw, 36px) clamp(18px, 5vw, 28px)',
                position: 'relative',
                boxShadow: '0 24px 64px rgba(0,0,0,0.72), 0 0 28px rgba(201,168,76,0.12)',
                textAlign: 'center'
              }} onClick={e => e.stopPropagation()}
            >
              <button onClick={() => setStockModal({ open: false, message: '' })}
                ref={stockCloseRef}
                type="button"
                aria-label="Close stock notice"
                style={{ position: 'absolute', top: 12, right: 12, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: '50%', color: 'var(--text3, #888)', cursor: 'pointer' }}>
                <X size={18} aria-hidden="true" />
              </button>

              <div style={{ width: 58, height: 58, borderRadius: '50%', background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 18px', boxShadow: '0 0 24px rgba(201,168,76,0.12)' }}>
                <AlertTriangle size={24} color="var(--gold, #c9a84c)" />
              </div>

              <h3 id="stock-availability-title" style={{ fontFamily: 'var(--font-display, serif)', fontSize: 25, color: 'var(--gold, #c9a84c)', fontWeight: 500, letterSpacing: 0.6, marginBottom: 18 }}>Stock availability</h3>
              <div style={{ display: 'grid', gap: 12, marginBottom: 26 }}>
                {stockModal.message.split('\n').filter(Boolean).map((message, index) => (
                  <p
                    key={`${index}-${message}`}
                    dir={index === 1 ? 'rtl' : 'ltr'}
                    style={{
                      color: index === 0 ? 'var(--text)' : 'var(--text2, #ccc)',
                      fontSize: 14,
                      lineHeight: 1.8,
                      margin: 0,
                    }}
                  >
                    {message}
                  </p>
                ))}
              </div>
              <button className="gold-btn" style={{ width: '100%', padding: '13px 0', fontSize: 12, letterSpacing: 1.8, textTransform: 'uppercase', borderRadius: 2 }} onClick={() => setStockModal({ open: false, message: '' })}>
                Got it
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ─── 2. مودال دليل المقاسات ─── */}
      <AnimatePresence>
        {sizeGuideOpen && (
          <div className="size-guide-overlay" style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.85)', backdropFilter: 'blur(8px)',
            display: 'flex', justifyContent: 'center',
            zIndex: 9999, padding: 20, overflowY: 'auto'
          }} onClick={() => setSizeGuideOpen(false)}>
            
            <motion.div 
              role="dialog"
              aria-modal="true"
              aria-labelledby="size-guide-title"
              initial={{ opacity: 0, scale: 0.95, y: 30 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 30 }}
              transition={{ duration: 0.3 }}
              className="size-guide-modal"
              style={{
                background: '#111111',
                border: '1px solid var(--gold, #c9a84c)',
                borderRadius: 4,
                width: '100%',
                maxWidth: 650,
                maxHeight: 'calc(100dvh - 24px)',
                overflowY: 'auto',
                padding: 'clamp(18px, 5vw, 40px) clamp(12px, 4vw, 32px)',
                position: 'relative',
                boxSizing: 'border-box',
                boxShadow: '0 25px 60px rgba(0,0,0,0.8), 0 0 30px rgba(201,168,76,0.1)'
              }} onClick={e => e.stopPropagation()}
            >
              <button className="size-guide-close" onClick={() => setSizeGuideOpen(false)}
                ref={sizeGuideCloseRef}
                type="button"
                aria-label="Close size guide"
                style={{ position: 'absolute', top: 20, right: 20, background: 'none', border: 'none', color: '#888', cursor: 'pointer', zIndex: 10 }}
                onMouseEnter={e => e.currentTarget.style.color = 'var(--gold, #c9a84c)'}
                onMouseLeave={e => e.currentTarget.style.color = '#888'}
              >
                <X size={20} aria-hidden="true" />
              </button>

              <h3 id="size-guide-title" style={{ fontFamily: 'var(--font-display, serif)', fontSize: 24, color: 'white', fontWeight: 400, letterSpacing: 2, marginBottom: 8, textAlign: 'center' }}>
                SIZE GUIDE
              </h3>
              <p style={{ color: 'var(--text3, #888)', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 24, textAlign: 'center' }}>
                {(p.category ?? 'Standard')} Measurements
              </p>

              {(p.sizeGuide || p.sizeguide || p.size_guide) ? (
                <div className="size-guide-image-frame" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', width: '100%', maxHeight: '60vh', overflowY: 'auto', borderRadius: 2, background: '#0a0a0a', padding: 12, border: '1px solid rgba(255,255,255,0.03)' }}>
                  <SafeImage
                    src={p.sizeGuide || p.sizeguide || p.size_guide}
                    alt={`Size Guide Chart for ${p.name}`}
                    fallback={FALLBACK_IMG}
                    className="size-guide-image"
                    style={{ width: '100%', height: 'auto', maxHeight: '50vh', objectFit: 'contain' }}
                  />
                </div>
              ) : (
                <>
                  <div style={{ overflowX: 'auto', marginBottom: 32 }}>
                    <table style={{
                      width: '100%',
                      minWidth: 440,
                      borderCollapse: 'collapse',
                      fontSize: 13,
                      textAlign: 'center',
                      color: 'var(--text2, #ccc)',
                    }}>
                      {(
                        ['pants', 'trousers', 'jeans', 'shorts', 'pant', 'trouser', 'jean', 'short'].some(word => (p.category ?? '').toLowerCase().includes(word)) ||
                        ['pants', 'trousers', 'jeans', 'shorts', 'pant', 'trouser', 'jean', 'short'].some(word => (p.name ?? '').toLowerCase().includes(word))
                      ) ? (
                        <>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--gold, #c9a84c)', color: 'var(--gold, #c9a84c)', fontFamily: 'var(--font-display)', letterSpacing: 1 }}>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Size</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Waist</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Hips</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Length</th>
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
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Chest</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Shoulder</th>
                              <th style={{ padding: '12px 8px', fontWeight: 500 }}>Length</th>
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
