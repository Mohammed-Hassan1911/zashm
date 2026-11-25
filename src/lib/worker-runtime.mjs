// Shared ZASHM Worker runtime helpers.
// Kept out of worker.mjs so workerd sees only the default handler export;
// Node regression suites import these named helpers directly from here.
import ordersHandler from '../../api/orders.js';
import authHandler from '../../api/auth.js';
import sitemapHandler, { resolveSiteOrigin, siteOriginsForRewrite } from '../../api/sitemap.mjs';
import couponValidateHandler from '../../api/coupons/validate.js';
import reviewsHandler from '../../api/reviews.js';
import adminProductsHandler from '../../api/admin/products.js';
import adminOrdersHandler from '../../api/admin/orders.js';
import adminCouponsHandler from '../../api/admin/coupons.js';
import adminUsersHandler from '../../api/admin/users.js';
import adminReviewsHandler from '../../api/admin/reviews.js';
import adminUploadHandler from '../../api/admin/upload.js';
import productExists from './product-exists.cjs';
import { isImageResponse, negotiatedImageFormat, parseImagePath } from './image-proxy.mjs';
import { isProductionEnv, productionConfigProblems, productionGuardResponse } from './production-env.mjs';

const {
  isCrawler,
  isProductId,
  productIdFromPath,
  checkProductExists,
  buildNotFoundResponse,
} = productExists;

const SPA_PATHS = new Set([
  '/',
  '/shop',
  '/cart',
  '/checkout',
  '/wishlist',
  '/track',
  '/admin',
]);

const PRIVATE_PATHS = ['/api', '/admin', '/cart', '/checkout', '/wishlist', '/track'];

// @vercel/speed-insights injects a platform-owned script URL at runtime. That
// endpoint only exists on Vercel; serving an inert script here keeps staging
// free of console errors without changing the shared application bundle or
// sending any vitals to Vercel from Cloudflare.
export const VERCEL_TELEMETRY_SHIMS = new Set([
  '/_vercel/speed-insights/script.js',
]);

// Handlers cap bodies between 8 KB and 2 MB. A declared body larger than this
// is rejected by readBody() before parsing, so it never needs to be buffered.
export const MAX_BUFFERED_BODY_BYTES = 8 * 1024 * 1024;

