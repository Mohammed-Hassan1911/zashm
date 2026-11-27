// Lightweight SEO helpers for a state-routed SPA: keep <head> metadata and
// structured data in sync as the user navigates, without pulling in a router.
import { canonicalUrl } from './product-url.mjs';
import { availableStock, effectivePrice } from './pricing';

const BRAND = 'ZASHM';
const DEFAULT_DESC =
  'ZASHM — luxury fashion crafted with elegance and precision. Shop premium clothing with delivery across Egypt.';

function upsert(selector, create) {
  if (typeof document === 'undefined') return null;
  let el = document.head.querySelector(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  return el;
}

function setNamed(name, content) {
  if (content == null) return;
  const el = upsert(`meta[name="${name}"]`, () => {
    const m = document.createElement('meta');
    m.setAttribute('name', name);
    return m;
  });
  if (el) el.setAttribute('content', content);
}

function setProp(property, content) {
  if (content == null) return;
  const el = upsert(`meta[property="${property}"]`, () => {
    const m = document.createElement('meta');
    m.setAttribute('property', property);
    return m;
  });
  if (el) el.setAttribute('content', content);
}

// The storefront always advertises the brand image: a product that has no photo
// still inherits the site card instead of keeping a stale product URL from the
// previous page. Resolve against the canonical URL first, then the live origin.
function defaultOgImage(canonical) {
  const base = canonical || (typeof window !== 'undefined' ? window.location.origin : '');
  if (!base) return '/og-image.jpg';
  try {
    return new URL('/og-image.jpg', base).href;
  } catch {
    return `${String(base).replace(/\/+$/, '')}/og-image.jpg`;
  }
}

// title: page title (brand suffix is appended automatically).
// description: meta description. image: absolute URL. url: canonical URL.
// robots: e.g. 'noindex, nofollow' to keep a page out of search results.
// preserveTitle: refresh the other tags without replacing a product title that
// is already correct (the shell prerenders it before React hydrates).
export function setPageMeta({ title, description, image, url, robots, preserveTitle = false } = {}) {
  if (typeof document === 'undefined') return;
  const fullTitle = preserveTitle && document.title
    ? document.title
    : title ? `${title} — ${BRAND}` : `${BRAND} — Luxury Fashion`;
  const desc = description || DEFAULT_DESC;
  const canonical = url || (typeof window !== 'undefined'
    ? canonicalUrl(window.location.pathname, window.location.origin)
    : '');
  const socialImage = image || defaultOgImage(canonical);

  document.title = fullTitle;
  setNamed('description', desc);
  setProp('og:title', fullTitle);
  setProp('og:description', desc);
  setProp('og:type', 'website');
  setProp('og:site_name', BRAND);
  setProp('og:url', canonical);
  setProp('og:image', socialImage);
  setNamed('twitter:card', 'summary_large_image');
  setNamed('twitter:title', fullTitle);
  setNamed('twitter:description', desc);
  setNamed('twitter:image', socialImage);

  if (robots) {
    setNamed('robots', robots);
  } else {
    const r = document.head.querySelector('meta[name="robots"]');
    if (r) r.setAttribute('content', 'index, follow');
  }

  if (canonical) {
    const link = upsert('link[rel="canonical"]', () => {
      const l = document.createElement('link');
      l.setAttribute('rel', 'canonical');
      return l;
    });
    if (link) link.setAttribute('href', canonical);
  }
}

// Inject the site-wide Organization + WebSite graph once. Search engines use it
// to understand the brand and the site itself (sitelinks search box, logo).
// This node is separate from the per-product JSON-LD so clearing a product page
// never removes the site identity.
export function setSiteJsonLd() {
  if (typeof document === 'undefined') return;
  const id = 'zashm-site-jsonld';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  const fallbackOrigin = typeof __ZASHM_SITE_ORIGIN__ !== 'undefined' && __ZASHM_SITE_ORIGIN__
    ? __ZASHM_SITE_ORIGIN__
    : 'https://za-shm.vercel.app';
  const origin = typeof window !== 'undefined'
    ? window.location.origin
    : fallbackOrigin;
  const base = origin.replace(/\/+$/, '');
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${base}/#organization`,
        name: BRAND,
        url: `${base}/`,
        logo: `${base}/zashm-z-monogram.png`,
        image: `${base}/og-image.jpg`,
        sameAs: [
          'https://www.instagram.com/zashm_brand',
          'https://facebook.com/zashm',
        ],
      },
      {
        '@type': 'WebSite',
        '@id': `${base}/#website`,
        name: BRAND,
        url: `${base}/`,
        inLanguage: 'en',
        publisher: { '@id': `${base}/#organization` },
      },
    ],
  };
  el.textContent = JSON.stringify(data);
}

// Inject/refresh Product structured data for rich search results.
export function setProductJsonLd(product) {
  if (typeof document === 'undefined' || !product) return;
  const id = 'zashm-product-jsonld';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = id;
    document.head.appendChild(el);
  }
  const images = Array.isArray(product.images) ? product.images.filter(Boolean) : [];
  const price = effectivePrice(product);
  // Availability must mirror the storefront: a product with variants is only
  // in stock when at least one declared size × color variant has stock; the
  // legacy `stock` column is the aggregate and is not updated per variant.
  const inStock = availableStock(product) > 0;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name || '',
    description: product.description || undefined,
    image: images.length ? images : undefined,
    sku: product.sku || undefined,
    category: product.category || undefined,
    brand: { '@type': 'Brand', name: BRAND },
    offers: {
      '@type': 'Offer',
      price: Number.isFinite(price) ? price : 0,
      priceCurrency: 'EGP',
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: typeof window !== 'undefined' ? window.location.href : origin,
    },
  };
  el.textContent = JSON.stringify(data);
}

export function clearProductJsonLd() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('zashm-product-jsonld');
  if (el) el.remove();
}

// Remove the canonical link entirely (used by not-found states, where pointing
// search engines at the dead URL would be wrong).
export function clearCanonical() {
  if (typeof document === 'undefined') return;
  const el = document.head.querySelector('link[rel="canonical"]');
  if (el) el.remove();
}
