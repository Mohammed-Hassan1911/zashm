// Vercel Routing Middleware (root `middleware.ts` convention).
//
// 1. Answers a real HTTP 404 for `/product/<id>` URLs whose product does not
//    exist in `products_public`. The decision only runs for crawlers; see
//    src/lib/product-exists.cjs for the rules and fail-open behaviour.
// 2. Overrides the static Content-Security-Policy with the Supabase origin
//    configured for THIS deployment, so Preview can never allow Production.
import {
  buildNotFoundResponse,
  checkProductExists,
  isCrawler,
  productIdFromPath,
} from './src/lib/product-exists.cjs';
import { contentSecurityPolicy } from './src/lib/csp.cjs';

// `next()` from `@vercel/functions` is the documented continuation response;
// building its wire format here keeps a transitive dependency out of the app.
// Its `headers` argument becomes response headers, exactly like
// `next({ headers: { 'Content-Security-Policy': csp } })`.
function continueRequest(csp: string | null) {
  const headers = new Headers();
  if (csp) headers.set('Content-Security-Policy', csp);
  headers.set('x-middleware-next', '1');
  return new Response(null, { headers });
}

export const config = {
  matcher: ['/product/:path*', '/((?!api|_next/static|favicon.ico|assets/|fonts/|media/).*)'],
  // Routing Middleware defaults to the deprecated edge runtime; the Node.js
  // runtime is recommended and matches the `process.env`/fetch usage here.
  runtime: 'nodejs',
};

export default async function middleware(request: Request) {
  const id = productIdFromPath(new URL(request.url).pathname);
  // Returning `undefined` drops the response body in the Node.js runtime, so
  // every pass-through must return the explicit continuation response.
  if (id !== null && isCrawler(request.headers.get('user-agent') || '')) {
    const exists = await checkProductExists(id);
    if (exists === false) return buildNotFoundResponse(request);
  }
  return continueRequest(contentSecurityPolicy());
}
