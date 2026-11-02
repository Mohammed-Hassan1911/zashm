// Shared product-existence logic for the Vercel Routing Middleware.
//
// The storefront is a client-rendered SPA, so `/product/<unknown-id>` used to
// answer HTTP 200 with a "Product not found." screen (a soft 404). Search
// engines only see the status line, so this helper lets the middleware verify
// the id against `products_public` and answer a real 404.
//
// The check is only performed for crawlers: shoppers keep the instant static
// shell with no extra network round trip, while Googlebot/Bingbot get an
// honest status. Anything unexpected (missing env, timeout, DB error) fails
// open so a flaky dependency can never 404 a real product.

const CRAWLER_PATTERN = /googlebot|google-inspectiontool|bingbot|bingpreview|yandex|duckduckbot|baiduspider|applebot|petalbot|slurp|seznam|sogou|qwantify|semrushbot|ahrefsbot|mj12bot|dotbot|facebookexternalhit|twitterbot|linkedinbot|pinterest|slackbot|telegrambot|whatsapp|embedly|discordbot|redditbot/i;

const PRODUCT_PATH = /^\/product\/([^/]+)\/?$/;
const NUMERIC_ID = /^[1-9]\d{0,18}$/;

function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function isCrawler(userAgent) {
  return typeof userAgent === 'string' && CRAWLER_PATTERN.test(userAgent);
}

export function isProductId(value) {
  return typeof value === 'string' && NUMERIC_ID.test(value);
}

export function productIdFromPath(pathname) {
  const match = PRODUCT_PATH.exec(typeof pathname === 'string' ? pathname : '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Returns true (exists), false (missing / malformed id) or null (unknown:
// configuration missing, network error, timeout). Callers must treat null as
// "let the request continue" rather than as a missing product.
export async function checkProductExists(id, { env = process.env, fetchImpl = fetch } = {}) {
  if (!isProductId(id)) return false;

  const supabaseUrl = firstEnv(env, ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL']);
  const anonKey = firstEnv(env, ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY']);
  if (!supabaseUrl || !anonKey) return null;

  let url;
  try {
    url = new URL('/rest/v1/products_public', supabaseUrl);
  } catch {
    return null;
  }
  url.searchParams.set('select', 'id');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('limit', '1');

  try {
    const response = await fetchImpl(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      // Measured round trips to Supabase from the dev machine were 0.2–4.7s
      // with occasional spikes past 5s, which produced flaky fail-open 200s.
      // 8s keeps the check bounded without making a crawler 404 depend on the
      // developer's network; a shopper never waits here.
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) ? rows.length > 0 : null;
  } catch {
    return null;
  }
}

export async function buildNotFoundResponse(request, { fetchImpl = fetch } = {}) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=0, must-revalidate',
    'x-robots-tag': 'noindex, nofollow',
  };
  try {
    const page = await fetchImpl(new URL('/404.html', request.url));
    if (page.ok) {
      const body = await page.text();
      if (body) return new Response(body, { status: 404, headers });
    }
  } catch {
    /* fall through to the minimal page */
  }
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      '<meta name="robots" content="noindex, nofollow"/><title>Page Not Found — ZASHM</title>' +
      '</head><body><h1>404</h1><p>This page could not be found. / الصفحة غير موجودة</p>' +
      '<p><a href="/">Return Home</a> · <a href="/shop">Browse Collection</a></p></body></html>',
    { status: 404, headers },
  );
}
