import React, { useEffect, useState, useRef } from 'react';
import './index.css';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './store';
import { AuthProvider, useAuth } from './lib/auth'; // ✨ تم إصلاح سطر الـ Import هنا
import {
  ShieldCheck,
  Instagram,
  Facebook,
  Ruler,
  Truck,
  FileText,
  X
} from 'lucide-react';

import Header from './components/shop/Header';
import HomePage from './pages/HomePage';
import ShopPage from './pages/ShopPage';
import ProductPage from './pages/ProductPage';
import { CartPage, CheckoutPage, WishlistPage } from './pages/CartPage';
import AdminApp from './pages/AdminApp';
import CartDrawer from './components/shop/CartDrawer';
import MobileNav from './components/shop/MobileNav';
import { BackToTop, OrderNotification, Toaster, toast } from './components/ui/BackToTop';

// جعل الـ toast متوفر عالمياً في كل ملفات المشروع تلقائياً 🚀
if (typeof window !== 'undefined') {
  window.toast = toast;
}

export default function App() {
  return (
    <AuthProvider>
      <AppInner />
    </AuthProvider>
  );
}

function AppInner() {
  const { currentPage, setPage } = useStore();
  const { session, loading } = useAuth(); // سحب الجلسة وحالة التحميل
  
  const refreshProducts = useStore((state) => state.refreshProducts);
  const refreshDiscounts = useStore((state) => state.refreshDiscounts);
  const refreshOrders = useStore((state) => state.refreshOrders);

  const [activeModal, setActiveModal] = useState(null);

  // 🎯 السطر السحري: أول ما الـ currentPage تتغير (home, shop, checkout...)، الشاشة تطلع فوق فوراً إجباري
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [currentPage]); // القوس ده معناه اسمع لتغيير الصفحة واطلع فوق علطول

  useEffect(() => {
    async function loadOnlineData() {
      await refreshProducts();
      await refreshDiscounts();
      await refreshOrders();
    }
    loadOnlineData();
  }, [refreshProducts, refreshDiscounts, refreshOrders]);

  // ✨ تعديل القفل الذكي: لو الـ Auth لسه بيحمل الجلسة من الـ Storage، ننتظر ثواني منعا للتضارب والطرد
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
        <p style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', letterSpacing: 2 }}>ZASHM SECURE LOADING...</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <Toaster />
      <OrderNotification />

      {/* ✨ التعديل الجوهري: التوجيه لصفحة الأدمن يعتمد على الحالة المستقرة */}
      {currentPage === 'admin' ? (
        <AdminApp />
      ) : (
        <>
          <Header />
          <CartDrawer />

          <AnimatePresence mode="wait">
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.35 }}
            >
              {currentPage === 'home' && <HomePage />}
              {currentPage === 'shop' && <ShopPage />}
              {currentPage === 'product' && <ProductPage />}
              {currentPage === 'cart' && <CartPage />}
              {currentPage === 'checkout' && <CheckoutPage />}
              {currentPage === 'wishlist' && <WishlistPage />}
            </motion.div>
          </AnimatePresence>

          <Footer setModal={setActiveModal} />
          <MobileNav />
          <BackToTop />

          {/* مودال عرض السياسات والمقاسات */}
          <InfoModal type={activeModal} onClose={() => setActiveModal(null)} />
        </>
      )}
    </div>
  );
}

