import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, useMotionValue, useSpring, useReducedMotion } from 'framer-motion';
import { Heart, ShoppingBag, Truck, RotateCcw, Shield, ChevronLeft, ChevronRight, AlertTriangle, X, Ruler, ZoomIn } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import ProductReviews from '../components/shop/ProductReviews';
import SizeFinder from '../components/shop/SizeFinder';
import SafeImage from '../components/ui/SafeImage';
import ProductImageLightbox from '../components/ui/ProductImageLightbox';
import { ProductPageSkeleton } from '../components/ui/PageSkeletons';
import { toast } from '../components/ui/BackToTop';
import { setPageMeta, setProductJsonLd, clearProductJsonLd, clearCanonical } from '../lib/seo';
import { discountPercent, effectivePrice, hasInvalidVariantConfig, hasVariantStock, regularPrice, sellableStockFor } from '../lib/pricing';
import { GARMENT, garmentKind } from '../lib/fit';
import { resolveRoute } from '../lib/routes';
import { getColorSwatch, getColorTextStyle } from '../lib/productColors.mjs';

const FALLBACK_IMG = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect fill="%23222" width="300" height="400"/%3E%3C/svg%3E';

// Shared pill used by "Size Guide" and the selected-size readout, so both keep
// exactly the same border, radius, background and height at every breakpoint.
const sizePillStyle = {
  color: 'var(--gold-light)',
  fontSize: 11,
  fontWeight: 600,
  background: 'linear-gradient(180deg, rgba(201,168,76,0.14), rgba(201,168,76,0.05))',
  border: '1px solid rgba(201,168,76,0.38)',
  borderRadius: 999,
  letterSpacing: 1.4,
  whiteSpace: 'nowrap',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '8px 15px',
  minHeight: 44,
  textTransform: 'uppercase',
  lineHeight: 1,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
  transition: 'background 0.2s, border-color 0.2s',
};

// One calm ink for the whole name: the bead carries the true fabric colour,
// while the lifted label ink keeps every shade readable on the dark canvas.
function ColorName({ color, className = '' }) {
  return (
    <span className={`product-color-name ${className}`.trim()} style={getColorTextStyle(color)}>
      {String(color || '')}
    </span>
  );
}

