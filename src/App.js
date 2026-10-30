import React, { useEffect, useState, useRef, Suspense } from 'react';
import './index.css';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './store';
import { AuthProvider, useAuth } from './lib/auth'; 
import {
  Instagram,
  Facebook,
  Ruler,
  Truck,
  FileText,
  Phone,
  Mail,
  Home,
  ShoppingBag,
  Heart,
  Gem,
  Search, 
  X
} from 'lucide-react';

import Header from './components/shop/Header';
import CartDrawer from './components/shop/CartDrawer';
import MobileNav from './components/shop/MobileNav';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { BackToTop, OrderNotification, Toaster, toast } from './components/ui/BackToTop';
import WhatsAppButton from './components/ui/WhatsAppButton';
import { setPageMeta } from './lib/seo';
import { trackPageView } from './lib/ga';
import { resolveRoute } from './lib/routes';

const HomePage = React.lazy(() => import('./pages/HomePage'));
const ShopPage = React.lazy(() => import('./pages/ShopPage'));
const ProductPage = React.lazy(() => import('./pages/ProductPage'));
const TrackOrder = React.lazy(() => import('./pages/TrackOrder'));
const CartPage = React.lazy(() => import('./pages/CartPage').then(module => ({ default: module.CartPage })));
const CheckoutPage = React.lazy(() => import('./pages/CartPage').then(module => ({ default: module.CheckoutPage })));
const WishlistPage = React.lazy(() => import('./pages/CartPage').then(module => ({ default: module.WishlistPage })));
const AdminApp = React.lazy(() => import('./pages/AdminApp'));