/* ================= MODAL COMPONENT (نافذة عرض تفاصيل السياسات) ================= */
function InfoModal({ type, onClose }) {
  if (!type) return null;

  const content = {
    'size-guide': {
      title: 'Standard Size Guide',
      text: (
        <div>
          <p style={{ marginBottom: 12, color: 'var(--gold)' }}>* Note: Standard fit. Exact measurements may vary slightly depending on the factory and item type (T-shirts/Trousers). Check specific product pages for item-specific charts.</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--gold)' }}>
                <th style={{ padding: 8, textAlign: 'left' }}>Size</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Chest (cm)</th>
                <th style={{ padding: 8, textAlign: 'left' }}>Waist (cm)</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid var(--border)' }}><td style={{ padding: 8 }}>M</td><td style={{ padding: 8 }}>96 - 100</td><td style={{ padding: 8 }}>84 - 88</td></tr>
              <tr style={{ borderBottom: '1px solid var(--border)' }}><td style={{ padding: 8 }}>L</td><td style={{ padding: 8 }}>104 - 108</td><td style={{ padding: 8 }}>92 - 96</td></tr>
              <tr style={{ borderBottom: '1px solid var(--border)' }}><td style={{ padding: 8 }}>XL</td><td style={{ padding: 8 }}>112 - 116</td><td style={{ padding: 8 }}>100 - 104</td></tr>
              <tr style={{ borderBottom: '1px solid var(--border)' }}><td style={{ padding: 8 }}>XXL</td><td style={{ padding: 8 }}>120 - 124</td><td style={{ padding: 8 }}>108 - 112</td></tr>
            </tbody>
          </table>
        </div>
      )
    },
    'shipping-returns': {
      title: 'Shipping & Returns Policy',
      text: (
        <div style={{ fontSize: 13, lineHeight: 1.6, display: 'grid', gap: 12 }}>
          <p><strong>Standard Shipping:</strong> Delivery within 4-8 business days across Egypt.</p>
          <p><strong>Return Policy:</strong> You can request a return or exchange within 7 days of receiving your order, provided the items are in their original package, unworn, and with all tags attached.</p>
          <p><strong>Inspection:</strong> You have the right to inspect the quality of the fabrics upon delivery before paying the courier.</p>
        </div>
      )
    },
    'privacy': {
      title: 'Privacy Policy',
      text: (
        <div style={{ fontSize: 13, lineHeight: 1.6, display: 'grid', gap: 12 }}>
          <p>At ZASHM, we highly respect your privacy. Your personal information (Name, Phone number, Delivery address) is exclusively used to process your orders and enhance your shopping experience.</p>
          <p>We secure your data via end-to-end encrypted databases and we never share your details with any third-party marketing companies.</p>
        </div>
      )
    }
  }[type];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, width: 460, maxWidth: '100%', padding: 24, position: 'relative' }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}><X size={18} /></button>
        <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: 18, marginBottom: 16, letterSpacing: 1 }}>{content?.title}</h3>
        <div style={{ color: 'var(--text2)' }}>{content?.text}</div>
      </div>
    </div>
  );
}

/* ================= FOOTER COMPONENT (النسخة السرية المحمية) ================= */
function Footer({ setModal }) {
  const { setPage } = useStore();

  const [clickCount, setClickCount] = useState(0);
  const timerRef = useRef(null);

  const handleFooterLogoClick = () => {
    if (timerRef.current) clearTimeout(timerRef.current);

    const newCount = clickCount + 1;
    setClickCount(newCount);

    if (newCount === 5) {
      setPage('admin');
      setClickCount(0);
      return;
    }

    timerRef.current = setTimeout(() => {
      setClickCount(0);
    }, 1500);
  };

  return (
    <footer style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', padding: '60px 0 40px', marginTop: 80 }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 48 }}>
          
          <div>
            <div 
              className="shimmer-text" 
              onClick={handleFooterLogoClick}
              style={{ 
                fontFamily: 'var(--font-display)', 
                fontSize: 24, 
                fontWeight: 600, 
                letterSpacing: 6, 
                marginBottom: 20, 
                lineHeight: 1, 
                cursor: 'pointer',
                userSelect: 'none', 
                outline: 'none'
              }}
            >
              ZASHM
            </div>
            <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.8, marginBottom: 20 }}>Luxury fashion crafted with elegance and precision for the modern gentleman.</p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <a href="https://instagram.com/zashm" target="_blank" rel="noreferrer" style={{ color: 'var(--text2)' }}><Instagram size={18} /></a>
              <a href="https://facebook.com/zashm" target="_blank" rel="noreferrer" style={{ color: 'var(--text2)' }}><Facebook size={18} /></a>
            </div>
          </div>

          <div>
            <h4 style={titleStyle}>Quick Links</h4>
            {[
              ['Home', 'home'],
              ['Shop', 'shop'],
              ['Wishlist', 'wishlist']
            ].map(([label, page]) => (
              <button key={label} onClick={() => setPage(page)} style={linkStyle}>{label}</button>
            ))}
          </div>

          <div>
            <h4 style={titleStyle}>Customer Care</h4>
            {[
              ['Shipping & Returns', 'shipping-returns', Truck],
              ['Privacy Policy', 'privacy', FileText]
            ].map(([label, id, Icon]) => (
              <button key={label} onClick={() => setModal(id)} style={{ ...linkStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon size={13} style={{ opacity: 0.8 }} />
                {label}
              </button>
            ))}
          </div>

          <div>
            <h4 style={titleStyle}>Contact</h4>
            <div style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 2.2 }}>
              <p>📞 01013380313</p>
              <p style={{ wordBreak: 'break-all' }}>✉️ mohammedbusinessmail1@gmail.com</p>
            </div>
          </div>

        </div>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 48, paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: '#C9A84C', fontSize: 12 }}> © 2026 ZASHM Luxury Fashion. All rights reserved.</p> 
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--gold)', fontSize: 12 }}>
            <ShieldCheck size={14} />
            <span>Secure SHA-256 SSL Encryption</span>
          </div>
        </div>

      </div>
    </footer>
  );
}

const titleStyle = { fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 20, fontWeight: 600 };
const linkStyle = { display: 'block', marginBottom: 12, color: 'var(--text2)', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' };