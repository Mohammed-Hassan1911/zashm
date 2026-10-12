import React, { useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useInView } from 'framer-motion';
import { ArrowRight, ChevronDown, Award, Truck, Shield, Star } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

export default function HomePage() {
  const { products, setPage, setFilterCategory } = useStore();
  const heroRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], ['0%', '30%']);
  const opacity = useTransform(scrollYProgress, [0, 0.8], [1, 0]);

  // 🎯 إخفاء المنتجات غير النشطة عن العملاء (تُفلتر في الـ storefront فقط)
  const featured = products.filter(p => p.active !== false && (p.label === 'Featured' || p.label === 'Best Seller')).slice(0, 4);
  const newArrivals = products.filter(p => p.active !== false && p.label === 'New Arrival').slice(0, 4);

  return (
    <div style={{ paddingTop: 0 }}>
      {/* ───── HERO — Old Money Menswear Editorial ───── */}
      <section ref={heroRef} style={{ height: '100vh', minHeight: 640, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Black luxury backdrop — soft gold glow */}
        <motion.div style={{ position: 'absolute', inset: 0, y }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #0a0a0a 0%, #14110a 48%, #0a0a0a 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 62% 52% at 50% 44%, rgba(201,168,76,0.18) 0%, rgba(201,168,76,0.05) 38%, transparent 72%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 34%, rgba(0,0,0,0.72) 100%)' }} />
        </motion.div>

        {/* Twinkling gold dust — subtle luxury sparkle */}
        {[...Array(28)].map((_, i) => {
          const size = 1 + (i % 3) * 0.7;
          return (
            <motion.div key={i}
              style={{ position: 'absolute', width: size, height: size, borderRadius: '50%', background: 'var(--gold)', boxShadow: '0 0 4px rgba(201,168,76,0.75)', left: `${(i * 37) % 100}%`, top: `${(i * 53) % 100}%`, zIndex: 2 }}
              animate={{ opacity: [0.1, 0.85, 0.1], scale: [0.8, 1.15, 0.8] }}
              transition={{ duration: 3 + (i % 5), repeat: Infinity, delay: (i % 7) * 0.45, ease: 'easeInOut' }}
            />
          );
        })}

        {/* Editorial content */}
        <motion.div style={{ position: 'relative', textAlign: 'center', zIndex: 10, opacity, padding: '0 24px' }} className="hero-content">
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.2, duration: 0.8 }}
            style={{ width: 80, height: 1, background: 'var(--gold)', margin: '0 auto 32px' }}
          />

          <motion.p
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, duration: 0.8 }}
            style={{ fontSize: 11, letterSpacing: 8, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 32, fontWeight: 500 }}
          >Est. 2026 · Egypt</motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 1 }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(60px, 11vw, 140px)', fontWeight: 300, letterSpacing: 'clamp(8px, 1.5vw, 18px)', lineHeight: 0.95, marginBottom: 28, textShadow: '0 4px 60px rgba(0,0,0,0.7)', color: '#f5f0e8' }}
          >
            ZASHM
          </motion.h1>

          <motion.div
            initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.9, duration: 0.7 }}
            style={{ width: 120, height: 1, background: 'rgba(201,168,76,0.5)', margin: '0 auto 24px' }}
          />

          <motion.p
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.0, duration: 0.8 }}
            style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(18px, 2.2vw, 28px)', color: 'rgba(245,240,232,0.92)', fontStyle: 'italic', fontWeight: 300, letterSpacing: 3, marginBottom: 14, textShadow: '0 2px 20px rgba(0,0,0,0.5)' }}
          >Luxury Menswear</motion.p>

          <motion.p
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2, duration: 0.8 }}
            style={{ fontSize: 13, color: 'rgba(245,240,232,0.65)', maxWidth: 480, margin: '0 auto 44px', letterSpacing: 3.5, lineHeight: 1.9, textTransform: 'uppercase' }}
          >Tailored for the discerning gentleman</motion.p>

          {/* 🎯 تم تعديل هنا: مسح الزر الإضافي وتوسيط الـ Button الأساسي بأناقة ومساحة أكبر */}
          <motion.div
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.4, duration: 0.7 }}
            style={{ display: 'flex', justifyContent: 'center' }}
          >
            <button 
              className="gold-btn" 
              onClick={() => setPage('shop')}
              style={{ padding: '14px 42px', fontSize: 12, letterSpacing: 2 }} // زيادة مساحة الزرار الفاخر لإعطائه هيبة الـ Hero Center
            >
              Explore Collection
            </button>
          </motion.div>
        </motion.div>

        <motion.div
          animate={{ y: [0, 8, 0] }} transition={{ duration: 2, repeat: Infinity }}
          style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', zIndex: 5 }}
          onClick={() => window.scrollTo({ top: window.innerHeight, behavior: 'smooth' })}
        ><ChevronDown size={24} /></motion.div>
      </section>

      {/* ───── BRAND ETHOS STRIP ───── */}
      <section style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', padding: '32px 24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 32 }}>
         {[
            { icon: Award, t: 'Premium Fabrics', s: 'Selected for comfort & durability' },
            { icon: Truck, t: 'Fast Nationwide Shipping', s: 'Delivery across Egypt' },
            { icon: Shield, t: 'Quality Guarantee', s: 'Every item is carefully inspected' },
            { icon: Star, t: 'Exclusive Collections', s: 'Limited seasonal drops' },
          ].map(({ icon: Icon, t, s }, i) => (
            <motion.div key={t} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1 }}
              style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Icon size={22} color="var(--gold)" />
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{t}</p>
                <p style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: 0.5 }}>{s}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </section>

      
      {/* ───── FEATURED ───── */}
      {featured.length > 0 && (
        <section style={{ padding: '60px 24px 100px', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader title="Curated for the Gentleman" subtitle="Featured Pieces" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 24, marginTop: 56 }}>
            {featured.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
          <div style={{ textAlign: 'center', marginTop: 48 }}>
            <button className="outline-btn" onClick={() => setPage('shop')}>View Full Collection</button>
          </div>
        </section>
      )}

      {/* ───── EDITORIAL BANNER ───── */}
      <section style={{ position: 'relative', height: 460, margin: '60px 0', overflow: 'hidden', background: '#0a0a0a' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(160deg, #0a0a0a 0%, #14110a 50%, #0a0a0a 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 55% 90% at 22% 50%, rgba(201,168,76,0.18) 0%, rgba(201,168,76,0.05) 40%, transparent 75%)' }} />
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.7) 100%)' }} />
        </div>

        {[...Array(16)].map((_, i) => {
          const size = 1 + (i % 3) * 0.6;
          return (
            <motion.div key={i}
              style={{ position: 'absolute', width: size, height: size, borderRadius: '50%', background: 'var(--gold)', boxShadow: '0 0 4px rgba(201,168,76,0.7)', left: `${(i * 29) % 100}%`, top: `${(i * 61) % 100}%`, zIndex: 2 }}
              animate={{ opacity: [0.1, 0.8, 0.1], scale: [0.8, 1.15, 0.8] }}
              transition={{ duration: 3 + (i % 4), repeat: Infinity, delay: (i % 6) * 0.5, ease: 'easeInOut' }}
            />
          );
        })}

        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 8%', zIndex: 3 }}>
          <motion.div initial={{ opacity: 0, x: -30 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ duration: 0.8 }}
            style={{ maxWidth: 520 }}>
            <p style={{ color: 'var(--gold)', fontSize: 10, letterSpacing: 6, textTransform: 'uppercase', marginBottom: 18 }}>The Autumn Edit</p>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(36px, 5vw, 56px)', fontWeight: 400, marginBottom: 18, lineHeight: 1.1 }}>
              A return to <em style={{ color: 'var(--gold)' }}>quiet elegance</em>
            </h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.8, maxWidth: 420 }}>
              Wool, linen and cashmere — chosen for how they fall, not the label. The pieces that outlast the season.
            </p>
          </motion.div>
        </div>
      </section>

      {/* ───── NEW ARRIVALS ───── */}
      {newArrivals.length > 0 && (
        <section style={{ padding: '60px 24px 100px', maxWidth: 1400, margin: '0 auto' }}>
          <SectionHeader title="The Latest Arrivals" subtitle="Just In" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 24, marginTop: 56 }}>
            {newArrivals.map((p, i) => <ProductCard key={p.id} product={p} index={i} />)}
          </div>
        </section>
      )}

      {/* ───── MANIFESTO ───── */}
      <section style={{ padding: '110px 24px', background: 'var(--bg2)', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
        <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.9 }}
          style={{ maxWidth: 820, margin: '0 auto' }}>
          <div style={{ width: 60, height: 1, background: 'var(--gold)', margin: '0 auto 36px' }} />
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4.2vw, 52px)', fontWeight: 300, lineHeight: 1.25, color: 'var(--text)', letterSpacing: 1, marginBottom: 28 }}>
            For the man who has <em style={{ color: 'var(--gold)' }}>nothing left to prove</em>.
          </p>
          <p style={{ fontSize: 12, letterSpacing: 5, textTransform: 'uppercase', color: 'var(--text3)' }}>
            Timeless pieces, quietly made in Cairo
          </p>
        </motion.div>
      </section>
    </div>
  );
}

function SectionHeader({ title, subtitle }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}
      style={{ textAlign: 'center' }}>
      <p style={{ fontSize: 10, letterSpacing: 5, color: 'var(--gold)', textTransform: 'uppercase', marginBottom: 12, fontWeight: 500 }}>{subtitle}</p>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(32px, 4vw, 46px)', fontWeight: 400, letterSpacing: 1.5 }}>{title}</h2>
      <div style={{ width: 40, height: 1, background: 'var(--gold)', margin: '20px auto 0' }} />
    </motion.div>
  );
}