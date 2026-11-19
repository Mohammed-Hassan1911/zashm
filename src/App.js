import React, { useEffect, useState, useRef, useCallback, Suspense } from 'react';
import './index.css';
import { MotionConfig, motion } from 'framer-motion';
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
  Gem,
  Search,
  X
} from 'lucide-react';

import Header from './components/shop/Header';
import CartDrawer from './components/shop/CartDrawer';
import MobileNav from './components/shop/MobileNav';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { ShopPageSkeleton, ProductPageSkeleton } from './components/ui/PageSkeletons';
import { OrderNotification, Toaster, toast } from './components/ui/BackToTop';
import WhatsAppButton from './components/ui/WhatsAppButton';
import { setPageMeta, setSiteJsonLd } from './lib/seo';
import { trackPageView } from './lib/ga';
import { resolveRoute } from './lib/routes';
import { lazyWithRetry } from './lib/chunkRecovery';

const loadHomePage = () => import('./pages/HomePage');
const loadShopPage = () => import('./pages/ShopPage');
const loadProductPage = () => import('./pages/ProductPage');
const loadTrackOrderPage = () => import('./pages/TrackOrder');
const loadCartPage = () => import('./pages/CartPage');
const loadAdminPage = () => import('./pages/AdminApp');
const loadNotFoundPage = () => import('./pages/NotFoundPage');

const HomePage = lazyWithRetry(loadHomePage);
const ShopPage = lazyWithRetry(loadShopPage);
const ProductPage = lazyWithRetry(loadProductPage);
const TrackOrder = lazyWithRetry(loadTrackOrderPage);
const CartPage = lazyWithRetry(() => loadCartPage().then(module => ({ default: module.CartPage })));
const CheckoutPage = lazyWithRetry(() => loadCartPage().then(module => ({ default: module.CheckoutPage })));
const WishlistPage = lazyWithRetry(() => loadCartPage().then(module => ({ default: module.WishlistPage })));
const AdminApp = lazyWithRetry(loadAdminPage);
const NotFoundPage = lazyWithRetry(loadNotFoundPage);

