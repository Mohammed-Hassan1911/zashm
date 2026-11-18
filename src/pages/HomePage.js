import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import { ChevronDown, Truck, Banknote, Gem } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

const HOUSE_PROMISES = [
  { Icon: Truck, title: 'Delivery across Egypt', copy: 'Every governorate, straight to your door.' },
  { Icon: Banknote, title: 'Cash on delivery', copy: 'Inspect the piece before you pay.' },
  { Icon: Gem, title: '7-day exchanges', copy: 'Unworn, with tags and original packaging.' },
];

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
        {/* The hero does not paint its own base colour: the ambient wall behind
            the whole app shows through, so the home page opens on the same lit
            room as every other route. Only the gold glow and the vignette are
            drawn here, both transparent. */}
        <motion.div data-decor="true" style={{ position: 'absolute', inset: 0, y }}>
          {/* clamp()/min() are not valid inside a radial-gradient size (Chromium
              drops the whole layer), so the glow is sized in percentages of the
              hero box — which is already viewport-width and viewport-height. */}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 62% 52% at 50% 44%, rgba(201,168,76,0.2) 0%, rgba(201,168,76,0.055) 38%, transparent 72%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,0.42) 100%)' }} />
        </motion.div>

        {/* Twinkling gold dust — subtle luxury sparkle. Plain divs with a CSS
            keyframe: 28 Framer Motion nodes each wrote an inline style on every
            frame, which is 28 style recalcs the compositor never needed. */}
        {[...Array(28)].map((_, i) => {
          const size = 1 + (i % 3) * 0.7;
          return (
            <div
              data-decor="true"
              key={i}
              className="hero-dust"
              aria-hidden="true"
              style={{
                width: `clamp(1px, ${size}px, 2px)`,
                height: `clamp(1px, ${size}px, 2px)`,
                left: `${(i * 37) % 100}%`,
                top: `${(i * 53) % 100}%`,
                maxWidth: '2px',
                maxHeight: '2px',
                animationDuration: `${3 + (i % 5)}s`,
                animationDelay: `${(i % 7) * 0.45}s`,
              }}
            />
          );
        })}

        {/* Editorial content */}
        <motion.div style={{ position: 'relative', textAlign: 'center', zIndex: 10, opacity, padding: '0 24px' }} className="hero-content">
          {/* The wordmark below is decorative art; this is the real page heading. */}
          <h1 className="sr-only">ZASHM — Luxury Menswear</h1>

          <motion.div
            className="hero-brand"
            aria-hidden="true"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.55, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(44px, calc(7vw + 22px), 140px)', fontWeight: 400, letterSpacing: 'clamp(4px, 1.6vw, 24px)', lineHeight: 0.95, marginBottom: 'clamp(12px, 2.8vw, 22px)' }}
          >
            <span className="hero-brand-lockup">
              <span className="hero-brand-word" aria-hidden="true">
                {'ZASHM'.split('').map((letter, index) => (
                  <span
                    className="hero-brand-letter"
                    key={`${letter}-${index}`}
                    data-letter={letter}
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
          </motion.div>

          <motion.p
            className="hero-tagline"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontSize: 'clamp(9px, 1.4vw, 11px)', letterSpacing: 'clamp(2px, 0.7vw, 8px)', textTransform: 'uppercase', marginBottom: 'clamp(14px, 3vw, 24px)', fontWeight: 500 }}
          >EST. 2026 · EGYPT</motion.p>

          <motion.p
            className="hero-brand-subtitle"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(17px, 2.4vw, 28px)', fontStyle: 'italic', fontWeight: 400, letterSpacing: 'clamp(1.5px, 0.3vw, 4px)', marginBottom: 'clamp(22px, 3.5vw, 34px)' }}
          >Luxury Menswear</motion.p>

          <motion.div
            initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.26, duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
            className="hero-actions"
          >
            <button
              className="gold-btn home-glass-btn"
              onClick={() => setPage('shop')}
            >
              Explore Collection
            </button>
          </motion.div>
        </motion.div>

        <div className="hero-scroll-cue-wrap">
          <button
            type="button"
            aria-label="Scroll to the collection"
            className="hero-scroll-cue"
            onClick={() => window.scrollTo({ top: window.innerHeight, behavior: 'smooth' })}
          >
            <span className="hero-scroll-cue-line" aria-hidden="true" />
            <ChevronDown size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* ───── THE HOUSE PROMISE ───── */}
      <section className="home-promises" aria-label="The ZASHM promise">
        <div className="home-promises-inner">
          {HOUSE_PROMISES.map(({ Icon, title, copy }, index) => (
            <motion.div
              className="home-promise"
              key={title}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.5, delay: index * 0.08 }}
            >
              <span className="home-promise-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.5} /></span>
              <div>
                <p className="home-promise-title">{title}</p>
                <p className="home-promise-copy">{copy}</p>
              </div>
            </motion.div>
          ))}
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
        <section className="home-collection" style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader eyebrow="Selected" title="Featured Pieces" count={featured.length} />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {featured.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <button className="outline-btn home-glass-btn" onClick={() => setPage('shop')}>View Full Collection</button>
          </div>
        </section>
      )}

      {/* ───── NEW ARRIVALS ───── */}
      {newArrivals.length > 0 && (
        <section id="home-new-arrivals" className="home-collection" style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader eyebrow="Just in" title="New Arrivals" count={newArrivals.length} />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {newArrivals.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
        </section>
      )}

      {/* ───── THE COLLECTION (remaining pieces, or the fallback) ───── */}
      {fallbackProducts.length > 0 && (
        <section id="home-collection" className="home-collection" style={{ padding: 'clamp(44px, 8vw, 60px) clamp(16px, 4vw, 24px) clamp(64px, 12vw, 100px)', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader eyebrow="The edit" title="The Collection" count={fallbackProducts.length} />
          <div className="product-collection-grid" style={{ marginTop: 'clamp(28px, 5vw, 56px)' }}>
            {fallbackProducts.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <button className="outline-btn home-glass-btn" onClick={() => setPage('shop')}>View Full Collection</button>
          </div>
        </section>
      )}

    </div>
  );
}

function SectionHeader({ eyebrow, title, count }) {
  return (
    <motion.div
      className="section-head"
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.6 }}
    >
      {eyebrow && <p className="section-head-eyebrow">{eyebrow}</p>}
      <h2 className="section-head-title">{title}</h2>
      <span className="section-head-ornament" aria-hidden="true" />
      {typeof count === 'number' && count > 0 && (
        <p className="section-head-count" aria-hidden="true">
          {String(count).padStart(2, '0')} pieces
        </p>
      )}
    </motion.div>
  );
}
