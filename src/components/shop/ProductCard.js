import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Heart, Eye } from 'lucide-react';
import { useStore } from '../../store';

const LABEL_CLASS = {
  'New Arrival': 'label-new',
  'Best Seller': 'label-best',
  'Featured': 'label-featured',
  'Limited Edition': 'label-limited',
};

export default function ProductCard({ product, index = 0 }) {
  const {
    toggleWishlist,
    wishlist,
    setPage,
    setSelectedProduct,
    addRecentlyViewed
  } = useStore();

  const [imgIdx, setImgIdx] = useState(0);

  const isWished = (wishlist || []).includes(product?.id);
  
  // 🎯 التحقق مما إذا كان المنتج نافداً من المخزون بالكامل
  const isSoldOut = (product?.stock ?? 0) <= 0;

  // 🔥 FIX: force new object reference
  const handleView = () => {
    if (!product?.id) return;

    setImgIdx(0);

    setSelectedProduct({
      ...product,
      _ts: Date.now() // 👈 force re-render even if same product
    });

    addRecentlyViewed(product.id);
    setPage('product');
  };

  const discount =
    product?.salePrice && product?.price
      ? Math.round((1 - product.salePrice / product.price) * 100)
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.06 }}
      whileHover={{ y: -6 }}
      style={{ cursor: 'pointer', position: 'relative' }}
      onClick={handleView}
    >
      {/* IMAGE */}
      <div
        style={{
          position: 'relative',
          aspectRatio: '3/4',
          overflow: 'hidden',
          background: 'var(--bg3)'
        }}
        onMouseEnter={() =>
          !isSoldOut && (product?.images?.length ?? 0) > 1 && setImgIdx(1)
        }
        onMouseLeave={() => setImgIdx(0)}
      >
        <motion.img
          src={
            product?.images?.[imgIdx] ||
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect fill="%23ccc" width="100" height="100"/%3E%3C/svg%3E'
          }
          alt={product?.name || 'Product'}
          style={{ 
            width: '100%', 
            height: '100%', 
            objectFit: 'cover',
            opacity: isSoldOut ? 0.4 : 1 // تقليل إضاءة الصورة لو خلص ليعطي إيحاء الـ Sold out
          }}
          animate={{ scale: imgIdx === 1 ? 1.06 : 1 }}
          transition={{ duration: 0.5 }}
        />

        {/* LABELS & SOLD OUT BADGE */}
        <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* شارة الـ Sold Out الاحترافية الفخمة */}
          {isSoldOut ? (
            <span
              style={{
                display: 'inline-block',
                background: 'rgba(10, 10, 10, 0.85)',
                color: '#e74c3c',
                border: '1px solid #e74c3c',
                fontSize: 10,
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: 2,
                textTransform: 'uppercase',
                letterSpacing: 1
              }}
            >
              Sold Out
            </span>
          ) : (
            // شارات المنتج العادية تظهر فقط لو المنتج متوفر
            product?.label && (
              <span className={`label-badge ${LABEL_CLASS[product.label] || ''}`}>
                {product.label}
              </span>
            )
          )}

          {discount && !isSoldOut && (
            <span
              style={{
                display: 'block',
                background: 'var(--red)',
                color: '#fff',
                fontSize: 9,
                padding: '3px 8px',
                borderRadius: 2,
                width: 'fit-content'
              }}
            >
              -{discount}%
            </span>
          )}
        </div>

        {/* ACTIONS */}
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <motion.button
            onClick={(e) => {
              e.stopPropagation();
              if (product?.id) toggleWishlist(product.id);
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'rgba(10,10,10,0.8)',
              border: '1px solid var(--border)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Heart
              size={14}
              fill={isWished ? '#e74c3c' : 'none'}
              color={isWished ? '#e74c3c' : 'white'}
            />
          </motion.button>

          <motion.button
            onClick={(e) => {
              e.stopPropagation();
              handleView();
            }}
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'rgba(10,10,10,0.8)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Eye size={14} color="white" />
          </motion.button>
        </div>
      </div>
      
      {/* INFO */}
      <div style={{ padding: '14px 4px', opacity: isSoldOut ? 0.6 : 1 }}>
        <p style={{ fontSize: 10, color: 'var(--text3)' }}>
          {product?.category || 'General'}
        </p>

        <p style={{ fontSize: 16, fontWeight: 500, textDecoration: isSoldOut ? 'line-through' : 'none' }}>
          {product?.name}
        </p>

        <div style={{ marginTop: 6 }}>
          <span style={{ color: isSoldOut ? 'var(--text3)' : 'var(--gold)' }}>
            EGP {(product?.salePrice || product?.price || 0).toLocaleString()}
          </span>
        </div>
      </div>
    </motion.div>
  );
}