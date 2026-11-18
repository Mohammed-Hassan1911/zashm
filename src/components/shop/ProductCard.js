import React, { useState } from 'react';
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

  const [imgIdx, setImgIdx] = useState(0);

  // variantStock هو المصدر الأساسي للتوفر عند وجود المتغيرات، ويُحسب فقط من
  // المفاتيح المطابقة للمقاسات والألوان المعرفة (مخزون اليتيم لا يظهر للعميل).
  const isSoldOut = availableStock(product) <= 0;

  const images = Array.isArray(product?.images)
    ? product.images.filter(Boolean)
    : [];

  const imageIndex = imgIdx < images.length ? imgIdx : 0;
  const currentImage = images[imageIndex] || FALLBACK_IMAGE;
  // Live Supabase image → R2 mirror → neutral placeholder.
  const image = useImageFallback(currentImage, FALLBACK_IMAGE);

  const handleView = () => {
    if (!product?.id) return;

    setImgIdx(0);

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

  const changeImage = (nextIndex) => {
    if (!isSoldOut && images.length > 1) {
      setImgIdx(nextIndex);
    }
  };

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
        onMouseEnter={() => changeImage(1)}
        onMouseLeave={() => setImgIdx(0)}
      >
        <motion.img
          src={image.src}
          alt={product?.name || 'Product'}
          loading={index === 0 ? 'eager' : 'lazy'}
          fetchpriority={index === 0 ? 'high' : 'auto'}
          decoding="async"
          onError={image.onError}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            maxWidth: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            opacity: isSoldOut ? 0.45 : 1,
          }}
          animate={{ scale: imgIdx === 1 ? 1.04 : 1 }}
          transition={{ duration: 0.35 }}
        />

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
          {product?.name || 'Product'}
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