if (typeof window !== 'undefined') {
  window.toast = toast;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const { currentPage, syncPageFromLocation, setSelectedProduct, products } = useStore();
  const { session, loading } = useAuth(); 
  
  const refreshProducts = useStore((state) => state.refreshProducts);
  const refreshDiscounts = useStore((state) => state.refreshDiscounts);
  const refreshOrders = useStore((state) => state.refreshOrders);

  const [activeModal, setActiveModal] = useState(null);
  const trackedFirstView = useRef(false);

  useEffect(() => {
    let frame = 0;

    const updateFloatingActions = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        if (!isMobile) {
          document.body.classList.remove(
            'mobile-whatsapp-obstructed',
            'mobile-back-to-top-obstructed'
          );
          return;
        }

        const floatingActions = [
          ['.whatsapp-fab', 'mobile-whatsapp-obstructed'],
          ['.back-to-top', 'mobile-back-to-top-obstructed'],
        ];
        const content = document.querySelectorAll(
          '[role="button"], button:not(.back-to-top), a:not(.whatsapp-fab), input, textarea, select, .site-footer p, .site-footer h4, .product-page p, .product-page h1, .product-page h2, .product-page .product-card-image'
        );

        floatingActions.forEach(([selector, className]) => {
          const action = document.querySelector(selector);
          const actionRect = action?.getBoundingClientRect();
          const obstructed = actionRect && [...content].some((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            return (
              actionRect.left < rect.right &&
              actionRect.right > rect.left &&
              actionRect.top < rect.bottom &&
              actionRect.bottom > rect.top
            );
          });

          document.body.classList.toggle(className, Boolean(obstructed));
        });
      });
    };

    updateFloatingActions();
    window.addEventListener('scroll', updateFloatingActions, { passive: true });
    window.addEventListener('resize', updateFloatingActions);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', updateFloatingActions);
      window.removeEventListener('resize', updateFloatingActions);
      document.body.classList.remove(
        'mobile-whatsapp-obstructed',
        'mobile-back-to-top-obstructed'
      );
    };
  }, [currentPage, products]);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const route = syncPageFromLocation();
      if (route.page === 'product' && route.productId) {
        const product = useStore.getState().products.find(item => String(item.id) === String(route.productId));
        setSelectedProduct(product || null);
      }
    };

    handlePopState();
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setSelectedProduct, syncPageFromLocation]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [currentPage]); 

  // Keep the document title / meta description in sync with the active page.
  useEffect(() => {
    const META = {
      home: { title: 'Home' },
      shop: { title: 'Shop', description: 'Browse the full ZASHM collection — premium clothing with delivery across Egypt.' },
      product: { title: 'Product' },
      cart: { title: 'Your Bag', robots: 'noindex, nofollow' },
      checkout: { title: 'Checkout', robots: 'noindex, nofollow' },
      wishlist: { title: 'Wishlist', robots: 'noindex, nofollow' },
      track: { title: 'Track Your Order', robots: 'noindex, nofollow' },
      admin: { title: 'Admin', robots: 'noindex, nofollow' },
    };
    const meta = META[currentPage] || {};
    setPageMeta(meta);

    // The initial page_view is sent by gtag 'config'; track later navigations.
    if (trackedFirstView.current) {
      trackPageView(
        `${window.location.pathname}${window.location.search}`,
        meta.title ? `${meta.title} — ZASHM` : undefined
      );
    } else {
      trackedFirstView.current = true;
    }
  }, [currentPage]);

  useEffect(() => {
    async function loadOnlineData() {
      await refreshProducts();
      await refreshDiscounts();
      // الطلبات تتطلب جلسة أدمن — لا نجلبها أبداً لزوار المتجر.
      if (session) {
        await refreshOrders();
      }
    }
    loadOnlineData();
  }, [session, refreshProducts, refreshDiscounts, refreshOrders]);

  useEffect(() => {
    const route = resolveRoute();
    if (route.page !== 'product' || !route.productId) return;
    const product = useStore.getState().products.find(item => String(item.id) === String(route.productId));
    setSelectedProduct(product || null);
  }, [currentPage, products, setSelectedProduct]);

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

      {currentPage === 'admin' ? (
        <React.Suspense
          fallback={
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
              <p style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)', letterSpacing: 2 }}>LOADING ADMIN...</p>
            </div>
          }
        >
          <AdminApp />
        </React.Suspense>
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
              <Suspense fallback={<PageLoading />}>
                {currentPage === 'home' && <HomePage />}
                {currentPage === 'shop' && <ShopPage />}
                {currentPage === 'product' && <ProductPage />}
                {currentPage === 'cart' && <CartPage />}
                {currentPage === 'checkout' && <CheckoutPage />}
                {currentPage === 'wishlist' && <WishlistPage />}
                {currentPage === 'track' && <TrackOrder />}
              </Suspense>
            </motion.div>
          </AnimatePresence>

          <Footer setModal={setActiveModal} />
          <MobileNav />
          <BackToTop />
          <WhatsAppButton />

          <InfoModal type={activeModal} onClose={() => setActiveModal(null)} />
        </>
      )}
    </div>
  );
}

