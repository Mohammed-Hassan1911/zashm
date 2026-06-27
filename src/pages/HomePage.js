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

  const featured = products.filter(p => p.label === 'Featured' || p.label === 'Best Seller').slice(0, 4);
  const newArrivals = products.filter(p => p.label === 'New Arrival').slice(0, 4);

  return (
    <div style={{ paddingTop: 0 }}>
      {/* ───── HERO — Old Money Menswear Editorial ───── */}
      <section ref={heroRef} style={{ height: '100vh', minHeight: 640, position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Primary editorial image — gentleman in tailored attire */}
        <motion.div style={{ position: 'absolute', inset: 0, y }}>
          
          {/* Cinematic gradient overlay — dark luxury */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(10,10,10,0.55) 0%, rgba(10,10,10,0.35) 30%, rgba(10,10,10,0.55) 65%, rgba(10,10,10,0.92) 100%)' }} />
          {/* Vignette */}
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 30%, rgba(10,10,10,0.6) 100%)' }} />
        </motion.div>


        {/* Floating gold particles — subtle luxury sparkle */}
        {[...Array(6)].map((_, i) => (
          <motion.div key={i}
            style={{ position: 'absolute', width: 2, height: 2, borderRadius: '50%', background: 'var(--gold)', opacity: 0.4, left: `${15 + i * 14}%`, top: `${20 + (i % 3) * 20}%`, zIndex: 2 }}
            animate={{ y: [0, -20, 0], opacity: [0.4, 0.8, 0.4] }}
            transition={{ duration: 3 + i, repeat: Infinity, delay: i * 0.5 }}
          />
        ))}

        {/* Editorial content */}
        <motion.div style={{ position: 'relative', textAlign: 'center', zIndex: 10, opacity, padding: '0 24px' }} className="hero-content">
          <motion.div
            initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: 1, scaleX: 1 }} transition={{ delay: 0.2, duration: 0.8 }}
            style={{ width: 80, height: 1, background: 'var(--gold)', margin: '0 auto 32px' }}
          />

          <motion.p
            initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, duration: 0.8 }}
            style={{ fontSize: 11, letterSpacing: 8, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 32, fontWeight: 500 }}
          >Maison Établie · MMXXIV</motion.p>

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
          >Luxury Old Money Menswear</motion.p>

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
      <section style={{ position: 'relative', height: 460, margin: '60px 0', overflow: 'hidden' }}>
        <img
          src="https://images.unsplash.com/photo-1593030761757-71fae45fa0e7?w=1800&q=90&auto=format&fit=crop"
          loading="lazy"
          alt="ZASHM Editorial"
          style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'contrast(1.1) saturate(0.85) brightness(0.7)' }}
        />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, rgba(10,10,10,0.92) 0%, rgba(10,10,10,0.55) 50%, rgba(10,10,10,0.3) 100%)' }} />
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: '0 8%' }}>
          <motion.div initial={{ opacity: 0, x: -30 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ duration: 0.8 }}
            style={{ maxWidth: 520 }}>
            <p style={{ color: 'var(--gold)', fontSize: 10, letterSpacing: 6, textTransform: 'uppercase', marginBottom: 18 }}>The Autumn Edit</p>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(36px, 5vw, 56px)', fontWeight: 400, marginBottom: 18, lineHeight: 1.1 }}>
              A return to <em style={{ color: 'var(--gold)' }}>quiet elegance</em>
            </h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.8, marginBottom: 28, maxWidth: 420 }}>
              Cashmere from Lake Como. Wool from Biella. Linen woven in family mills since 1908. The pieces that outlast the season.
            </p>
            <button className="gold-btn" onClick={() => setPage('shop')}>Explore the Edit</button>
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

      {/* ───── TESTIMONIALS — Gentlemen ───── */}
      <section style={{ padding: '90px 24px', background: 'var(--bg2)', borderTop: '1px solid var(--border)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <SectionHeader title="From Our Gentlemen" subtitle="Letters of Patronage" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24, marginTop: 56 }}>
            {[
              { name: 'Mr. Karim H.', loc: 'Cairo', text: 'The cashmere polo is without question the finest piece of knitwear I own. Worth every pound.' },
              { name: 'Mr. Tarek A.', loc: 'Dubai', text: 'ZASHM understands the modern gentleman — restrained, tailored, never showy. My new house.' },
              { name: 'Mr. Youssef M.', loc: 'London', text: 'The linen shirts rival what I bring back from Como. Service is impeccable. A genuine luxury house.' },
            ].map((t, i) => (
              <motion.div key={i} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.12 }}
                style={{ padding: '32px 28px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 }}>
                <div style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: 40, lineHeight: 0.5, marginBottom: 14 }}>"</div>
                <p style={{ fontStyle: 'italic', color: 'var(--text2)', fontSize: 14, lineHeight: 1.8, marginBottom: 22 }}>{t.text}</p>
                <div style={{ width: 28, height: 1, background: 'var(--gold)', marginBottom: 12 }} />
                <p style={{ fontSize: 12, fontWeight: 600, letterSpacing: 1 }}>{t.name}</p>
                <p style={{ fontSize: 10, color: 'var(--text3)', letterSpacing: 1.5, textTransform: 'uppercase' }}>{t.loc}</p>
              </motion.div>
            ))}
          </div>
        </div>
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