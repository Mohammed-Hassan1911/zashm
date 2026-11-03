// Vercel Routing Middleware (root `middleware.ts` convention).
//
// Answers a real HTTP 404 for `/product/<id>` URLs whose product does not exist
// in `products_public`. The decision only runs for crawlers; see
// src/lib/product-exists.cjs for the rules and the fail-open behaviour.
import {
  buildNotFoundResponse,
  checkProductExists,
  isCrawler,
  productIdFromPath,
} from './src/lib/product-exists.cjs';

// `next()` from `@vercel/functions` is exactly this response. Building it here
// keeps a one-helper dependency (and its transitive audit findings) out of the
// storefront; the header is the documented middleware continuation protocol.
function continueRequest() {
  return new Response(null, { headers: { 'x-middleware-next': '1' } });
}

export const config = {
  matcher: ['/product/:path*'],
  // Routing Middleware defaults to the deprecated edge runtime; the Node.js
  // runtime is recommended and matches the `process.env`/fetch usage here.
  runtime: 'nodejs',
};

export default async function middleware(request: Request) {
  const id = productIdFromPath(new URL(request.url).pathname);
  // Returning `undefined` drops the response body in the Node.js runtime, so
  // every pass-through must return the explicit continuation response.
  if (id === null) return continueRequest();
  if (!isCrawler(request.headers.get('user-agent') || '')) return continueRequest();

  const exists = await checkProductExists(id);
  if (exists === false) return buildNotFoundResponse(request);
  return continueRequest();
}