function PageLoading() {
  return (
    <div style={{ minHeight: '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontFamily: 'var(--font-display)', letterSpacing: 2 }}>
      Loading...
    </div>
  );
}

/* ================= MODAL COMPONENT ================= */
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
          <p>We use the information you provide, such as your name, phone number, email address, and delivery address, to process orders and provide customer support.</p>
          <p>To deliver your order, the details needed for shipment may be shared with the courier or delivery provider. We limit this sharing to what is needed to complete delivery.</p>
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

/* ================= FOOTER COMPONENT ================= */
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
    <footer className="site-footer" style={{ background: 'var(--bg2)', borderTop: '1px solid var(--border)', padding: '60px 0 40px', marginTop: 80 }}>
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
            <p style={{ display: 'flex', gap: 8, color: 'var(--text2)', fontSize: 13, lineHeight: 1.8, marginBottom: 20 }}>
              <Gem size={14} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 3 }} />
              <span>{'Luxury fashion crafted with elegance and precision for the modern gentleman.'}</span>
            </p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <a href="https://www.instagram.com/zashm_brand?obrf=MWh1NHhqMWQ4MTRycg%3D%3D&utm_source=qr" target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}><Instagram size={18} /></a>
              <a href="https://facebook.com/zashm" target="_blank" rel="noreferrer" style={{ color: 'var(--gold)' }}><Facebook size={18} /></a>
            </div>
          </div>

          <div>
            <h4 style={titleStyle}>{'Quick Links'}</h4>
            {[
              ['Home', 'home', Home],
              ['Shop', 'shop', ShoppingBag],
              ['Wishlist', 'wishlist', Heart]
            ].map(([label, page, Icon]) => (
              <button key={label} onClick={() => setPage(page)} style={{ ...linkStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon size={13} style={{ color: 'var(--gold)', flexShrink: 0 }} />
                {label}
              </button>
            ))}
          </div>

          <div>
  <h4 style={titleStyle}>{'Customer Care'}</h4>
  
  {/* 🎯 تحويل الـ button إلى motion.button لإضافة الأنيميشن الذكي */}
  <motion.button 
    onClick={() => setPage('track')} 
    style={{ 
      ...linkStyle, 
      display: 'inline-flex', // استخدام inline-flex لضمان حركة الـ Scale من المنتصف بشكل صحيح
      alignItems: 'center', 
      gap: 8, 
      color: 'var(--text2)', // 🌟 تم تعديله للأبيض (أو رمادي الفوتر الطبيعي) ليتناسق مع الباقيين
      background: 'none',
      border: 'none',
      cursor: 'pointer'
    }}
    // ✨ أنيميشن النبض الهادئ لجذب الانتباه تلقائياً
    animate={{ 
      scale: [1, 1.03, 1],
      opacity: [0.8, 1, 0.8]
    }}
    // ✨ وميض وإضاءة ذهبية فخمة جداً لما العميل يمرر الماوس عليه (Hover)
    whileHover={{
      scale: 1.05,
      color: 'var(--gold)',
      textShadow: '0px 0px 8px var(--gold)'
    }}
    transition={{ 
      duration: 3,         // حركة التنفس هادية وبطيئة على مدار 3 ثوانٍ لتليق ببراند فاخر
      repeat: Infinity,    // تكرار لانهائي
      ease: "easeInOut"
    }}
  >
    <Search size={13} style={{ opacity: 0.9, color: 'var(--gold)' }} />
    {'Track Your Order'}
  </motion.button>

  {[
    ['Shipping & Returns', 'shipping-returns', Truck],
    ['Privacy Policy', 'privacy', FileText]
  ].map(([label, id, Icon]) => (
    <button key={label} onClick={() => setModal(id)} style={{ ...linkStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon size={13} style={{ opacity: 0.8, color: 'var(--gold)' }} />
      {label}
    </button>
  ))}
</div>

          <div>
            <h4 style={titleStyle}>{'Contact'}</h4>
            <div style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 2.2 }}>
              <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Phone size={14} style={{ color: 'var(--gold)', flexShrink: 0 }} />
                <span dir="ltr">01013380313</span>
              </p>
              <p style={{ display: 'flex', alignItems: 'center', gap: 8, wordBreak: 'break-all' }}>
                <Mail size={14} style={{ color: 'var(--gold)', flexShrink: 0 }} />
                <span>zashmbrand@gmail.com</span>
              </p>
            </div>
          </div>

        </div>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 48, paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <p style={{ color: '#C9A84C', fontSize: 12 }}> © ZASHM Luxury Fashion 2026. {'All rights reserved.'}</p>
        </div>

      </div>
    </footer>
  );
}

const titleStyle = { fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: 'var(--gold)', marginBottom: 20, fontWeight: 600 };
const linkStyle = { display: 'block', marginBottom: 12, color: 'var(--text2)', fontSize: 13, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' };