export default function ProductPage() {
  const { selectedProduct, addToCart, toggleWishlist, wishlist, products, productsLoading, productsLoadStatus, setPage, addRecentlyViewed } = useStore();
  const productId = resolveRoute().productId;
  const p = (products || []).find(product => String(product.id) === String(productId)) ||
    (productId == null ? selectedProduct : null);
  const [selSize, setSelSize] = useState('');
  const [selColor, setSelColor] = useState('');
  const [qty, setQty] = useState(1);
  const [imgIdx, setImgIdx] = useState(0);
  const galleryTrackRef = useRef(null);
  const [galleryFrameWidth, setGalleryFrameWidth] = useState(0);
  const [tab, setTab] = useState('description');

  // ستايت التحكم في مودال المخزون ومودال دليل المقاسات
  const [stockModal, setStockModal] = useState({ open: false, message: '' });
  const [sizeGuideOpen, setSizeGuideOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomOpenerRef = useRef(null);
  const zoomButtonRef = useRef(null);
  const imageSwipeStartRef = useRef(null);
  const imageSwipedRef = useRef(false);
  // A shopper who asked for reduced motion can still swipe between photos,
  // but nothing drifts under the finger or springs back on release.
  const reduceMotion = useReducedMotion();
  // A motion value follows the finger without a React render per pointer move;
  // the browser only has to move a composited layer, never repaint the photo.
  const galleryDragX = useMotionValue(0);
  // The plate reads a soft spring fed by the raw drag value: the finger never
  // jerks the photo, and on release it glides back instead of snapping.
  const galleryPlateX = useSpring(galleryDragX, {
    stiffness: 190, damping: 30, mass: 0.9, restDelta: 0.4,
  });

  // The strip travels in pixels so its step follows the lit plate at every
  // breakpoint. A measured pixel transform slides smoothly where a percentage
  // one snaps, and the observer keeps the step exact if the plate resizes.
  useEffect(() => {
    const el = galleryTrackRef.current;
    if (!el) return undefined;
    const measure = () => setGalleryFrameWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [p?.id]);

  // مرجع لحفظ الـ ID الحالي لمنع التحديث المزدوج العشوائي الذي يسبب اختفاء الصورة
  const lastProductIdRef = useRef(null);
  const stockCloseRef = useRef(null);
  const sizeGuideCloseRef = useRef(null);

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

  // تأمين مصفوفة الصور لتجنب الكراش في حال عدم وجود صور للمنتج
  const productImages = p?.images && p.images.length > 0 ? p.images : ['data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="400"%3E%3Crect fill="%23222" width="300" height="400"/%3E%3C/svg%3E'];
  const changeImage = (direction) => {
    setImgIdx(index => (index + direction + productImages.length) % productImages.length);
  };
  const openZoom = (opener) => {
    // Zoom belongs to the full-screen stage, not to the gallery: a tap on the
    // photo (or the + button) opens the same calm viewer luxury storefronts use.
    // Nothing scales under the finger here, so swiping and page scroll stay
    // predictable. The image itself is not focusable; always hand focus back to
    // the labelled zoom button so keyboard and screen-reader users land on a
    // real control.
    zoomOpenerRef.current = opener || zoomButtonRef.current;
    setZoomOpen(true);
  };

  const handleImagePointerDown = (event) => {
    imageSwipedRef.current = false;
    if (event.pointerType === 'mouse') return;
    // Only one finger owns the plate. A second finger must never replace the
    // active gesture: its release would otherwise clear the ref and leave the
    // first finger's drag stranded off-centre.
    if (imageSwipeStartRef.current) return;
    imageSwipeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      following: false,
    };
  };
  const handleImagePointerMove = (event) => {
    const start = imageSwipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (productImages.length < 2) return;
    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    // Wait for a clear horizontal intent so a vertical page scroll still wins.
    if (!start.following && (Math.abs(deltaX) < 8 || Math.abs(deltaX) <= Math.abs(deltaY))) return;
    start.following = true;
    // The gesture still advances the photo on release, but the plate stays put
    // while it is in progress: no drift, no spring to unwind afterwards.
    if (reduceMotion) return;
    // A gentle share of the drag feeds the spring, so the photo drifts with the
    // finger instead of racing it. The cap keeps the frame filled throughout.
    const limit = Math.max(80, Math.min(window.innerWidth * 0.35, 140));
    galleryDragX.set(Math.max(-limit, Math.min(limit, deltaX * 0.62)));
  };
  const handleImagePointerUp = (event) => {
    const start = imageSwipeStartRef.current;
    // An extra finger lifting must not end the gesture the first finger owns.
    if (!start || start.pointerId !== event.pointerId) return;
    imageSwipeStartRef.current = null;
    // Releasing lets the spring unwind slowly back to centre, whether or not
    // the gesture was long enough to change the photo.
    galleryDragX.set(0);
    if (productImages.length < 2) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    // A swipe ends with a click on the photo; suppress that click so changing
    // picture does not open the zoom stage on the way past.
    imageSwipedRef.current = true;
    changeImage(deltaX < 0 ? 1 : -1);
  };
  const handleImagePointerCancel = (event) => {
    const start = imageSwipeStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    imageSwipeStartRef.current = null;
    galleryDragX.set(0);
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
      setZoomOpen(false);
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
    <div className="product-not-found-shell" style={{ textAlign: 'center', padding: '120px 24px' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 400, margin: 0 }}>{'Product not found.'}</h1>
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
        <motion.nav aria-label="Breadcrumb" className="product-breadcrumb"
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
          <button type="button" onClick={() => setPage('home')} className="product-breadcrumb-link" style={{ minWidth: 44, minHeight: 44 }}>Home</button>
          <ChevronRight size={12} className="product-breadcrumb-sep" aria-hidden="true" />
          <button type="button" onClick={() => setPage('shop')} className="product-breadcrumb-link" style={{ minWidth: 44, minHeight: 44 }}>Shop</button>
          <ChevronRight size={12} className="product-breadcrumb-sep" aria-hidden="true" />
          <span aria-current="page" className="product-breadcrumb-current">{p.name}</span>
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
            {/* The label gets its own row above the photo, so the badge never
                sits on top of the product shot - whatever image is uploaded. */}
            {p.label && (
              <div className="product-card-labels product-page-label" aria-label="Product label">
                <span className="label-badge">{p.label}</span>
              </div>
            )}
            <div
              className="product-card-image product-gallery-main"
              onPointerDown={handleImagePointerDown}
              onPointerMove={handleImagePointerMove}
              onPointerUp={handleImagePointerUp}
              onPointerCancel={handleImagePointerCancel}
              onClick={(event) => {
                if (event.target instanceof Element && event.target.closest('button')) return;
                if (imageSwipedRef.current) { imageSwipedRef.current = false; return; }
                openZoom();
              }}
              // The catalogue prints are 3:4 (1086x1448). The card grid and the
              // bag already use that box; matching it here with a cover fit fills
              // the plate edge to edge instead of leaving black bars on the sides.
              style={{ position: 'relative', width: '100%', minWidth: 0, aspectRatio: '3 / 4', overflow: 'hidden', cursor: 'zoom-in', touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none' }}
            >
              {/* Every photo owns one full frame of a horizontal strip. Choosing
                  another photo slides the strip by exactly one frame, so the new
                  print enters from the right as the old one leaves — the same
                  sideways move the reference storefront uses. A soft spring still
                  lets a finger pull the strip before it eases to the selection,
                  and only transforms move: the mat and the arrows stay still.
                  The app disables framer-motion transforms globally, so the strip
                  uses one CSS transform transition instead. */}
              <div className="product-gallery-track" ref={galleryTrackRef}
                style={{
                  transform: `translateX(-${imgIdx * galleryFrameWidth}px)`,
                  transition: reduceMotion ? 'none' : 'transform 550ms cubic-bezier(0.45, 0, 0.2, 1)',
                }}>
                <motion.div className="product-gallery-frames" style={{ x: reduceMotion ? 0 : galleryPlateX }}>
                  {productImages.map((img, i) => (
                    <div key={i} className="product-gallery-frame">
                      <SafeImage
                        src={img}
                        data-image-width="detail"
                        alt={i === imgIdx ? p.name : ''}
                        draggable={false}
                        fallback={FALLBACK_IMG}
                        // The first image is the LCP element on this route: load
                        // it at high priority. The rest stay lazy.
                        fetchpriority={i === 0 ? 'high' : 'auto'}
                        loading={i === 0 ? 'eager' : 'lazy'}
                        decoding="async"
                        style={{
                          display: 'block', width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center',
                        }}
                      />
                    </div>
                  ))}
                </motion.div>
              </div>
              {/* The gallery controls sit directly on the photo, so they use a
                  near-opaque fill instead of a backdrop blur: a blur here has
                  to re-sample the whole image underneath on every frame the
                  photo moves, which is the most expensive thing on the page. */}
              {productImages.length > 1 && (
                <>
                  <button onClick={() => changeImage(-1)}
                    type="button"
                    aria-label="Previous image"
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(12,11,9,0.88)', border: '1px solid rgba(232,200,112,0.4)', color: 'var(--gold-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2, WebkitTapHighlightColor: 'transparent' }}>
                    <ChevronLeft size={18} aria-hidden="true" />
                  </button>
                  <button onClick={() => changeImage(1)}
                    type="button"
                    aria-label="Next image"
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%', background: 'rgba(12,11,9,0.88)', border: '1px solid rgba(232,200,112,0.4)', color: 'var(--gold-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 2, WebkitTapHighlightColor: 'transparent' }}>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                  <span aria-hidden="true" className="product-image-counter" style={{ position: 'absolute', right: 12, bottom: 12, padding: '4px 10px', borderRadius: 999, background: 'rgba(12,11,9,0.9)', border: '1px solid rgba(232,200,112,0.34)', color: 'var(--gold-light)', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, lineHeight: 1.4, zIndex: 2 }}>
                    {imgIdx + 1} / {productImages.length}
                  </span>
                </>
              )}
              <button
                ref={zoomButtonRef}
                type="button"
                className="product-zoom-trigger"
                aria-label="Zoom image"
                aria-haspopup="dialog"
                aria-expanded={zoomOpen}
                onClick={(event) => { event.stopPropagation(); openZoom(event.currentTarget); }}
              >
                <ZoomIn size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="product-thumbs" style={{ display: 'flex', gap: 10, marginTop: 12, overflowX: 'auto', paddingBottom: 2 }}>
              {productImages.length > 1 && productImages.map((img, i) => (
                <motion.button key={i} type="button" onClick={() => setImgIdx(i)}
                  aria-label={`View image ${i + 1} of ${productImages.length}`}
                  aria-current={imgIdx === i ? 'true' : undefined}
                  className={`product-thumb${imgIdx === i ? ' is-active' : ''}`}
                  style={{ flex: '0 0 auto', padding: 0, cursor: 'pointer' }}
                  whileHover={{ scale: 1.04 }}>
                  <SafeImage src={img} data-image-width="thumb" alt="" fallback={FALLBACK_IMG} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </motion.button>
              ))}
            </div>
          </motion.div>

          {/* Details */}
          <motion.div className="product-details" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, delay: 0.1 }}>
            <div className="product-detail-block" style={{ '--pp-i': 0 }}>
              {p.category && <p className="product-eyebrow">{p.category}</p>}
              <h1 className="product-title">{p.name}</h1>
            </div>

            {/* Price */}
            <div className="product-detail-block" style={{ '--pp-i': 1 }}>
              <div className="product-price-row">
                <span className="product-price">
                  <span className="product-price-currency">{'EGP'}</span>
                  {effectivePrice(p).toLocaleString()}
                </span>
                {discount !== null && (
                  <>
                    <span className="product-price-was">EGP {regularPrice(p).toLocaleString()}</span>
                    <span className="product-discount">-{discount}%</span>
                  </>
                )}
              </div>
            </div>

            {/* Colors */}
            <div className="product-detail-block product-block" style={{ '--pp-i': 2 }}>
              <p className="product-meta-label">
                {'Color'}{' '}
                <ColorName color={selColor} className="product-meta-value" />
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(p.colors || []).map(c => {
                  const isColorOOS = hasVariantStock(p) ? !(p.sizes || []).some(s => sellableStockFor(p, s, c) > 0) : false;
                  const isSelected = selColor === c;
                  
                  return (
                    <button key={c} onClick={() => { setSelColor(c); setQty(1); }}
                      type="button"
                      className="product-color-option"
                      data-selected={isSelected ? 'true' : 'false'}
                      data-oos={isColorOOS ? 'true' : 'false'}
                      aria-pressed={isSelected}
                      aria-label={`Color ${c}${isColorOOS ? ' (out of stock)' : ''}`}
                      title={`${c}${isColorOOS ? ' (Out of stock)' : ''}`}>
                      <span className="product-color-swatch" aria-hidden="true" style={{ background:getColorSwatch(c) }} />
                      <ColorName color={c} />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sizes */}
<div className="product-detail-block product-block" style={{ '--pp-i': 3 }}>
  <div className="product-size-head">
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
    <button 
      data-size-guide="true"
      onClick={() => setSizeGuideOpen(true)}
      type="button"
      className="product-size-guide-btn"
      style={{ ...sizePillStyle, cursor: 'pointer' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(201,168,76,0.24), rgba(201,168,76,0.09))'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'linear-gradient(180deg, rgba(201,168,76,0.14), rgba(201,168,76,0.05))'; }}
    >
      <Ruler size={14} aria-hidden="true" />
      Size Guide
    </button>
  </div>
  <div className="product-size-row">
    {(p.sizes || []).map(s => {
      // تحويل الطرفين لنصوص لضمان دقة المقارنة والاختيار
      const isSelected = String(selSize) === String(s);
      const isSizeOOSWithSelectedColor = sellableStockFor(p, s, selColor) <= 0;

      return (
        <motion.button 
          key={s} 
          className="product-size-option"
          data-oos={isSizeOOSWithSelectedColor ? 'true' : 'false'}
          type="button" // يمنع أي تعليق أو تداخل مع الفورم
          onClick={() => { setSelSize(s); setQty(1); }}
          aria-pressed={isSelected}
          aria-label={`Size ${s}${isSizeOOSWithSelectedColor ? ' (out of stock in the selected color)' : ''}`}
          // ترك الأنميشن بالكامل لـ Framer Motion لمنع أي تعليق فلاشي
          animate={{ borderColor: isSelected ? 'var(--gold)' : 'var(--border)' }}
          transition={{ duration: 0.1 }}
          whileHover={{ borderColor: isSizeOOSWithSelectedColor ? '#c0392b' : 'var(--gold)' }}
          whileTap={{ scale: 0.95 }}
        >
          {s}
        </motion.button>
      );
    })}
  </div>
</div>

            <SizeFinder
              sizes={p.sizes || []}
              sizeRanges={p.sizeRanges}
              selectedSize={selSize}
              category={p.category}
              name={p.name}
              sizeGuideOpen={sizeGuideOpen}
              onSelect={(size) => { setSelSize(size); setQty(1); }}
              stockFor={(size) => sellableStockFor(p, size, selColor)}
              onOpenSizeGuide={() => setSizeGuideOpen(true)}
            />

            {/* The reassurance reads before the action, so the buy row is the
                last thing the eye lands on. */}
            <p
              role="status"
              aria-live="polite"
              className="product-stock product-detail-block"
              data-tone={variantConfigInvalid || isOutOfStock ? 'out' : currentVariantStock > 5 ? 'ok' : 'low'}
              style={{ '--pp-i': 4 }}
            >
              {variantConfigInvalid
                ? 'This product is not available to order right now.'
                : isOutOfStock
                ? 'This size and colour is sold out.'
                : currentVariantStock > 5
                  ? 'In stock — ready to ship'
                  : `Only ${currentVariantStock} left in this size and colour`}
            </p>

            {/* Qty + Add */}
            <div
              className="product-buy-row product-detail-block"
              style={{ '--pp-i': 5 }}
            >
              <div className="product-qty" style={{ opacity: isOutOfStock ? 0.5 : 1, pointerEvents: isOutOfStock ? 'none' : 'auto' }}>
                <button onClick={() => setQty(Math.max(1, qty - 1))}
                  type="button" aria-label="Decrease quantity"
                  className="product-qty-btn">−</button>
                <span className="product-qty-value">{qty}</span>
                <button onClick={() => setQty(Math.min(currentVariantStock, qty + 1))}
                  type="button" aria-label="Increase quantity"
                  className="product-qty-btn">+</button>
              </div>
              
              <motion.button 
                className="gold-btn add-to-bag-btn" 
                style={{ 
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                  whiteSpace: 'nowrap'
                }}
                onClick={handleAddToCart} 
                disabled={isOutOfStock}
                whileTap={isOutOfStock ? {} : { scale: 0.98 }}
              >
                <ShoppingBag size={20} strokeWidth={1.8} aria-hidden="true" />
                <span className="add-to-bag-label">{isOutOfStock ? 'OUT OF STOCK' : 'ADD TO BAG'}</span>
              </motion.button>

              <motion.button
                aria-label={isWished ? 'Remove from wishlist' : 'Add to wishlist'}
                aria-pressed={isWished}
                className="product-wish-btn"
                data-wished={isWished ? 'true' : 'false'}
                onClick={() => {
                  toggleWishlist(p.id);
                  toast(isWished ? 'Removed from wishlist' : 'Added to wishlist', isWished ? 'error' : 'success');
                }}
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.95 }}>
                <Heart size={18} fill={isWished ? 'currentColor' : 'none'} />
              </motion.button>
            </div>

            {/* Features */}
            <div className="product-perks product-detail-block" style={{ '--pp-i': 6 }}>
              <div className="product-perk">
                <span className="product-perk-icon" aria-hidden="true"><Truck size={16} /></span>
                <div className="product-perk-body">
                  <strong>Standard Shipping</strong>
                  <span className="product-perk-copy">Delivery within 4-8 business days across Egypt.</span>
                </div>
              </div>

              <div className="product-perk">
                <span className="product-perk-icon" aria-hidden="true"><RotateCcw size={16} /></span>
                <div className="product-perk-body">
                  <strong>7-Day Exchanges &amp; Returns</strong>
                  <span className="product-perk-copy">Exchange or return within 7 days of delivery. Items must be unworn, in their original condition and packaging, with all tags attached.</span>
                </div>
              </div>

              <div className="product-perk">
                <span className="product-perk-icon" aria-hidden="true"><Shield size={16} /></span>
                <div className="product-perk-body">
                  <strong>Inspect Before You Pay</strong>
                  <span className="product-perk-copy">You have the full right to check and inspect fabric quality upon delivery before paying the courier.</span>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="product-detail-block" style={{ '--pp-i': 7, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
              <div
                role="tablist"
                aria-label="Product information"
                className="product-tabs"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 0,
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
                    className="product-tab"
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
                      color: activeTab === t ? 'var(--gold)' : 'var(--text2)',
                      cursor: 'pointer',
                      transition: 'color 0.2s',
                      marginBottom: -1,
                      overflowWrap: 'anywhere',
                    }}>
                    {t}
                    {activeTab === t && (
                      <motion.span
                        layoutId="product-tab-underline"
                        className="product-tab-underline"
                        aria-hidden="true"
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
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
                  className="product-panel">
                  {activeTab === 'description' && <p style={{ whiteSpace: 'pre-line' }}>{descriptionText}</p>}
                  {activeTab === 'details' && (
                    <dl className="product-detail-list">
                      {detailRows.map(([label, value]) => (
                        <React.Fragment key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  )}
                  {activeTab === 'care' && <ul>{['Dry clean recommended', 'Do not bleach', 'Cool iron if needed', 'Store in a garment bag'].map(d => <li key={d}>{d}</li>)}</ul>}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </div>

        <ProductReviews product={p} />

        {/* Related */}
        {related.length > 0 && (
          <div style={{ marginTop: 80 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(24px, 6vw, 32px)', fontWeight: 400, marginBottom: 32, textAlign: 'center', letterSpacing: 2 }}>{'You May Also Like'}</h2>
            <div className="product-collection-grid">
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
          <motion.div
            className="size-guide-overlay"
            onClick={() => setSizeGuideOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="size-guide-title"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="size-guide-modal"
              onClick={e => e.stopPropagation()}
            >
              <button className="size-guide-close" onClick={() => setSizeGuideOpen(false)}
                ref={sizeGuideCloseRef}
                type="button"
                aria-label="Close size guide"
              >
                <X size={18} aria-hidden="true" />
              </button>

              <header className="size-guide-head">
                <span className="size-guide-eyebrow">
                  <span className="size-guide-eyebrow-rule" aria-hidden="true" />
                </span>
                <h3 id="size-guide-title" className="size-guide-title">
                  Size Guide
                </h3>
                <p className="size-guide-sub">
                  {(p.category ?? 'Standard')} Measurements
                </p>
              </header>

              {(p.sizeGuide || p.sizeguide || p.size_guide) ? (
                <div className="size-guide-image-frame">
                  <SafeImage
                    src={p.sizeGuide || p.sizeguide || p.size_guide}
                    alt={`Size Guide Chart for ${p.name}`}
                    fallback={FALLBACK_IMG}
                    className="size-guide-image"
                  />
                </div>
              ) : (
                <>
                  <div className="size-guide-table-wrap">
                    <table className="size-guide-table">
                      {garmentKind({ category: p.category, name: p.name }) === GARMENT.BOTTOM ? (
                        <>
                          <thead>
                            <tr>
                              <th>Size</th>
                              <th>Waist</th>
                              <th>Hips</th>
                              <th>Length</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { s: 'S', w: '76-80 cm', h: '92-96 cm', l: '102 cm' },
                              { s: 'M', w: '81-85 cm', h: '97-101 cm', l: '104 cm' },
                              { s: 'L', w: '86-90 cm', h: '102-106 cm', l: '106 cm' },
                              { s: 'XL', w: '91-95 cm', h: '107-111 cm', l: '108 cm' }
                            ].map((row) => (
                              <tr key={row.s}>
                                <td>{row.s}</td>
                                <td>{row.w}</td>
                                <td>{row.h}</td>
                                <td>{row.l}</td>
                              </tr>
                            ))}
                          </tbody>
                        </>
                      ) : (
                        <>
                          <thead>
                            <tr>
                              <th>Size</th>
                              <th>Chest</th>
                              <th>Shoulder</th>
                              <th>Length</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { s: 'S', c: '92-96 cm', sh: '44 cm', l: '68 cm' },
                              { s: 'M', c: '97-101 cm', sh: '46 cm', l: '70 cm' },
                              { s: 'L', c: '102-106 cm', sh: '48 cm', l: '72 cm' },
                              { s: 'XL', c: '107-111 cm', sh: '50 cm', l: '74 cm' }
                            ].map((row) => (
                              <tr key={row.s}>
                                <td>{row.s}</td>
                                <td>{row.c}</td>
                                <td>{row.sh}</td>
                                <td>{row.l}</td>
                              </tr>
                            ))}
                          </tbody>
                        </>
                      )}
                    </table>
                  </div>

                  <p className="size-guide-note">
                    <Ruler size={13} aria-hidden="true" />
                    <span>* Note: Measurements may vary by 1-2 cm depending on the luxury cut and style.</span>
                  </p>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {zoomOpen && (
        <ProductImageLightbox
          images={productImages}
          index={imgIdx}
          name={p?.name}
          fallback={FALLBACK_IMG}
          returnTo={zoomOpenerRef.current}
          onIndexChange={setImgIdx}
          onClose={() => setZoomOpen(false)}
        />
      )}

    </div>
  );
}
