import React, { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useInView } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

export default function HomePage() {
  const { products, productsLoadStatus, refreshProducts, setPage } = useStore();
  const heroRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], ['0%', '30%']);
  const opacity = useTransform(scrollYProgress, [0, 0.8], [1, 0]);

  // 🎯 إخفاء المنتجات غير النشطة عن العملاء (تُفلتر في الـ storefront فقط)
  const activeProducts = products.filter(p => p.active !== false);
  const featured = activeProducts
    .filter(p => p.label === 'Featured' || p.label === 'Best Seller')
    .slice(0, 4);
  const featuredIds = new Set(featured.map(product => product.id));
  const newArrivals = activeProducts
    .filter(p => p.label === 'New Arrival' && !featuredIds.has(p.id))
    .slice(0, 4);
  // The curated sections can leave pieces out (a "Limited Edition" piece, for
  // example). Show the rest in a final "The Collection" row so a small
  // catalogue never hides a product from the home page; with no curated rows at
  // all, the same row becomes the fallback collection.
  const hasCuratedSections = featured.length > 0 || newArrivals.length > 0;
  const curatedIds = new Set([...featured, ...newArrivals].map(product => product.id));
  const fallbackProducts = (hasCuratedSections
    ? activeProducts.filter(product => !curatedIds.has(product.id))
    : activeProducts
  ).slice(0, 4);

  return (
    <div style={{ paddingTop: 0 }}>
      {/* ───── HERO — Old Money Menswear Editorial ───── */}
      <section ref={heroRef} className="home-hero" style={{ position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Black luxury backdrop — soft gold glow */}
        <motion.div data-decor="true" style={{ position: 'absolute', inset: 0, y }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #0a0a0a 0%, #14110a 48%, #0a0a0a 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse clamp(40%, 62vw, 80%) clamp(35%, 52vh, 70%) at 50% 44%, rgba(201,168,76,0.18) 0%, rgba(201,168,76,0.05) 38%, transparent 72%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 34%, rgba(0,0,0,0.72) 100%)' }} />
        </motion.div>

        {/* Twinkling gold dust — subtle luxury sparkle */}
        {[...Array(28)].map((_, i) => {
          const size = 1 + (i % 3) * 0.7;
          return (
            <motion.div data-decor="true" key={i}
              style={{ position: 'absolute', width: `clamp(1px, ${size}px, 2px)`, height: `clamp(1px, ${size}px, 2px)`, borderRadius: '50%', background: 'var(--gold)', boxShadow: '0 0 4px rgba(201,168,76,0.75)', left: `${(i * 37) % 100}%`, top: `${(i * 53) % 100}%`, zIndex: 2, maxWidth: '2px', maxHeight: '2px' }}
              animate={{ opacity: [0.1, 0.85, 0.1], scale: [0.8, 1.15, 0.8] }}
              transition={{ duration: 3 + (i % 5), repeat: Infinity, delay: (i % 7) * 0.45, ease: 'easeInOut' }}
            />
          );
        })}

        {/* Editorial content */}
        <motion.div style={{ position: 'relative', textAlign: 'center', zIndex: 10, opacity, padding: '0 24px' }} className="hero-content">
          <motion.h1
            className="hero-brand"
            aria-label="ZASHM"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(44px, calc(7vw + 22px), 140px)', fontWeight: 400, letterSpacing: 'clamp(4px, 1.6vw, 24px)', lineHeight: 0.95, marginBottom: 'clamp(12px, 2.8vw, 22px)' }}
          >
            <span className="hero-brand-lockup">
              <span className="hero-brand-word" aria-hidden="true">
                {'ZASHM'.split('').map((letter, index) => (
                  <span
                    className="hero-brand-letter"
                    key={`${letter}-${index}`}
                    style={{ '--letter-index': index }}
                  >
                    {letter}
                    {index % 2 === 0 && (
                      <span className="hero-brand-letter-sparkle" aria-hidden="true" />
                    )}
                  </span>
                ))}
              </span>
              <span className="hero-brand-sparkle hero-brand-sparkle--one" aria-hidden="true" />
              <span className="hero-brand-sparkle hero-brand-sparkle--two" aria-hidden="true" />
              <span className="hero-brand-sparkle hero-brand-sparkle--three" aria-hidden="true" />
            </span>
          </motion.h1>

          <motion.p
            className="hero-tagline"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontSize: 'clamp(9px, 1.4vw, 11px)', letterSpacing: 'clamp(2px, 0.7vw, 8px)', textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 'clamp(14px, 3vw, 24px)', fontWeight: 500 }}
          >EST. 2026 · EGYPT</motion.p>

          <motion.p
            className="hero-brand-subtitle"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(17px, 2.4vw, 28px)', color: 'var(--gold)', fontStyle: 'italic', fontWeight: 400, letterSpacing: 'clamp(1.5px, 0.3vw, 4px)', marginBottom: 'clamp(22px, 3.5vw, 34px)', textShadow: '0 2px 20px rgba(201,168,76,0.18)' }}
          >Luxury Menswear</motion.p>

          <motion.div
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.26, duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            style={{ display: 'flex', justifyContent: 'center' }}
          >
            <button 
              className="gold-btn" 
              onClick={() => setPage('shop')}
              style={{ padding: 'clamp(12px, 2vw, 14px) clamp(24px, 6vw, 42px)', fontSize: 'clamp(10px, 1.8vw, 12px)', letterSpacing: 2 }}
            >
              Explore Collection
            </button>
          </motion.div>
        </motion.div>

        <div style={{ position: 'absolute', bottom: 32, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 5, pointerEvents: 'none' }}>
          <motion.button
            type="button"
            aria-label="Scroll to the collection"
            animate={{ y: [0, 8, 0] }} transition={{ duration: 2, repeat: Infinity }}
            onClick={() => window.scrollTo({ top: window.innerHeight, behavior: 'smooth' })}
            style={{ color: 'rgba(255,255,255,0.4)', cursor: 'pointer', background: 'none', border: 'none', padding: 8, minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' }}
          ><ChevronDown size={24} aria-hidden="true" /></motion.button>
        </div>
      </section>

      {productsLoadStatus === 'error' && (
        <div
          role="alert"
          style={{
            maxWidth: 1400,
            margin: '24px auto 0',
            padding: '12px 16px',
            border: '1px solid rgba(217,119,119,0.35)',
            background: 'rgba(217,119,119,0.07)',
            borderRadius: 4,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap'
          }}
        >
          <p style={{ fontSize: 12, color: '#d97777' }}>
            Could not load products.
          </p>
          <button
            type="button"
            onClick={refreshProducts}
            style={{
              padding: '7px 14px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              color: 'var(--text2)',
              cursor: 'pointer',
              fontSize: 11
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ───── LOADING / EMPTY STATE ───── */}
      {activeProducts.length === 0 && productsLoadStatus !== 'error' && (
        <div role="status" aria-live="polite" style={{ maxWidth: 1400, margin: '0 auto', padding: '48px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 12, letterSpacing: 1 }}>
          {productsLoadStatus === 'loading' || productsLoadStatus === 'idle'
            ? 'Loading the collection… '
            : 'New pieces are on their way'}
        </div>
      )}

      {/* ───── FEATURED ───── */}
      {featured.length > 0 && (
        <section style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader title="Featured Pieces" />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {featured.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <button className="outline-btn" onClick={() => setPage('shop')}>View Full Collection</button>
          </div>
        </section>
      )}

      {/* ───── NEW ARRIVALS ───── */}
      {newArrivals.length > 0 && (
        <section style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader title="New Arrivals" />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {newArrivals.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
        </section>
      )}

      {/* ───── THE COLLECTION (remaining pieces, or the fallback) ───── */}
      {fallbackProducts.length > 0 && (
        <section style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader title="The Collection" />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {fallbackProducts.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <button className="outline-btn" onClick={() => setPage('shop')}>View Full Collection</button>
          </div>
        </section>
      )}

    </div>
  );
}

function SectionHeader({ title }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}
      style={{ textAlign: 'center' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(32px, 4vw, 46px)', fontWeight: 400, letterSpacing: 1.5 }}>{title}</h2>
      <div style={{ width: 40, height: 1, background: 'var(--gold)', margin: '20px auto 0' }} />
    </motion.div>
  );
}