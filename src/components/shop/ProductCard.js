import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../../store';
import { availableStock, discountPercent, effectivePrice } from '../../lib/pricing';
import StarRating from './StarRating';
import { useImageFallback } from '../ui/SafeImage';

const LABEL_CLASS = {
  'New Arrival': 'label-new',
  'Best Seller': 'label-best',
  Featured: 'label-featured',
  'Limited Edition': 'label-limited',
};

const FALLBACK_IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect fill="%23ccc" width="100" height="100"/%3E%3C/svg%3E';

export default function ProductCard({ product, index = 0 }) {
  const {
    setPage,
    setSelectedProduct,
    addRecentlyViewed,
  } = useStore();

  const [hovered, setHovered] = useState(false);
  const [canHover, setCanHover] = useState(false);
  // The frame stays mounted so the crossfade cannot shift the 3:4 box, but its
  // Supabase source is only applied on the first hover. A card grid must not
  // download every second photo before anyone points at it.
  const [secondaryRequested, setSecondaryRequested] = useState(false);
  const [secondaryLoaded, setSecondaryLoaded] = useState(false);

  // A touch screen has no hover, so the second frame would be a download the
  // shopper never sees. Gate it on a real pointer, and follow the device if a
  // hybrid machine (tablet + mouse) changes its primary input.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const sync = () => setCanHover(query.matches);
    sync();
    if (query.addEventListener) query.addEventListener('change', sync);
    else query.addListener(sync);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', sync);
      else query.removeListener(sync);
    };
  }, []);

  // variantStock هو المصدر الأساسي للتوفر عند وجود المتغيرات، ويُحسب فقط من
  // المفاتيح المطابقة للمقاسات والألوان المعرفة (مخزون اليتيم لا يظهر للعميل).
  const isSoldOut = availableStock(product) <= 0;

  const images = Array.isArray(product?.images)
    ? product.images.filter(Boolean)
    : [];

  // Both frames stay mounted: swapping `src` on hover is what made the old
  // transition flash. Only the second frame's download waits for the pointer.
  const primary = useImageFallback(images[0] || FALLBACK_IMAGE, FALLBACK_IMAGE);
  const secondary = useImageFallback(images[1] || FALLBACK_IMAGE, FALLBACK_IMAGE);

  const hasSecondImage = canHover && images.length > 1 && !isSoldOut;
  // Reveal the deferred frame only once its real image has landed, so the
  // crossfade never shows the neutral placeholder in its place.
  const showSecond = hovered && hasSecondImage && secondaryLoaded;

  const handleImageEnter = () => {
    setHovered(true);
    if (secondaryRequested) return;
    // The placeholder's own load event must not count as the second photo.
    setSecondaryRequested(true);
    setSecondaryLoaded(false);
  };

  const handleView = () => {
    if (!product?.id) return;

    setSelectedProduct({
      ...product,
      _ts: Date.now(),
    });

    addRecentlyViewed(product.id);
    setPage('product');
  };

  const handleCardKeyDown = (event) => {
    // لا نفتح صفحة المنتج مرتين عند الضغط على الأزرار الداخلية.
    if (event.target !== event.currentTarget) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleView();
    }
  };

  const discount = discountPercent(product);
  const displayPrice = effectivePrice(product);

  const formatPrice = (price) =>
    price.toLocaleString('en-US');

  return (
    <motion.div
      className="product-card"
      // Keep the LCP card visible immediately; later cards retain the entrance fade.
      initial={index === 0 ? false : { opacity: 0 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        delay: Math.min(Math.max(index, 0), 5) * 0.015,
        ease: [0.4, 0, 0.2, 1],
      }}
      whileHover={{ y: -4 }}
      style={{
        cursor: 'pointer',
        position: 'relative',
        width: '100%',
        minWidth: 0,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
      onClick={handleView}
      onKeyDown={handleCardKeyDown}
      role="button"
      tabIndex={0}
    >
      {/* PRODUCT IMAGE */}
      <div
        className="product-card-image"
        style={{
          position: 'relative',
          width: '100%',
          minWidth: 0,
          aspectRatio: '3 / 4',
          overflow: 'hidden',
          background: 'var(--bg3)',
        }}
        onMouseEnter={handleImageEnter}
        onMouseLeave={() => setHovered(false)}
      >
        <img
          src={primary.src}
          alt={product?.name || 'Product'}
          loading={index === 0 ? 'eager' : 'lazy'}
          fetchpriority={index === 0 ? 'high' : 'auto'}
          decoding="async"
          onError={primary.onError}
          className="product-card-img"
          data-visible={showSecond ? 'false' : 'true'}
          data-sold-out={isSoldOut ? 'true' : 'false'}
        />

        {hasSecondImage && (
          <img
            src={secondaryRequested ? secondary.src : FALLBACK_IMAGE}
            alt=""
            aria-hidden="true"
            loading="lazy"
            fetchpriority="low"
            decoding="async"
            onLoad={() => setSecondaryLoaded(true)}
            onError={secondary.onError}
            className="product-card-img"
            data-visible={showSecond ? 'true' : 'false'}
            data-sold-out="false"
          />
        )}

        {/* Labels sit on the photo, welded into its top-left corner, so they
            never reserve vertical space above the image. The photo carries no
            other control: the whole card opens the product, and the wishlist
            lives on the product page. */}
        {(product?.label || isSoldOut) && (
          <div className="product-card-labels" aria-label="Product label and status">
            {product?.label && (
              <span className={`label-badge ${LABEL_CLASS[product.label] || ''}`}>
                {product.label}
              </span>
            )}
            {isSoldOut && (
              <span className="product-card-sold-out">Sold Out</span>
            )}
          </div>
        )}
      </div>

      {/* PRODUCT INFORMATION */}
      <div
        className="product-card-info"
        style={{
          padding: 'clamp(12px, 2.8vw, 16px) clamp(12px, 2.8vw, 16px) clamp(14px, 3vw, 18px)',
          opacity: isSoldOut ? 0.65 : 1,
          width: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
        }}
      >
        <p className="product-card-category">
          {product?.category || 'General'}
        </p>

        <p
          className="product-card-name"
          title={product?.name || ''}
          style={{
            fontSize: 'clamp(15px, 3.4vw, 18px)',
            lineHeight: 1.28,
            fontWeight: 500,
            textDecoration: isSoldOut ? 'line-through' : 'none',
            margin: 0,
            minWidth: 0,
            maxWidth: '100%',
            overflowWrap: 'anywhere',
            wordBreak: 'normal',
          }}
        >
          <span className="product-name-shine">{product?.name || 'Product'}</span>
        </p>

        <div
          className="product-card-rating"
          style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }}
        >
          <StarRating rating={Number(product?.rating) || 0} size={12} />
          <span className="product-card-reviews">
            {Number(product?.reviews) > 0 ? `(${Number(product.reviews)})` : 'No reviews'}
          </span>
        </div>

        <div
          className="product-card-price"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: 7,
            marginTop: 8,
            minWidth: 0,
          }}
        >
          <span
            className="product-card-price-now"
            style={{
              color: isSoldOut ? 'var(--text3)' : 'var(--gold)',
              fontSize: 'clamp(14px, 3.4vw, 16px)',
              fontWeight: 500,
              overflowWrap: 'anywhere',
              maxWidth: '100%',
            }}
          >
            EGP {formatPrice(displayPrice)}
          </span>

          {discount !== null && discount > 0 && (
            <span
              className="product-card-price-was"
              style={{
                fontSize: 'clamp(10px, 2.8vw, 12px)',
                overflowWrap: 'anywhere',
              }}
            >
              EGP {formatPrice(Number(product?.price) || 0)}
            </span>
          )}

          {discount !== null && discount > 0 && !isSoldOut && (
            <span
              className="product-card-discount"
              style={{
                color: 'var(--red-light)',
                fontSize: 10,
                whiteSpace: 'nowrap',
              }}
            >
              {discount}% OFF
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
