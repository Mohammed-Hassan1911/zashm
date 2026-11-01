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
  // Unknown paths are a real 404 (both on the server via vercel.json rewrites
  // and in the SPA). Never silently render the home page under a wrong URL.
  return { page: page || 'notfound', productId: null, trackId: null };
}

export function pageUrl(page, selectedProduct, currentLocation = typeof window !== 'undefined' ? window.location : null) {
  if (page === 'product') {
    const productId = selectedProduct?.id;
    return productId == null ? '/product' : `/product/${encodeURIComponent(String(productId))}`;
  }

  const path = STATIC_ROUTES[page] || '/';
  if (page === 'track') {
    // Preserve the full secure tracking link (?track=…&tk=…) so navigating
    // back to /track never silently drops the token that unlocks the order.
    const params = new URLSearchParams(currentLocation?.search || '');
    const preserved = new URLSearchParams();
    const trackId = params.get('track');
    const token = params.get('tk');
    if (trackId) preserved.set('track', trackId);
    if (token) preserved.set('tk', token);
    const query = preserved.toString();
    return query ? `${path}?${query}` : path;
  }

  return path;
}

export function syncLocationToStore(set) {
  const route = resolveRoute();
  // Keep the URL as-is: unknown paths render the NotFound page instead of
  // being silently rewritten to "/" (soft 404).
  set({ currentPage: route.page });
  return route;
}
