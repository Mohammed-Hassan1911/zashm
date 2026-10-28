import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Home, Grid, Heart, ShoppingBag, Globe } from 'lucide-react';
import { useStore } from '../../store';
import { getLanguage, setLanguage, t } from '../../lib/i18n';

export default function MobileNav() {
  const { setPage, currentPage, cart, wishlist, setCartOpen } = useStore();
  const safeCart = cart || [];
  const cartCount = safeCart.reduce((s, i) => s + i.qty, 0);
  const [lang, setLangState] = useState(getLanguage());

  useEffect(() => {
    const handler = () => setLangState(getLanguage());
    window.addEventListener('languagechange', handler);
    return () => window.removeEventListener('languagechange', handler);
  }, []);

  const toggleLang = () => {
    const newLang = lang === 'en' ? 'ar' : 'en';
    setLangState(newLang);
    setLanguage(newLang);
    window.dispatchEvent(new Event('languagechange'));
  };

  const items = [
    { icon: Home, label: t('home', lang), page: 'home' },
    { icon: Grid, label: t('shop', lang), page: 'shop' },
    { icon: Heart, label: t('wishlist', lang), page: 'wishlist', badge: wishlist.length },
    { icon: ShoppingBag, label: t('bag', lang), action: () => setCartOpen(true), badge: cartCount },
  ];

  return (
    <motion.nav
      initial={{ y: 80 }}
      animate={{ y: 0 }}
      transition={{ delay: 0.5, type: 'spring', stiffness: 200 }}
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 900,
        background: 'rgba(17,17,17,0.96)', backdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--border)',
        display: 'none', padding: '8px 0 max(8px, env(safe-area-inset-bottom))',
      }}
      className="mobile-nav"
    >
      <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
        {items.map(({ icon: Icon, label, page, action, badge }) => {
          const active = currentPage === page;
          return (
            <motion.button
              key={label}
              onClick={action || (() => setPage(page))}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 12px', background: 'none', border: 'none', cursor: 'pointer', position: 'relative', color: active ? 'var(--gold)' : 'var(--text3)' }}
              whileTap={{ scale: 0.9 }}
            >
              <div style={{ position: 'relative' }}>
                <Icon size={20} />
                {badge > 0 && (
                  <span style={{ position: 'absolute', top: -6, right: -6, width: 15, height: 15, borderRadius: '50%', background: 'var(--gold)', color: 'var(--bg)', fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{badge}</span>
                )}
              </div>
              <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
              {active && (
                <motion.div layoutId="mobile-nav-indicator"
                  style={{ position: 'absolute', bottom: -8, width: 4, height: 4, borderRadius: '50%', background: 'var(--gold)' }} />
              )}
            </motion.button>
          );
        })}
        <motion.button
          onClick={toggleLang}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '4px 12px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)' }}
          whileTap={{ scale: 0.9 }}
        >
          <Globe size={20} />
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: 1 }}>{lang === 'en' ? 'AR' : 'EN'}</span>
        </motion.button>
      </div>
    </motion.nav>
  );
}
