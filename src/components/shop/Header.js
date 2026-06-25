import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShoppingBag, Heart, Search } from 'lucide-react';
import { useStore } from '../../store';

export default function Header() {
  const {
    cart = [],
    wishlist = [],
    setPage,
    setCartOpen,
    searchQuery,
    setSearchQuery,
  } = useStore();

  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // SAFE COUNT
  const cartCount = (cart || []).reduce(
    (sum, item) => sum + (item?.qty || 0),
    0
  );

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handler);
    return () => window.removeEventListener('scroll', handler);
  }, []);

  const nav = [
    { name: 'Home', page: 'home' },
    { name: 'Shop', page: 'shop' },
  ];

  // استايل الأزرار والأيقونات باللون الجولد
  const iconButtonStyle = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#D4AF37', 
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    position: 'relative',
    transition: 'transform 0.3s ease',
  };

  // استايل مشترك للعداد (الباج) باللون الجولد
  const badgeStyle = {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 16,
    height: 16,
    padding: '0 4px',

    background: '#D4AF37', // العداد باللون الجولد
    color: '#000000',      // الرقم باللون الأسود ليكون واضحاً جداً

    fontSize: 10,
    fontWeight: 700,

    borderRadius: '999px',

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',

    border: '1.5px solid #000000', // حد أسود ليفصل العداد الجولد عن الأيقونة الجولد
    boxShadow: '0 2px 5px rgba(0,0,0,0.5)',
    lineHeight: 1,
  };

  return (
    <>
      <motion.header
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          background: scrolled ? 'rgba(10,10,10,0.96)' : 'transparent',
          backdropFilter: scrolled ? 'blur(20px)' : 'none',
          borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
          transition: 'all 0.4s ease',
          padding: '0 24px',
        }}
      >
        <div
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            height: 70,
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
          }}
        >

          {/* LOGO (ZASHM) */}
          <motion.button
            onClick={() => setPage('home')}
            style={{
              justifySelf: 'start',
              fontFamily: 'var(--font-display)',
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: 8,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#D4AF37', 
            }}
            whileHover={{ scale: 1.02 }}
          >
            ZASHM
          </motion.button>

          {/* NAV */}
          <nav style={{ display: 'flex', gap: 40, justifySelf: 'center' }}>
            {nav.map((item) => (
              <motion.button
                key={item.name}
                onClick={() => setPage(item.page)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 600,
                  letterSpacing: 2.5,
                  textTransform: 'uppercase',
                  color: 'var(--text2)',
                }}
                whileHover={{ color: '#D4AF37' }}
              >
                {item.name}
              </motion.button>
            ))}
          </nav>

          {/* ACTIONS */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              justifySelf: 'end',
            }}
          >

            {/* SEARCH */}
            <motion.button 
              onClick={() => setSearchOpen(!searchOpen)} 
              style={iconButtonStyle}
              whileHover={{ scale: 1.1 }}
            >
              <Search size={20} />
            </motion.button>

            {/* WISHLIST */}
            <motion.button 
              onClick={() => setPage('wishlist')} 
              style={iconButtonStyle}
              whileHover={{ scale: 1.1 }}
            >
              <Heart size={20} />

              {(wishlist?.length > 0) && (
                <span style={badgeStyle}>
                  {wishlist.length}
                </span>
              )}
            </motion.button>

            {/* BAG */}
            <motion.button
              onClick={() => setCartOpen(true)}
              style={iconButtonStyle}
              whileHover={{ scale: 1.1 }}
            >
              <ShoppingBag size={20} />

              {cartCount > 0 && (
                <span style={badgeStyle}>
                  {cartCount}
                </span>
              )}
            </motion.button>

          </div>
        </div>

        {/* SEARCH BAR */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <div style={{ maxWidth: 600, margin: '0 auto', padding: 16 }}>
                <input
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage('shop');
                  }}
                  placeholder="Search for products..."
                  style={{
                    width: '100%',
                    padding: 12,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                  }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </motion.header>
    </>
  );
}