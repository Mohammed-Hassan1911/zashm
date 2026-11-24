// ─── ZASHM REQUEST-TIME CONTENT-SECURITY-POLICY ──────────────────────────────
// Vercel static `vercel.json` headers cannot interpolate environment values.
// The committed static policy contains NO Supabase host; Routing Middleware
// adds exactly the Supabase origin configured for the active deployment.
// Production keeps its own origin, Preview gets staging, and no code path can
// fall back to a hard-coded Production host.
//
// This is CommonJS because Vercel compiles root `middleware.ts` to CommonJS;
// requiring an `.mjs` module there fails with ERR_REQUIRE_ESM at runtime.
//
// Cloudflare Staging (`worker.mjs` / `public/_headers`) is deliberately
// untouched: it uses its own static header set and is not part of this fix.

'use strict';

const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' https://www.googletagmanager.com https://va.vercel-scripts.com",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  'connect-src', // marker: the origin list is inserted here
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
];

const CONNECT_SUFFIX = [
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://*.google-analytics.com',
  'https://*.analytics.google.com',
  'https://vitals.vercel-insights.com',
];

/** Only a valid https Supabase project origin is accepted; never a wildcard. */
function configuredSupabaseOrigin(env = process.env) {
  for (const name of ['VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL', 'SUPABASE_URL']) {
    const raw = env && env[name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      const url = new URL(raw.trim());
      if (url.protocol !== 'https:' || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) continue;
      return url.origin;
    } catch {
      /* ignore invalid configuration and fail closed */
    }
  }
  return '';
}

/** Return the request-time CSP, or null when no safe Supabase origin exists. */
function contentSecurityPolicy(env = process.env) {
  const origin = configuredSupabaseOrigin(env);
  if (!origin) return null;
  const connectSrc = ["'self'", origin, ...CONNECT_SUFFIX].join(' ');
  return DIRECTIVES
    .map((directive) => (directive === 'connect-src' ? `connect-src ${connectSrc};` : `${directive};`))
    .join(' ');
}

module.exports = { configuredSupabaseOrigin, contentSecurityPolicy };
