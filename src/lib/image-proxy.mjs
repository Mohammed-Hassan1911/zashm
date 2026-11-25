// Shared helpers for the Cloudflare image proxy.
//
// Product photos are stored in Supabase Storage and were previously downloaded
// from there on every page view. The Worker fetches each photo once, resizes it
// through Cloudflare Images Free (`cf.image`), and caches the response at the
// edge. The browser only ever asks for a same-origin `/img/v1/...` URL.
//
// The object key is base64url-encoded in the path so the URL never ends in
// `.jpg` / `.webp`: Wrangler's `run_worker_first` negative patterns let those
// static extensions bypass the Worker, which would defeat the proxy entirely.

export const IMAGE_PREFIX = '/img/v1';
export const IMAGE_VERSION = 'v1';

// Three widths keep the Free-plan unique-transformation budget predictable:
// thumbnails, product cards and the product/lightbox hero all share them.
export const IMAGE_WIDTHS = Object.freeze({
  thumb: 160,
  card: 480,
  detail: 1200,
});

export const IMAGE_WIDTH_VALUES = Object.freeze(
  Array.from(new Set(Object.values(IMAGE_WIDTHS))).sort((a, b) => a - b)
);

const SUPABASE_PUBLIC_MARKER = '/storage/v1/object/public/';
const MAX_KEY_LENGTH = 300;
const IMAGE_TYPE = /^image\//i;

export function resolveImageWidth(width = 'card') {
  if (typeof width === 'number' && IMAGE_WIDTH_VALUES.includes(width)) return width;
  if (typeof width === 'string') {
    if (IMAGE_WIDTHS[width]) return IMAGE_WIDTHS[width];
    const parsed = Number(width);
    if (Number.isInteger(parsed) && IMAGE_WIDTH_VALUES.includes(parsed)) return parsed;
  }
  return 0;
}

/** True only for keys the Worker is willing to fetch from the products bucket. */
export function isValidImageKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) return false;
  if (!/^[\x20-\x7E]+$/.test(key)) return false;
  if (!key.startsWith('products/') || key.startsWith('/') || key.startsWith('products/.')) return false;
  if (key.includes('..')) return false;
  if (/[\\?#%\0-\x1F\x7F]/.test(key)) return false;
  return true;
}

export function encodeImageKey(key) {
  if (!isValidImageKey(key)) return '';
  const encoded = typeof btoa === 'function'
    ? btoa(key)
    : Buffer.from(key, 'utf8').toString('base64');
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeImageKey(part) {
  if (typeof part !== 'string' || !/^[A-Za-z0-9_-]+$/.test(part)) return '';
  const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4);
  let key = '';
  try {
    key = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
  return isValidImageKey(key) ? key : '';
}

/**
 * Extract the storage object key from a Supabase public URL.
 * Non-Supabase URLs (data URIs, R2 mirrors, legacy external images) return ''.
 */
export function imageKeyFromUrl(source) {
  if (typeof source !== 'string' || !source) return '';
  if (source.startsWith(`${IMAGE_PREFIX}/`) || source.startsWith('/media/')) return '';
  const index = source.indexOf(SUPABASE_PUBLIC_MARKER);
  if (index === -1) return '';
  // Keep the bucket in the key: the Worker uses it to build the origin URL and
  // the browser mirror path uses the same relative path.
  const key = source.slice(index + SUPABASE_PUBLIC_MARKER.length).split(/[?#]/)[0];
  return isValidImageKey(key) ? key : '';
}

export function proxyImageUrl(source, width = 'card') {
  const key = imageKeyFromUrl(source);
  const resolved = resolveImageWidth(width);
  if (!key || !resolved) return typeof source === 'string' ? source : '';
  const encoded = encodeImageKey(key);
  if (!encoded) return source;
  return `${IMAGE_PREFIX}/w${resolved}/${encoded}`;
}

/** Responsive srcSet for cards: desktop uses the hero width, mobile the card width. */
export function imageSrcSet(source) {
  if (!imageKeyFromUrl(source)) return '';
  return IMAGE_WIDTH_VALUES.filter((width) => width >= IMAGE_WIDTHS.card)
    .map((width) => `${proxyImageUrl(source, width)} ${width}w`)
    .join(', ');
}

export function isProxyImageUrl(source) {
  return typeof source === 'string' && source.startsWith(`${IMAGE_PREFIX}/`);
}

export function parseImagePath(pathname) {
  const match = /^\/img\/v1\/w(\d{2,4})\/([A-Za-z0-9_-]+)$/.exec(String(pathname || ''));
  if (!match) return null;
  const width = Number(match[1]);
  if (!IMAGE_WIDTH_VALUES.includes(width)) return null;
  const key = decodeImageKey(match[2]);
  if (!key) return null;
  return { width, key };
}

/**
 * Cloudflare's `format: auto` depends on Accept, so we negotiate explicitly
 * and give every format its own cache key. Three variants at most: AVIF,
 * WebP, and the original JPEG for clients that advertise neither.
 */
export function negotiatedImageFormat(accept) {
  let avif = -1;
  let webp = -1;
  let wildcard = 0;
  for (const token of String(accept || '').toLowerCase().split(',')) {
    const parts = token.trim().split(';');
    const type = parts.shift().trim();
    let q = 1;
    for (const param of parts) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (!match) continue;
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) q = parsed;
    }
    if (type === 'image/avif') avif = Math.max(avif, q);
    else if (type === 'image/webp') webp = Math.max(webp, q);
    else if (type === 'image/*' || type === '*/*') wildcard = Math.max(wildcard, q);
  }
  // Explicit q values win over wildcards; q=0 means the client refused it.
  const avifQ = avif === -1 ? wildcard : avif;
  const webpQ = webp === -1 ? wildcard : webp;
  if (avifQ > 0) return 'avif';
  if (webpQ > 0) return 'webp';
  return '';
}

export function isImageResponse(response) {
  // Partial 206 bodies must never be stored under a full-image cache key.
  if (!response || response.status !== 200) return false;
  return IMAGE_TYPE.test(String(response.headers && response.headers.get('content-type') || ''));
}

/**
 * Browser-side candidate list: optimized edge URL first, live Supabase second,
 * then the mirror path (currently empty until the snapshot sync is enabled).
 * A failed proxy request must not hide the later fallbacks.
 */
export function imageCandidates(source, options = {}) {
  const config = typeof options === 'object' && options !== null ? options : { width: options };
  const width = config.width || 'card';
  const proxy = proxyImageUrl(source, width);
  const list = [];

  if (proxy !== source) {
    const candidate = { src: proxy };
    if (config.srcSet) {
      const srcSet = imageSrcSet(source);
      if (srcSet) {
        candidate.srcSet = srcSet;
        candidate.sizes = config.sizes || '(max-width: 700px) 50vw, (max-width: 1100px) 33vw, 25vw';
      }
    }
    list.push(candidate);
  }

  if (typeof source === 'string' && source) list.push({ src: source });
  return list;
}