// The Worker must allow exactly the Supabase project configured for this
// deployment. Staging and a future Production cutover run the same code with
// different secrets, so the origin is resolved per Worker version and never
// hard-coded. A missing or invalid URL falls back to the Supabase-free policy:
// stricter than allowing an unintended project, and never a silent Production.
export function configuredSupabaseOrigin(env = {}) {
  // Must match the build-time precedence in vite.config.js exactly: the same
  // project has to drive the static _headers CSP and the Worker CSP.
  const raw = env?.VITE_SUPABASE_URL || env?.REACT_APP_SUPABASE_URL || env?.SUPABASE_URL || '';
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

// Supabase-free baseline. It matches vercel.json and the committed _headers
// template; the request-time policy inserts the configured origin only.
export const CSP = [
  "default-src 'self';",
  "script-src 'self' https://www.googletagmanager.com https://va.vercel-scripts.com;",
  "script-src-attr 'none';",
  "style-src 'self' 'unsafe-inline';",
  "style-src-elem 'self';",
  "font-src 'self';",
  'img-src \'self\' data: blob: https:;',
  "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://vitals.vercel-insights.com;",
  "object-src 'none';",
  "base-uri 'self';",
  "form-action 'self';",
  "frame-ancestors 'none';",
  'upgrade-insecure-requests',
].join(' ');

export function contentSecurityPolicy(env = {}) {
  const origin = configuredSupabaseOrigin(env);
  if (!origin) return CSP;
  return CSP.replace("connect-src 'self' ", `connect-src 'self' ${origin} `);
}

const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// Kept for static parity tests; live responses use securityHeaders(env).
export const SECURITY_HEADERS = { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': CSP };

export function securityHeaders(env = {}) {
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': contentSecurityPolicy(env) };
}

// Static shells are generated at build time with DEFAULT_BASE baked into their
// canonical/OG/JSON-LD URLs. Keep them consistent with the sitemap by rewriting
// only canonical/site origins (DEFAULT_BASE, SITEMAP_ALLOWED_ORIGINS and the
// approved PUBLIC_BASE_URL). CORS-only ALLOWED_ORIGINS values, Supabase image
// URLs, schema.org URLs and unrelated origins are never touched. An unapproved
// PUBLIC_BASE_URL fails closed and leaves the shipped shell unchanged.
async function rewriteShellOrigins(response) {
  const resolved = resolveSiteOrigin();
  if (!resolved.valid) return response;

  const html = await response.text();
  let rewritten = html;
  for (const origin of siteOriginsForRewrite()) {
    if (origin !== resolved.origin) {
      rewritten = rewritten.split(origin).join(resolved.origin);
    }
  }
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

const API_ROUTES = new Map([
  ['/api/orders', { handler: ordersHandler }],
  ['/api/auth', { handler: authHandler }],
  ['/api/errors', { handler: authHandler, query: { __zshm_route: 'errors' } }],
  ['/api/coupons/validate', { handler: couponValidateHandler }],
  ['/api/reviews', { handler: reviewsHandler }],
  ['/api/admin/products', { handler: adminProductsHandler }],
  ['/api/admin/orders', { handler: adminOrdersHandler }],
  ['/api/admin/coupons', { handler: adminCouponsHandler }],
  ['/api/admin/users', { handler: adminUsersHandler }],
  ['/api/admin/reviews', { handler: adminReviewsHandler }],
  ['/api/admin/upload', { handler: adminUploadHandler }],
  ['/api/sitemap', { handler: sitemapHandler, path: '/api/sitemap' }],
]);

export class VercelResponse {
  constructor() {
    this.statusCode = 200;
    this._headers = new Map();
    this.body = '';
    this.ended = false;
  }

  setHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), value);
    return this;
  }

  getHeader(name) {
    const value = this._headers.get(String(name).toLowerCase());
    return value === undefined ? undefined : value;
  }

  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
    return this;
  }

  end(body) {
    if (!this.ended) {
      this.body = body === undefined || body === null ? '' : String(body);
      this.ended = true;
    }
    return this;
  }
}

// Emit body chunks as they arrive instead of merging the whole stream first.
// The 8 MB ceiling still fails closed with the API layer's 413 shape, while a
// smaller per-route cap in readBody() can reject after the first oversized
// chunk and stop the reader immediately through req.resume().
async function pipeBoundedBody(request, onChunk, isCancelled) {
  const stream = request.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const bytes = request.arrayBuffer ? await request.arrayBuffer() : null;
    if (bytes && bytes.byteLength) onChunk(Buffer.from(bytes));
    return;
  }

  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      if (isCancelled()) break;
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += bytes.byteLength;
      if (total > MAX_BUFFERED_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw Object.assign(new Error('Payload too large'), { status: 413 });
      }
      onChunk(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (isCancelled()) {
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export async function createVercelReqRes(request, overrides = {}) {
  const sourceUrl = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers) headers[key] = value;

  // Cloudflare's connecting IP is trusted; overwrite the forwarded headers so
  // clientIp() in api/_lib.js never sees a comma-separated chain it rejects.
  const cfIp = headers['cf-connecting-ip'];
  if (cfIp) {
    headers['x-real-ip'] = cfIp;
    headers['x-forwarded-for'] = cfIp;
  }

  const method = String(request.method || 'GET').toUpperCase();
  const declaredLength = Number(headers['content-length']);
  const oversizedByHeader = Number.isFinite(declaredLength) &&
    declaredLength > MAX_BUFFERED_BODY_BYTES;

  const listeners = { data: [], end: [], error: [] };
  let started = false;
  let readCancelled = false;
  // Only a length is needed for readBody()'s guard: it rejects and calls
  // resume() before any Buffer.concat() can see this sentinel.
  const bodyChunks = oversizedByHeader ? [{ length: declaredLength }] : null;
  // OPTIONS is handled by applyCors()/handleOptions() before any body read.
  const shouldRead = method !== 'GET' && method !== 'HEAD' &&
    method !== 'OPTIONS' && !oversizedByHeader;

  const req = {
    method,
    url: new URL(
      overrides.path || `${sourceUrl.pathname}${sourceUrl.search}`,
      sourceUrl.origin
    ).toString(),
    headers,
    query: {
      ...Object.fromEntries(sourceUrl.searchParams),
      ...(overrides.query || {}),
    },
    socket: { remoteAddress: cfIp || '' },
    on(event, callback) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(callback);
      // Start only when readBody() actually asks for data. Handlers that reject
      // on a Method/Origin/Auth guard never allocate the request body at all.
      // Deferring one microtask lets readBody() attach end/error first.
      if (event === 'data' && !started) {
        started = true;
        queueMicrotask(async () => {
          try {
            if (bodyChunks) {
              for (const chunk of bodyChunks) {
                for (const cb of listeners.data) cb(chunk);
              }
            } else if (shouldRead) {
              await pipeBoundedBody(
                request,
                (chunk) => {
                  for (const cb of listeners.data) cb(chunk);
                },
                () => readCancelled
              );
            }
            if (!readCancelled) {
              for (const cb of listeners.end) cb();
            }
          } catch (error) {
            for (const cb of listeners.error) cb(error);
          }
        });
      }
      return this;
    },
    // readBody() calls resume() when its own (smaller) cap rejects a chunk.
    // Use that signal to stop the underlying stream immediately instead of
    // buffering the rest of a large body.
    resume() { readCancelled = true; return this; },
    pause() { return this; },
    destroy() { return this; },
  };

  return { req, res: overrides.res || new VercelResponse() };
}

