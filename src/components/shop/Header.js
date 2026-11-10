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
    color: 'var(--gold)', 
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: isMobile ? '4px' : 0, // زيادة مساحة اللمس على الموبايل
    position: 'relative',
    transition: 'transform 0.3s ease',
  };

  // الأيقونة نفسها هي مرجع العداد، مش مساحة اللمس (42px). لو العداد اتحط
  // بالنسبة للزرار كان بيبعد عن الأيقونة ~19px ويبان معلّق في الهوا.
  const iconWrapStyle = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 0,
  };

  // Shared badge (counter) style in gold. It sits just above the icon box
  // (not on the artwork) with a 1px gap, keeps the icon fully visible and
  // stays inside the header without touching a neighbouring control.
  const badgeStyle = {
    position: 'absolute',
    top: -7,
    right: -7,
    minWidth: 15,
    height: 15,
    padding: '0 3px',
    background: 'var(--gold)',
    color: 'var(--bg)',
    fontSize: 9,
    fontWeight: 700,
    borderRadius: '999px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1.5px solid var(--bg)',
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
              <img src="/zashm-z-monogram.webp" alt="" />
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
                    whileHover={{ color: 'var(--gold)' }}
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
                aria-label={wishlist?.length > 0
                  ? `Wishlist, ${wishlist.length} item${wishlist.length === 1 ? '' : 's'}`
                  : 'Wishlist'}
              >
                <span style={iconWrapStyle}>
                  <Heart size={isMobile ? 18 : 20} />
                  {(wishlist?.length > 0) && (
                    <span style={badgeStyle} aria-hidden="true">
                      {wishlist.length}
                    </span>
                  )}
                </span>
              </motion.button>

              {/* BAG */}
              <motion.button
                onClick={() => setCartOpen(true)}
                style={iconButtonStyle}
                whileHover={{ scale: 1.1 }}
                aria-label={cartCount > 0
                  ? `Shopping bag, ${cartCount} item${cartCount === 1 ? '' : 's'}`
                  : 'Shopping bag'}
              >
                <span style={iconWrapStyle}>
                  <ShoppingBag size={isMobile ? 18 : 20} />
                  {cartCount > 0 && (
                    <span style={badgeStyle} aria-hidden="true">
                      {cartCount}
                    </span>
                  )}
                </span>
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
                <label htmlFor="site-search" className="sr-only">Search products</label>
                <input
                  id="site-search"
                  type="search"
                  name="search"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage('shop');
                  }}
                  placeholder="Search for products..."
                  autoFocus
                  style={{
                    width: '100%',
                    padding: 12,
                    minHeight: 44,
                    border: '1px solid var(--border)',
                    background: 'var(--bg3)',
                    color: 'var(--text)',
                    borderRadius: 4,
                    fontSize: 16,
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