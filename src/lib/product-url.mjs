export function productRoutePath(product) {
  const productId = product?.id;
  return productId == null ? '/product' : `/product/${encodeURIComponent(String(productId))}`;
}

export function canonicalUrl(path, origin) {
  if (typeof path !== 'string' || !path || typeof origin !== 'string' || !origin) return '';
  try {
    return new URL(path, origin).href;
  } catch {
    return '';
  }
}