export function finalizeVercelResponse(res) {
  const headers = new Headers();
  for (const [name, value] of res._headers) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else {
      headers.set(name, String(value));
    }
  }

  let status = Number(res.statusCode) || 200;
  let body = res.ended ? res.body : '';
  if (!res.ended) {
    status = 500;
    body = JSON.stringify({ error: 'Server error' });
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
  }

  return new Response(status === 204 || status === 205 ? null : body, {
    status,
    headers,
  });
}

export function normalizePath(pathname) {
  const path = String(pathname || '/');
  if (path.length <= 1) return '/';
  return path.replace(/\/+$/, '') || '/';
}

export function isPrivatePath(path, url) {
  const normalized = normalizePath(path);
  if (PRIVATE_PATHS.some((p) => normalized === p || normalized.startsWith(`${p}/`))) {
    return true;
  }
  if (url && (url.searchParams.has('track') || url.searchParams.has('tk'))) {
    return true;
  }
  return false;
}

export function applySecurityHeaders(response, path, url, env = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(env))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  // Temporary launch control: paid-domain canonical URLs are not ready, so all
  // visitor-facing pages carry noindex while checkout stays fully usable.
  const temporaryNoindex = String(env?.ZASHM_STOREFRONT_NOINDEX || '') === '1';
  if (temporaryNoindex || isPrivatePath(path, url)) {
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  const body = response.status === 204 || response.status === 205
    ? null
    : response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const IMAGE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function imageError(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Serve one Supabase object through Cloudflare's edge cache.
 *
 * `cf.image` is a Worker fetch option, not an Images Paid feature: the first
 * request for a width creates a unique transformation, later requests are
 * served from cache without touching Supabase. Only the exact configured
 * Supabase project is used and the object key comes from a validated path, so
 * this cannot be used as an open proxy.
 */
export async function handleImageRequest(request, env = {}, helpers = {}) {
  const parsed = parseImagePath(new URL(request.url).pathname);
  if (!parsed) return imageError('Not Found', 404);

  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }

  const origin = configuredSupabaseOrigin(env);
  if (!origin) return imageError('Not Found', 404);

  let sourceUrl;
  try {
    sourceUrl = new URL(`/storage/v1/object/public/${parsed.key}`, origin);
  } catch {
    return imageError('Not Found', 404);
  }

  const fetchImpl = helpers.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return imageError('Image unavailable', 502);

  const accept = request.headers && typeof request.headers.get === 'function'
    ? request.headers.get('accept') || ''
    : '';
  // `format: auto` would make the bytes depend on Accept while the cache key
  // stays URL-only. Negotiate one of three concrete variants instead, and give
  // each its own internal cache key. Browser query strings are still ignored so
  // cache busters cannot create unbounded edge objects or Supabase egress.
  const format = negotiatedImageFormat(accept);
  const cacheVariant = format || 'jpeg';
  const cacheUrl = new URL(new URL(request.url).pathname, new URL(request.url).origin);
  cacheUrl.searchParams.set('__zashm_format', cacheVariant);
  const cacheRequest = new Request(cacheUrl.href, {
    headers: { Accept: format ? `image/${format}` : 'image/jpeg' },
  });
  const cache = helpers.cache || (typeof caches !== 'undefined' && caches && caches.default) || null;
  if (cache) {
    try {
      const hit = await cache.match(cacheRequest);
      if (hit && hit.ok) {
        const headers = new Headers(hit.headers);
        headers.set('X-Zashm-Image', 'hit');
        // HEAD must never return a body, even on a cache hit.
        return new Response(method === 'HEAD' ? null : hit.body, { status: hit.status, headers });
      }
    } catch { /* a cache failure must fall through to the origin */ }
  }

  // Range is deliberately not forwarded: a 206 partial image must never be
  // rewrapped as 200 and cached under the full-image key.
  const requestHeaders = { Accept: format ? `image/${format}` : 'image/jpeg' };
  const imageOptions = {
    method: 'GET',
    headers: requestHeaders,
    cf: {
      image: {
        width: parsed.width,
        quality: 82,
        ...(format ? { format } : {}),
      },
    },
  };

  let upstream = null;
  let usedTransform = true;
  try {
    upstream = await fetchImpl(sourceUrl.href, imageOptions);
    // A 9422 (Free-plan transformation limit) or an unsupported format must not
    // break photos; one retry with the untouched object is the safety net.
    if (!isImageResponse(upstream)) {
      usedTransform = false;
      upstream = await fetchImpl(sourceUrl.href, {
        method: 'GET',
        headers: requestHeaders,
      });
    }
  } catch {
    return imageError('Image unavailable', 502);
  }
  if (!isImageResponse(upstream)) return imageError('Image unavailable', 502);

  const headers = new Headers();
  headers.set('Content-Type', String(upstream.headers.get('content-type') || 'image/jpeg'));
  // The transform changes the byte length; never forward the origin's length.
  // A failed transform falls back to the large original, but must not pin that
  // original in the edge cache for a year: the next visitor should retry resize.
  headers.set('Cache-Control', usedTransform ? IMAGE_CACHE_CONTROL : 'public, max-age=60');
  headers.set('Vary', 'Accept');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Zashm-Image', usedTransform ? 'transformed' : 'original');

  const response = new Response(upstream.body, { status: 200, headers });
  if (cache && usedTransform) {
    try {
      await cache.put(cacheRequest, response.clone());
    } catch { /* caching is an optimisation, never a hard failure */ }
  }

  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  return response;
}

export async function handleRequest(request, env, helpers = {}) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  // A Production Worker must never serve with missing, placeholder, or
  // Staging configuration. This runs before any env value is copied into
  // process.env and before any Supabase/API handler can be reached.
  if (isProductionEnv(env)) {
    const problems = productionConfigProblems(env);
    if (problems.length) return productionGuardResponse();
  }

  // The API helpers read process.env, while Workers deliver configuration on
  // the env binding. Copy the string bindings explicitly so the existing
  // handlers see vars/secrets regardless of process.env compatibility flags.
  if (env) {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string') process.env[name] = value;
    }
  }

  if (VERCEL_TELEMETRY_SHIMS.has(path)) {
    const shim = applySecurityHeaders(new Response('/* disabled outside Vercel */', {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }), path, url, env);
    shim.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return shim;
  }

  // Image proxy first: it owns a narrow path and must never fall through to the
  // static 404 handler when a shopper asks for a resized product photo.
  if (parseImagePath(url.pathname)) {
    const imageResponse = await handleImageRequest(request, env, helpers);
    return applySecurityHeaders(imageResponse, path, url, env);
  }

  let route = API_ROUTES.get(path);
  if (path === '/sitemap.xml') {
    route = { handler: sitemapHandler, path: '/api/sitemap' };
  }

  if (route) {
    const res = new VercelResponse();
    try {
      const { req } = await createVercelReqRes(request, {
        path: route.path,
        query: route.query,
        res,
      });

      if (route.path === '/api/sitemap' && env && env.ASSETS) {
        // Resolve the static-shell manifest from local assets. A self-fetch to
        // the Worker's public URL is fragile and would point at the old origin
        // once the custom domain is cut over.
        try {
          const manifestResponse = await env.ASSETS.fetch(
            new Request(new URL('/prerendered-products.json', url.origin).href)
          );
          if (manifestResponse.ok) {
            const manifest = await manifestResponse.json();
            if (Array.isArray(manifest && manifest.ids)) {
              req.prerenderedIds = manifest.ids;
            } else {
              req.prerenderedIds = [];
              req.prerenderedManifestFailed = true;
            }
          } else {
            req.prerenderedIds = [];
            req.prerenderedManifestFailed = true;
          }
        } catch {
          req.prerenderedIds = [];
          req.prerenderedManifestFailed = true;
        }
      }

      await route.handler(req, res);
    } catch (error) {
      console.error('ZASHM Worker handler error |', (error && error.name) || 'Error');
      if (!res.ended) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    }
    return applySecurityHeaders(finalizeVercelResponse(res), path, url, env);
  }

  if (path.startsWith('/product/')) {
    // Mirrors middleware.ts: crawlers get a real 404 for unknown product ids,
    // shoppers keep the instant static shell with no extra round trip.
    const id = productIdFromPath(url.pathname);
    if (id !== null && isCrawler(request.headers.get('user-agent') || '')) {
      const exists = await checkProductExists(id, { env });
      if (exists === false) {
        const notFound = await buildNotFoundResponse(request, {
          fetchImpl: (input) => env.ASSETS.fetch(new Request(String(input))),
        });
        return applySecurityHeaders(notFound, path, url, env);
      }
    }
    // npm run build writes build/product/<id>/index.html with product-specific
    // metadata, JSON-LD and a noscript shell. Vercel serves that file directly;
    // serve it here too so crawlers and social previews keep the same markup.
    if (id !== null && isProductId(id) && env && env.ASSETS) {
      let prerendered = null;
      try {
        prerendered = await env.ASSETS.fetch(
          new Request(new URL(`/product/${id}/index.html`, url.origin).href)
        );
      } catch {
        prerendered = null;
      }
      if (prerendered && prerendered.ok) {
        const headers = new Headers(prerendered.headers);
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        return applySecurityHeaders(
          await rewriteShellOrigins(
            new Response(prerendered.body, { status: prerendered.status, headers })
          ),
          path,
          url,
          env
        );
      }
    }
  }

  // npm run build also writes build/shop/index.html with its own canonical and
  // metadata. Vercel serves that file for /shop; do the same here instead of
  // falling through to the generic root shell.
  if (path === '/shop' && env && env.ASSETS) {
    let shopShell = null;
    try {
      shopShell = await env.ASSETS.fetch(
        new Request(new URL('/shop/index.html', url.origin).href)
      );
    } catch {
      shopShell = null;
    }
    if (shopShell && shopShell.ok) {
      const headers = new Headers(shopShell.headers);
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
      return applySecurityHeaders(
        await rewriteShellOrigins(
          new Response(shopShell.body, { status: shopShell.status, headers })
        ),
        path,
        url,
        env
      );
    }
  }

  const assetError = () => {
    console.error('ZASHM Worker asset error |', 'ASSETS binding failed');
    return applySecurityHeaders(new Response('Server error', {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }), path, url, env);
  };

  if (SPA_PATHS.has(path) || path.startsWith('/product/')) {
    const assetRequest = new Request(new URL('/index.html', url.origin));
    let assetResponse;
    try {
      assetResponse = await env.ASSETS.fetch(assetRequest);
    } catch {
      return assetError();
    }
    if (!assetResponse.ok) return applySecurityHeaders(assetResponse, path, url, env);
    const headers = new Headers(assetResponse.headers);
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return applySecurityHeaders(
      await rewriteShellOrigins(
        new Response(assetResponse.body, { status: assetResponse.status, headers })
      ),
      path,
      url,
      env
    );
  }

  try {
    const assetResponse = await env.ASSETS.fetch(request);
    return applySecurityHeaders(assetResponse, path, url, env);
  } catch {
    return assetError();
  }
}
