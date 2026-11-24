// Speed Insights must never report URLs from private admin/transaction routes.
// The store uses a custom state router, so the real location (not a framework
// router) is the source of truth. `beforeSend` receives the event URL; returning
// null drops the datapoint entirely.
const PRIVATE_PATHS = ['/admin', '/cart', '/checkout', '/wishlist', '/track'];
const BASE_URL = (typeof __ZASHM_SITE_ORIGIN__ !== 'undefined' && __ZASHM_SITE_ORIGIN__)
  ? __ZASHM_SITE_ORIGIN__
  : 'https://za-shm.vercel.app';

export function shouldReportVital(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/')) return false;
  try {
    const url = new URL(value, BASE_URL);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (PRIVATE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return false;
    // Tracking deep links are noindexed at the edge; their query strings carry
    // order tokens and must stay out of any third-party analytics payload.
    if (url.searchParams.has('track') || url.searchParams.has('tk')) return false;
    return true;
  } catch (e) {
    return false;
  }
}
