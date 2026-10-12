// Lightweight SEO helpers for a state-routed SPA: keep <head> metadata and
// structured data in sync as the user navigates, without pulling in a router.

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

// title: page title (brand suffix is appended automatically).
// description: meta description. image: absolute URL. url: canonical URL.
// robots: e.g. 'noindex, nofollow' to keep a page out of search results.
export function setPageMeta({ title, description, image, url, robots } = {}) {
  if (typeof document === 'undefined') return;
  const fullTitle = title ? `${title} — ${BRAND}` : `${BRAND} — Luxury Fashion`;
  const desc = description || DEFAULT_DESC;
  const canonical = url || (typeof window !== 'undefined' ? window.location.href : '');

  document.title = fullTitle;
  setNamed('description', desc);
  setProp('og:title', fullTitle);
  setProp('og:description', desc);
  setProp('og:type', 'website');
  setProp('og:site_name', BRAND);
  setProp('og:url', canonical);
  if (image) setProp('og:image', image);
  setNamed('twitter:card', 'summary_large_image');
  setNamed('twitter:title', fullTitle);
  setNamed('twitter:description', desc);
  if (image) setNamed('twitter:image', image);

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
  const price = Number(product.salePrice || product.price || 0);
  const inStock = Number(product.stock || 0) > 0;
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