const PUBLIC_PAGE_LOADERS = [
  loadHomePage,
  loadShopPage,
  loadProductPage,
  loadTrackOrderPage,
  loadCartPage,
  loadNotFoundPage,
];

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
  const refreshOrders = useStore((state) => state.refreshOrders);
  // The bag drawer owns the screen while it is open; WhatsApp sits above every
  // page layer, so remove it for the lifetime of the dialog.
  const cartOpen = useStore((state) => state.cartOpen);

  const [activeModal, setActiveModal] = useState(null);
  // The footer is only added once the first page has actually committed. While a
  // lazy page chunk is still loading, the placeholder above it decides the
  // document height; mounting the footer at that moment made it jump when the
  // real content replaced the loader (CLS 0.103 / 0.146 at 1440px).
  const [firstPageReady, setFirstPageReady] = useState(false);
  const markPageReady = useCallback(() => setFirstPageReady(true), []);
  const trackedFirstView = useRef(false);

  // The owner removed the scroll-to-top action: it kept covering content and
  // was not useful enough to justify the obstruction. WhatsApp stays as the
  // single floating support action (see src/index.css).

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
    }
    // Site identity is global; mount it once and leave it in place across routes.
    setSiteJsonLd();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    // Pause every CSS animation while the tab is in the background. Browsers
    // throttle rAF but keep compositing CSS animations off-screen on mobile,
    // which is what warms the phone up behind a notification shade.
    const sync = () => {
      document.body.classList.toggle('is-page-hidden', document.hidden === true);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      document.body.classList.remove('is-page-hidden');
    };
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
    // Navigation lands at the top instantly: no scroll animation to wait on.
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
      notfound: { title: 'Page Not Found', robots: 'noindex, nofollow' },
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
      // الكوبونات لا تُجلب للواجهة إطلاقاً: تُتحقق عبر /api/coupons/validate
      // وتُدار في لوحة التحكم عبر /api/admin/coupons بعد تسجيل الدخول.
      // الطلبات تتطلب جلسة أدمن — لا نجلبها أبداً لزوار المتجر.
      if (session) {
        await refreshOrders();
      }
    }
    loadOnlineData();
  }, [session, refreshProducts, refreshOrders]);

  useEffect(() => {
    const connection = typeof navigator !== 'undefined' ? navigator.connection : undefined;
    if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return undefined;

    const preload = () => {
      PUBLIC_PAGE_LOADERS.forEach((loadPage) => {
        loadPage().catch((error) => console.error('Storefront page preload failed:', error));
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      const idleHandle = window.requestIdleCallback(preload, { timeout: 2000 });
      return () => window.cancelIdleCallback?.(idleHandle);
    }

    const timeoutHandle = window.setTimeout(preload, 1000);
    return () => window.clearTimeout(timeoutHandle);
  }, []);

  useEffect(() => {
    const route = resolveRoute();
    if (route.page !== 'product' || !route.productId) return;
    const product = useStore.getState().products.find(item => String(item.id) === String(route.productId));
    setSelectedProduct(product || null);
  }, [currentPage, products, setSelectedProduct]);

  if (loading && currentPage === 'admin') {
    return <AppStartupScreen />;
  }

  return (
    <MotionConfig reducedMotion="always">
    <div className="app-shell" style={{ minHeight: '100vh' }}>
      <Toaster />
      <OrderNotification />

      {currentPage === 'admin' ? (
        <React.Suspense
          fallback={<AppStartupScreen />}
        >
          <AdminApp />
        </React.Suspense>
      ) : (
        <>
          <a href="#main-content" className="skip-link">Skip to content</a>
          <Header />
          <CartDrawer />

          <main id="main-content" tabIndex={-1}>
            {/* No page exit animation: the old page used to stay mounted for
                380ms while the new one mounted underneath, so tapping a card
                showed the top of the home page before the product arrived.
                The new page fades in immediately, with no stale route on top. */}
            <motion.div
              key={currentPage}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <Suspense fallback={<PageLoading page={currentPage} />}>
                <PageReadySignal onReady={markPageReady} />
                {currentPage === 'home' && <HomePage />}
                {currentPage === 'shop' && <ShopPage />}
                {currentPage === 'product' && <ProductPage />}
                {currentPage === 'cart' && <CartPage />}
                {currentPage === 'checkout' && <CheckoutPage />}
                {currentPage === 'wishlist' && <WishlistPage />}
                {currentPage === 'track' && <TrackOrder />}
                {currentPage === 'notfound' && <NotFoundPage />}
              </Suspense>
            </motion.div>
          </main>

          {firstPageReady && <Footer setModal={setActiveModal} />}
          <MobileNav />
          {/* The owner keeps the support line on the landing page only, so the
              storefront routes stay quiet; the contact links in the footer and
              on the product page remain the way to reach the store. */}
          {currentPage === 'home' && !cartOpen && <WhatsAppButton />}

          <InfoModal type={activeModal} onClose={() => setActiveModal(null)} />
        </>
      )}
    </div>
    </MotionConfig>
  );
}

// Lives inside the page Suspense boundary, so its effect runs only after the
// real page has committed — never while the loading fallback is on screen.
function PageReadySignal({ onReady }) {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return null;
}

function PageLoading({ page }) {
  // The home page opens with a full-viewport hero. While its lazy chunk loads,
  // reserve exactly that height with the same .home-hero box so the footer
  // below does not jump into place when the hero mounts (CLS).
  if (page === 'home') {
    return (
      <div className="home-hero home-hero-skeleton" role="status" aria-label="Preparing ZASHM">
        <span className="app-startup-indicator" aria-hidden="true">
          <img src="/zashm-z-monogram.webp" alt="" />
        </span>
      </div>
    );
  }
  // /shop and /product are the two routes that were shifting the footer at
  // 1440px. Their skeletons mirror the real layout (same padding, same grid
  // and the same 3:4 image box) instead of a short generic spinner, so the
  // footer keeps its final position while the chunk loads.
  if (page === 'shop') return <ShopPageSkeleton />;
  if (page === 'product') return <ProductPageSkeleton />;
  return <AppStartupScreen compact />;
}

function AppStartupScreen({ compact = false }) {
  const [stalled, setStalled] = useState(false);

  // If a chunk request hangs (slow network / stuck cold start) the startup
  // screen would otherwise stay black forever. Offer a manual reload after a
  // reasonable wait; normal loads finish long before this fires.
  useEffect(() => {
    const timer = window.setTimeout(() => setStalled(true), 10000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={`app-startup-screen${compact ? ' app-page-loading' : ''}`} role="status" aria-label="Preparing ZASHM">
      <span className="app-startup-indicator" aria-hidden="true">
        <img src="/zashm-z-monogram.webp" alt="" />
      </span>
      {stalled && (
        <div className="app-startup-stall">
          <p className="app-startup-stall-text">
            Taking longer than usual.
          </p>
          <button type="button" className="app-startup-stall-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= MODAL COMPONENT ================= */
function InfoModal({ type, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!type) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [type, onClose]);

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
          <p><strong>Return Policy:</strong> You can request an exchange or return within 7 days of receiving your order, provided the items are in their original condition, unworn, in their original package, and with all tags attached.</p>
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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-modal-title"
        onClick={(event) => event.stopPropagation()}
        style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, width: 460, maxWidth: '100%', padding: 24, position: 'relative' }}
      >
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close dialog" style={{ position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer' }}><X size={18} aria-hidden="true" /></button>
        <h3 id="info-modal-title" style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: 18, marginBottom: 16, letterSpacing: 1 }}>{content?.title}</h3>
        <div style={{ color: 'var(--text2)' }}>{content?.text}</div>
      </div>
    </div>
  );
}

/* ================= FOOTER COMPONENT ================= */
const FOOTER_CARE_LINKS = [
  ['Shipping & Returns', 'shipping-returns', Truck],
  ['Privacy Policy', 'privacy', FileText],
];

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
    <footer className="site-footer">
      <div className="footer-shell">
        <div className="footer-grid">

          <div className="footer-brand">
            <div
              className="footer-wordmark"
              onClick={handleFooterLogoClick}
              role="presentation"
            >
              {'ZASHM'.split('').map((letter, index) => (
                <span
                  key={`${letter}-${index}`}
                  className="footer-wordmark-letter"
                  data-letter={letter}
                  style={{ '--letter-i': index, '--letter-index': index }}
                >
                  {letter}
                </span>
              ))}
            </div>
            <p className="footer-blurb">
              <Gem size={14} aria-hidden="true" />
              <span>{'Luxury fashion crafted with elegance and precision for the modern gentleman.'}</span>
            </p>
            <div className="footer-social">
              <a href="https://www.instagram.com/zashm_brand?obrf=MWh1NHhqMWQ4MTRycg%3D%3D&utm_source=qr" target="_blank" rel="noreferrer" aria-label="ZASHM on Instagram"><Instagram size={18} aria-hidden="true" /></a>
              <a href="https://facebook.com/zashm" target="_blank" rel="noreferrer" aria-label="ZASHM on Facebook"><Facebook size={18} aria-hidden="true" /></a>
            </div>
          </div>

          <div className="footer-col footer-col--care">
            <h2 className="footer-col-title">{'Customer Care'}</h2>
            <button type="button" className="footer-link footer-track" onClick={() => setPage('track')}>
              <Search size={13} aria-hidden="true" />
              {'Track Your Order'}
            </button>
            {FOOTER_CARE_LINKS.map(([label, id, Icon]) => (
              <button key={label} type="button" className="footer-link" onClick={() => setModal(id)}>
                <Icon size={13} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          <div className="footer-col footer-contact-col">
            <h2 className="footer-col-title">{'Contact'}</h2>
            <div className="footer-contact">
              <a className="footer-contact-row" href="tel:+201013380313">
                <Phone size={14} aria-hidden="true" />
                <span dir="ltr">01013380313</span>
              </a>
              <a className="footer-contact-row" href="mailto:zashmbrand@gmail.com">
                <Mail size={14} aria-hidden="true" />
                <span>zashmbrand@gmail.com</span>
              </a>
            </div>
          </div>

        </div>
      </div>
    </footer>
  );
}
