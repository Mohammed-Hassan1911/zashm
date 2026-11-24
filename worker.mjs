// Cloudflare Workers entrypoint for ZASHM.
// It keeps the existing Vercel-style api/ handlers unchanged by translating a
// Worker Request into the small (req, res) surface those handlers use.

import ordersHandler from './api/orders.js';
import authHandler from './api/auth.js';
import sitemapHandler from './api/sitemap.mjs';
import couponValidateHandler from './api/coupons/validate.js';
import reviewsHandler from './api/reviews.js';
import adminProductsHandler from './api/admin/products.js';
import adminOrdersHandler from './api/admin/orders.js';
import adminCouponsHandler from './api/admin/coupons.js';
import adminUsersHandler from './api/admin/users.js';
import adminReviewsHandler from './api/admin/reviews.js';
import adminUploadHandler from './api/admin/upload.js';
import productExists from './src/lib/product-exists.cjs';

const {
  isCrawler,
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

export const CSP = [
  "default-src 'self';",
  "script-src 'self' https://www.googletagmanager.com https://va.vercel-scripts.com;",
  "script-src-attr 'none';",
  "style-src 'self' 'unsafe-inline';",
  "style-src-elem 'self';",
  "font-src 'self';",
  'img-src \'self\' data: blob: https:;',
  "connect-src 'self' https://ptegprcbtfylqhbnbkih.supabase.co https://www.googletagmanager.com https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://vitals.vercel-insights.com;",
  "object-src 'none';",
  "base-uri 'self';",
  "form-action 'self';",
  "frame-ancestors 'none';",
  'upgrade-insecure-requests',
].join(' ');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
};

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
  ['/api/sitemap', { handler: sitemapHandler }],
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

export function applySecurityHeaders(response, path, url) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (isPrivatePath(path, url)) {
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

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

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
    }), path, url);
    shim.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return shim;
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
            req.prerenderedIds = Array.isArray(manifest && manifest.ids)
              ? manifest.ids
              : null;
          } else {
            req.prerenderedIds = null;
          }
        } catch {
          req.prerenderedIds = null;
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
    return applySecurityHeaders(finalizeVercelResponse(res), path, url);
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
        return applySecurityHeaders(notFound, path, url);
      }
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
    }), path, url);
  };

  if (SPA_PATHS.has(path) || path.startsWith('/product/')) {
    const assetRequest = new Request(new URL('/index.html', url.origin));
    let assetResponse;
    try {
      assetResponse = await env.ASSETS.fetch(assetRequest);
    } catch {
      return assetError();
    }
    if (!assetResponse.ok) return applySecurityHeaders(assetResponse, path, url);
    const headers = new Headers(assetResponse.headers);
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return applySecurityHeaders(
      new Response(assetResponse.body, { status: assetResponse.status, headers }),
      path,
      url
    );
  }

  try {
    const assetResponse = await env.ASSETS.fetch(request);
    return applySecurityHeaders(assetResponse, path, url);
  } catch {
    return assetError();
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
