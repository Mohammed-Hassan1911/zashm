import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Heart, Eye } from 'lucide-react';
import { useStore } from '../../store';

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

  // variantStock هو المصدر الأساسي للتوفر عند وجود المقاسات أو المتغيرات.
  const variantStock =
    product?.variantStock &&
    typeof product.variantStock === 'object' &&
    !Array.isArray(product.variantStock)
      ? product.variantStock
      : null;

  const hasVariants =
    !!variantStock && Object.keys(variantStock).length > 0;

  const variantTotal = hasVariants
    ? Object.values(variantStock).reduce(
        (sum, quantity) => sum + (Number(quantity) || 0),
        0
      )
    : null;

  const isSoldOut = hasVariants
    ? variantTotal <= 0
    : (Number(product?.stock) || 0) <= 0;

  const images = Array.isArray(product?.images)
    ? product.images.filter(Boolean)
    : [];

  const imageIndex = imgIdx < images.length ? imgIdx : 0;
  const currentImage = images[imageIndex] || FALLBACK_IMAGE;

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

  const discount =
    Number(product?.salePrice) > 0 && Number(product?.price) > 0
      ? Math.round(
          (1 - Number(product.salePrice) / Number(product.price)) * 100
        )
      : null;

  const displayPrice =
    Number(product?.salePrice) > 0
      ? Number(product.salePrice)
      : Number(product?.price) || 0;

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
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.35,
        delay: Math.min(Math.max(index, 0), 8) * 0.04,
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
      aria-label={`View ${product?.name || 'product'}`}
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
          src={currentImage}
          alt={product?.name || 'Product'}
          loading={index < 4 ? 'eager' : 'lazy'}
          decoding="async"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = FALLBACK_IMAGE;
          }}
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

        {/* PRODUCT LABELS */}
        <div
          className="product-card-labels"
          style={{
            position: 'absolute',
            top: 'clamp(6px, 2vw, 12px)',
            left: 'clamp(6px, 2vw, 12px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 6,
            maxWidth: 'calc(100% - 56px)',
            minWidth: 0,
            pointerEvents: 'none',
          }}
        >
          {isSoldOut ? (
            <span
              style={{
                display: 'inline-block',
                maxWidth: '100%',
                background: 'rgba(10, 10, 10, 0.88)',
                color: '#e74c3c',
                border: '1px solid #e74c3c',
                fontSize: 10,
                fontWeight: 600,
                padding: '4px 8px',
                borderRadius: 2,
                textTransform: 'uppercase',
                letterSpacing: 1,
                overflowWrap: 'anywhere',
              }}
            >
              Sold Out
            </span>
          ) : (
            product?.label && (
              <span
                className={`label-badge ${
                  LABEL_CLASS[product.label] || ''
                }`}
                style={{
                  maxWidth: '100%',
                  overflowWrap: 'anywhere',
                }}
              >
                {product.label}
              </span>
            )
          )}

          {discount !== null && discount > 0 && !isSoldOut && (
            <span
              style={{
                display: 'block',
                background: 'var(--red)',
                color: '#fff',
                fontSize: 9,
                padding: '3px 7px',
                borderRadius: 2,
                width: 'fit-content',
              }}
            >
              -{discount}%
            </span>
          )}
        </div>

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
              if (product?.id) toggleWishlist(product.id);
            }}
            whileTap={{ scale: 0.92 }}
            style={{
              width: 36,
              height: 36,
              minWidth: 36,
              minHeight: 36,
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
              width: 36,
              height: 36,
              minWidth: 36,
              minHeight: 36,
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
                color: 'var(--text3)',
                fontSize: 'clamp(10px, 2.8vw, 12px)',
                textDecoration: 'line-through',
                overflowWrap: 'anywhere',
              }}
            >
              EGP {formatPrice(Number(product?.price) || 0)}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}