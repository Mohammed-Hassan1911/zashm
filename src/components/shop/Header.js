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
  const [isMobile, setIsMobile] = useState(false);

  // SAFE COUNT
  const cartCount = (cart || []).reduce(
    (sum, item) => sum + (item?.qty || 0),
    0
  );

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 40);
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    
    // التشغيل المبدئي
    handleScroll();
    handleResize();

    window.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
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
    padding: isMobile ? '4px' : 0, // زيادة مساحة اللمس على الموبايل
    position: 'relative',
    transition: 'transform 0.3s ease',
  };

  // استايل مشترك للعداد (الباج) باللون الجولد
  const badgeStyle = {
    position: 'absolute',
    top: isMobile ? -4 : -6,
    right: isMobile ? -4 : -8,
    minWidth: 15,
    height: 15,
    padding: '0 3px',
    background: '#D4AF37',
    color: '#000000',
    fontSize: 9,
    fontWeight: 700,
    borderRadius: '999px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1.5px solid #000000',
    boxShadow: '0 2px 5px rgba(0,0,0,0.5)',
    lineHeight: 1,
  };

  return (
    <>
      <motion.header
        className="zashm-header"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          background: scrolled ? 'rgba(10,10,10,0.78)' : 'transparent',
          backdropFilter: scrolled ? 'blur(22px) saturate(140%)' : 'none',
          WebkitBackdropFilter: scrolled ? 'blur(22px) saturate(140%)' : 'none',
          borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
          boxShadow: scrolled ? '0 8px 24px rgba(0,0,0,0.18)' : 'none',
          transition: 'all 0.4s ease',
          padding: isMobile ? '0 16px' : '0 24px',
        }}
      >
        <div
          className="zashm-header-inner"
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            height: isMobile ? 60 : 70,
          }}
        >
          <div className="zashm-header-brand">
            <motion.button
              className="zashm-header-logo"
              onClick={() => setPage('home')}
              aria-label="ZASHM home"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
              whileHover={{ scale: 1.02 }}
            >
              <img src="/zashm-z-monogram.png?v=3" alt="" />
            </motion.button>

            {!isMobile && (
              <nav className="zashm-header-nav">
                {nav.map((item) => (
                  <motion.button
                    key={item.name}
                    onClick={() => setPage(item.page)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      color: 'var(--text2)',
                    }}
                    whileHover={{ color: '#D4AF37' }}
                  >
                    {item.name}
                  </motion.button>
                ))}
              </nav>
            )}
          </div>

          {/* ACTIONS */}
          <div
            className="zashm-header-actions"
            style={{
              display: 'flex',
            }}
          >
            <motion.button
              className="zashm-header-search"
              onClick={() => setSearchOpen(!searchOpen)}
              style={iconButtonStyle}
              whileHover={{ scale: 1.1 }}
              aria-label="Search products"
            >
              <Search size={isMobile ? 18 : 20} />
            </motion.button>

            <div className="zashm-header-utilities">
              {/* WISHLIST */}
              <motion.button
                onClick={() => setPage('wishlist')}
                style={iconButtonStyle}
                whileHover={{ scale: 1.1 }}
                aria-label="Wishlist"
              >
                <Heart size={isMobile ? 18 : 20} />
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
                aria-label={`Shopping bag${cartCount > 0 ? `, ${cartCount} items` : ''}`}
              >
                <ShoppingBag size={isMobile ? 18 : 20} />
                {cartCount > 0 && (
                  <span
                    style={{
                      ...badgeStyle,
                      top: isMobile ? -3 : -2,
                      right: isMobile ? -2 : 0,
                    }}
                  >
                    {cartCount}
                  </span>
                )}
              </motion.button>
            </div>

          </div>
        </div>

        {/* SEARCH BAR */}
        <AnimatePresence>
          {searchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ borderTop: '1px solid var(--border)', overflow: 'hidden' }}
            >
              <div style={{ maxWidth: 600, margin: '0 auto', padding: isMobile ? 12 : 16 }}>
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
                    borderRadius: 4,
                    fontSize: 14,
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