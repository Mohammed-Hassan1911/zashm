import React from 'react';
import { ChevronDown, Truck, Banknote, Gem } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

const HOUSE_PROMISES = [
  { Icon: Truck, title: 'Delivery across Egypt', copy: 'Every governorate, straight to your door.' },
  { Icon: Banknote, title: 'Cash on delivery', copy: 'Inspect the piece before you pay.' },
  { Icon: Gem, title: '7-day exchanges', copy: 'Unworn, with tags and original packaging.' },
];

// A deliberately short list: six motes are enough to read as air in the light.
// They sit inside one field that owns the twinkle, so the whole haze is a
// single animated layer; each mote is a 1–2px static dot.
const HERO_DUST = [
  { left: '12%', top: '22%', size: 2 },
  { left: '82%', top: '18%', size: 1.5 },
  { left: '24%', top: '72%', size: 1.5 },
  { left: '88%', top: '66%', size: 2 },
  { left: '8%', top: '48%', size: 1 },
  { left: '70%', top: '84%', size: 1 },
];

export default function HomePage() {
  const { products, productsLoadStatus, refreshProducts, setPage } = useStore();

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
      <section className="home-hero" style={{ position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* The hero does not paint its own base colour: the ambient wall behind
            the whole app shows through, so the home page opens on the same lit
            room as every other route. Only the gold glow and the vignette are
            drawn here, both transparent. */}
        <div data-decor="true" style={{ position: 'absolute', inset: 0 }}>
          {/* clamp()/min() are not valid inside a radial-gradient size (Chromium
              drops the whole layer), so the glow is sized in percentages of the
              hero box — which is already viewport-width and viewport-height. */}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 62% 52% at 50% 44%, rgba(201,168,76,0.2) 0%, rgba(201,168,76,0.055) 38%, transparent 72%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,0.42) 100%)' }} />
        </div>

        {/* Six dust motes in one field. The field owns the single twinkle and
            the motes are static dots, so the haze costs one animation, not six;
            every frame is opacity only and the shadows are painted once. */}
        <div className="hero-dust-field" data-decor="true" aria-hidden="true">
          {HERO_DUST.map((mote, index) => (
            <span
              key={index}
              className="hero-dust"
              style={{
                width: `${mote.size}px`,
                height: `${mote.size}px`,
                left: mote.left,
                top: mote.top,
              }}
            />
          ))}
        </div>

        {/* Editorial content */}
        <div style={{ position: 'relative', textAlign: 'center', zIndex: 10, padding: '0 24px' }} className="hero-content">
          {/* The wordmark below is decorative art; this is the real page heading. */}
          <h1 className="sr-only">ZASHM — Luxury Menswear</h1>

          <div
            className="hero-brand"
            aria-hidden="true"
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
                  </span>
                ))}
              </span>
              <span className="hero-brand-sparkle hero-brand-sparkle--one" aria-hidden="true" />
              <span className="hero-brand-sparkle hero-brand-sparkle--two" aria-hidden="true" />
              <span className="hero-brand-sparkle hero-brand-sparkle--three" aria-hidden="true" />
            </span>
          </div>

          <p
            className="hero-tagline"
            style={{ fontSize: 'clamp(9px, 1.4vw, 11px)', letterSpacing: 'clamp(2px, 0.7vw, 8px)', textTransform: 'uppercase', marginBottom: 'clamp(14px, 3vw, 24px)', fontWeight: 500 }}
          >EST. 2026 · EGYPT</p>

          <p
            className="hero-brand-subtitle"
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(17px, 2.4vw, 28px)', fontStyle: 'italic', fontWeight: 400, letterSpacing: 'clamp(1.5px, 0.3vw, 4px)', marginBottom: 'clamp(22px, 3.5vw, 34px)' }}
          >Luxury Menswear</p>

          <div className="hero-actions">
            <button
              className="gold-btn home-glass-btn"
              onClick={() => setPage('shop')}
            >
              Explore Collection
            </button>
          </div>
        </div>

        <div className="hero-scroll-cue-wrap">
          <button
            type="button"
            aria-label="Scroll to the collection"
            className="hero-scroll-cue"
            onClick={() => window.scrollTo(0, window.innerHeight)}
          >
            <span className="hero-scroll-cue-line" aria-hidden="true" />
            <ChevronDown className="hero-scroll-cue-arrow" size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* ───── THE HOUSE PROMISE ───── */}
      <section className="home-promises" aria-label="The ZASHM promise">
        <div className="home-promises-inner">
          {HOUSE_PROMISES.map(({ Icon, title, copy }) => (
            <div
              className="home-promise"
              key={title}
            >
              <span className="home-promise-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.5} /></span>
              <div>
                <p className="home-promise-title">{title}</p>
                <p className="home-promise-copy">{copy}</p>
              </div>
            </div>
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
    <div className="section-head">
      {eyebrow && <p className="section-head-eyebrow">{eyebrow}</p>}
      <h2 className="section-head-title">{title}</h2>
      <span className="section-head-ornament" aria-hidden="true" />
      {typeof count === 'number' && count > 0 && (
        <p className="section-head-count" aria-hidden="true">
          {String(count).padStart(2, '0')} pieces
        </p>
      )}
    </div>
  );
}
