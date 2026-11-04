import React from 'react';

// Route-shaped loading placeholders. They mirror the real page padding, heading
// scale, toolbar and 3:4 product image box (see the .page-skeleton* rules in
// index.css) so the layout below — including the footer — keeps its final
// position while a lazy chunk or the product list is still loading.

export function ShopPageSkeleton() {
  return (
    <div className="page-skeleton page-skeleton-shop" role="status" aria-label="Loading the collection">
      <div className="page-skeleton-shop-header">
        <span className="page-skeleton-line" style={{ width: 120, height: 10, margin: '0 auto 18px' }} />
        <span className="page-skeleton-line" style={{ width: 'min(520px, 70%)', height: 'clamp(32px, 5vw, 64px)', margin: '0 auto 14px' }} />
        <span className="page-skeleton-line" style={{ width: 140, height: 10, margin: '0 auto' }} />
      </div>
      <div className="page-skeleton-shop-toolbar" aria-hidden="true">
        <span className="page-skeleton-pill" />
        <span className="page-skeleton-pill" style={{ width: 64 }} />
        <span className="page-skeleton-pill" style={{ width: 96 }} />
        <span className="page-skeleton-pill" style={{ width: 118, marginLeft: 'auto' }} />
      </div>
      <div className="page-skeleton-shop-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((n) => (
          <div className="page-skeleton-card" key={n}>
            <span className="page-skeleton-card-image" />
            <div className="page-skeleton-card-info">
              <span className="page-skeleton-line" style={{ width: '38%', height: 10, marginBottom: 8 }} />
              <span className="page-skeleton-line" style={{ width: '78%', height: 14 }} />
              <span className="page-skeleton-line" style={{ width: '42%', height: 13, marginTop: 12 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ProductPageSkeleton() {
  return (
    <div className="page-skeleton page-skeleton-product" role="status" aria-label="Loading the product">
      <div className="page-skeleton-product-container">
        <span className="page-skeleton-line page-skeleton-product-back" aria-hidden="true" />
        <span className="page-skeleton-line page-skeleton-product-crumbs" aria-hidden="true" />
        <div className="page-skeleton-product-grid" aria-hidden="true">
          <span className="page-skeleton-product-image" />
          <div className="page-skeleton-product-info">
            <span className="page-skeleton-line" style={{ width: '55%', height: 14 }} />
            <span className="page-skeleton-line" style={{ width: '85%', height: 30 }} />
            <span className="page-skeleton-line" style={{ width: '35%', height: 18 }} />
            <span className="page-skeleton-line" style={{ width: '100%', height: 1, marginTop: 14 }} />
            <span className="page-skeleton-line" style={{ width: '22%', height: 11, marginTop: 8 }} />
            <span className="page-skeleton-line" style={{ width: '100%', height: 40, marginTop: 8 }} />
            <span className="page-skeleton-line" style={{ width: '100%', height: 40, marginTop: 12 }} />
            <span className="page-skeleton-line" style={{ width: '100%', height: 48, marginTop: 16 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
