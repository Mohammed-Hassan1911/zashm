import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Heart, Eye } from 'lucide-react';
import { useStore } from '../../store';
import { toast } from '../ui/BackToTop';
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
    toggleWishlist,
    wishlist,
    setPage,
    setSelectedProduct,
    addRecentlyViewed,
  } = useStore();

  const [imgIdx, setImgIdx] = useState(0);

  const isWished = (wishlist || []).includes(product?.id);

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
      initial={{ opacity: 0 }}
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
          loading={index < 4 ? 'eager' : 'lazy'}
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

        {(product?.label || isSoldOut) && (
          <div className="product-card-labels" aria-label="Product labels">
            {product?.label && (
              <span className={`label-badge ${LABEL_CLASS[product.label] || ''}`}>
                {product.label}
              </span>
            )}
            {isSoldOut && <span className="product-card-sold-out">Sold Out</span>}
          </div>
        )}

        {/* ACTION BUTTONS */}
        <div
          className="product-card-actions"
          style={{
            position: 'absolute',
            top: 'clamp(6px, 2vw, 12px)',
            right: 'clamp(6px, 2vw, 12px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <motion.button
            type="button"
            aria-label={
              isWished ? 'Remove from wishlist' : 'Add to wishlist'
            }
            aria-pressed={isWished}
            onClick={(event) => {
              event.stopPropagation();
              if (product?.id) {
                toggleWishlist(product.id);
                toast(
                  isWished
                    ? 'Removed from wishlist'
                    : 'Added to wishlist',
                  isWished ? 'info' : 'success'
                );
              }
            }}
            whileTap={{ scale: 0.92 }}
            style={{
              width: 44,
              height: 44,
              minWidth: 44,
              minHeight: 44,
              padding: 0,
              borderRadius: '50%',
              background: 'rgba(10,10,10,0.86)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Heart
              size={15}
              fill={isWished ? '#e74c3c' : 'none'}
              color={isWished ? '#e74c3c' : 'white'}
            />
          </motion.button>

          <motion.button
            type="button"
            aria-label="View product details"
            onClick={(event) => {
              event.stopPropagation();
              handleView();
            }}
            whileTap={{ scale: 0.92 }}
            style={{
              width: 44,
              height: 44,
              minWidth: 44,
              minHeight: 44,
              padding: 0,
              borderRadius: '50%',
              background: 'rgba(10,10,10,0.86)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Eye size={15} color="white" />
          </motion.button>
        </div>
      </div>

      {/* PRODUCT INFORMATION */}
      <div
        className="product-card-info"
        style={{
          padding: 'clamp(10px, 2.5vw, 14px) 4px',
          opacity: isSoldOut ? 0.65 : 1,
          width: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
        }}
      >
        <p
          style={{
            fontSize: 10,
            lineHeight: 1.5,
            color: 'var(--text3)',
            margin: '0 0 5px',
            overflowWrap: 'anywhere',
          }}
        >
          {product?.category || 'General'}
        </p>

        <p
          className="product-card-name"
          title={product?.name || ''}
          style={{
            fontSize: 'clamp(13px, 3.5vw, 16px)',
            lineHeight: 1.5,
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
          style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}
        >
          <StarRating rating={Number(product?.rating) || 0} size={12} />
          <span style={{ fontSize: 10, color: 'var(--text3)' }}>
            {Number(product?.reviews) > 0 ? `(${Number(product.reviews)})` : 'No reviews'}
          </span>
        </div>

        <div
          className="product-card-price"
          style={{
            display: 'flex',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            gap: 6,
            marginTop: 7,
            minWidth: 0,
          }}
        >
          <span
            style={{
              color: isSoldOut ? 'var(--text3)' : 'var(--gold)',
              fontSize: 'clamp(12px, 3.4vw, 15px)',
              fontWeight: 500,
              overflowWrap: 'anywhere',
              maxWidth: '100%',
            }}
          >
            EGP {formatPrice(displayPrice)}
          </span>

          {discount !== null && discount > 0 && (
            <span
              style={{
                color: 'var(--text2)',
                fontSize: 'clamp(10px, 2.8vw, 12px)',
                textDecoration: 'line-through',
                overflowWrap: 'anywhere',
              }}
            >
              EGP {formatPrice(Number(product?.price) || 0)}
            </span>
          )}

          {discount !== null && discount > 0 && !isSoldOut && (
            <span
              style={{
                padding: '3px 6px',
                borderRadius: 2,
                background: 'rgba(192,57,43,0.14)',
                border: '1px solid rgba(192,57,43,0.55)',
                color: 'var(--red)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
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