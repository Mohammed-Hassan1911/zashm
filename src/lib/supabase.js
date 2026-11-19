// ─── Supabase config + the storefront's public read ──────────────────────────
// The browser never talks to Supabase Auth or Storage: logins, orders, admin
// writes and image uploads all go through /api/* with the service-role key on
// the server. The only thing the storefront needs from Supabase is the
// sanitized `products_public` view.
//
// So this module uses plain fetch against the REST endpoint instead of
// `@supabase/supabase-js`. The client library is ~54 KB gzipped and every
// shopper was downloading it before the first product card painted, to run one
// GET. Keeping it out of the storefront graph means it is now only reachable
// from the admin chunks (and in practice not at all — uploads go through
// /api/admin/upload).
//
// The view is the same one SEC-27 already enforced: no reservedStock, no
// inactive rows, and the anon key can only SELECT it.

const RAW_URL =
  import.meta.env.VITE_SUPABASE_URL ||
  import.meta.env.REACT_APP_SUPABASE_URL ||
  '';

const ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  import.meta.env.REACT_APP_SUPABASE_ANON_KEY ||
  '';

export const SUPABASE_URL = String(RAW_URL).replace(/\/+$/, '');
export const SUPABASE_ANON_KEY = String(ANON_KEY);

export const isCatalogueConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * Read every row of the public catalogue view.
 * Throws on a network error, a non-2xx response or a payload that is not an
 * array, so callers can fall back to the snapshot exactly as they did with the
 * supabase-js result.
 */
export async function fetchPublicProducts() {
  if (!isCatalogueConfigured) {
    throw new Error('Catalogue is not configured');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/products_public?select=*`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Catalogue request failed (${response.status})`);
  }

  const rows = await response.json();

  if (!Array.isArray(rows)) {
    throw new Error('Catalogue returned an unexpected payload');
  }

  return rows;
}
