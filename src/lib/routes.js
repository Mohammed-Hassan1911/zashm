const STATIC_ROUTES = {
  home: '/',
  shop: '/shop',
  cart: '/cart',
  checkout: '/checkout',
  wishlist: '/wishlist',
  track: '/track',
  admin: '/admin',
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveRoute(location = window.location) {
  const pathname = location?.pathname || '/';
  const search = new URLSearchParams(location?.search || '');
  const segments = pathname.split('/').filter(Boolean).map(safeDecode);

  if (search.has('track')) {
    return { page: 'track', productId: null, trackId: search.get('track') };
  }

  if (segments[0] === 'product') {
    return { page: 'product', productId: segments[1] || null, trackId: null };
  }

  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const page = Object.keys(STATIC_ROUTES).find((key) => STATIC_ROUTES[key] === normalizedPath);
  return { page: page || 'home', productId: null, trackId: null };
}

export function pageUrl(page, selectedProduct, currentLocation = typeof window !== 'undefined' ? window.location : null) {
  if (page === 'product') {
    const productId = selectedProduct?.id;
    return productId == null ? '/product' : `/product/${encodeURIComponent(String(productId))}`;
  }

  const path = STATIC_ROUTES[page] || '/';
  if (page === 'track') {
    const trackId = new URLSearchParams(currentLocation?.search || '').get('track');
    return trackId ? `${path}?track=${encodeURIComponent(trackId)}` : path;
  }

  return path;
}

export function syncLocationToStore(set) {
  const route = resolveRoute();
  const isKnownPath =
    route.page !== 'home' ||
    window.location.pathname === '/' ||
    window.location.pathname.replace(/\/+$/, '') === '';

  if (!isKnownPath) {
    window.history.replaceState({ page: 'home' }, '', '/');
  }

  set({ currentPage: route.page });
  return route;
}
