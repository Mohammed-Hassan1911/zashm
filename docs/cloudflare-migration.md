# Cloudflare Workers migration

Status: **staging deployed, not cut over**. Vercel remains the live rollback
target (`dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`, alias `za-shm.vercel.app`).
No Supabase data, grants, RLS, Vercel settings or DNS were changed.
Migration changes are committed as `4c0e2ef` on `cloudflare-migration` and
pushed to `origin`; the branch is not merged or deployed to production.

Staging Worker: `https://zashm.mohammedhassanmail1.workers.dev`
Current version: `05ee31cc-02ea-4a93-b0eb-e5aff789296e`
Owner Cloudflare account: `9fe493bc12463ea71e52fd2f040c5171`

## What changed

- `wrangler.toml` — Worker entrypoint, `build/` static assets, `ASSETS` binding,
  `not_found_handling = "404-page"` (unknown routes stay real 404s),
  `html_handling = "none"`, `run_worker_first = true`.
- `worker.mjs` — translates Worker `(Request) => Response` into the existing
  Vercel-style `(req, res)` handlers in `api/`. Adds the shared security headers,
  `noindex` for private routes, SPA rewrites, `/api/errors` rewrite and
  `/sitemap.xml` routing. No API handler was rewritten.
- `public/_headers` — static-asset parity with `vercel.json` (CSP, HSTS,
  immutable cache, `noindex`).
- `scripts/test-cloudflare-worker.mjs` — 148 assertions for config parity,
  route coverage, adapter behaviour, headers, 404/SPA routing, sitemap origin,
  lazy chunk-wise bounded body handling, crawler 404 parity, Origin/CSRF gates,
  Set-Cookie preservation, asset-binding failures and the Vercel-only telemetry
  shim.
- `api/sitemap.mjs` — canonical origin may now be a server-approved
  `PUBLIC_BASE_URL` from a dedicated `SITEMAP_ALLOWED_ORIGINS` list, falling
  back to `ALLOWED_ORIGINS` (previously only the Vercel origin). A platform
  adapter may supply the prerender manifest from local assets.
  Preview/unapproved origins still fail closed. `scripts/test-sitemap.mjs`
  covers all paths.
- `package.json` / `.gitignore` — test wiring and `.dev.vars`, `.wrangler/`.

## Why the adapter is small

`api/_lib.js` only needs `req.method`, `req.headers`, `req.query`, `req.on`,
`req.socket.remoteAddress`, `resume()` and `res.statusCode`, `res.setHeader`,
`res.getHeader`, `res.end`. The adapter supplies exactly that; all money/stock/
order logic stays in the existing audited SQL RPCs and handlers. It also copies
string bindings from `env` into `process.env` (the config source the Vercel
handlers read), streams request bodies chunk-by-chunk under an 8 MB ceiling,
stops reading as soon as `readBody()` rejects a smaller route cap, forwards
stream errors to `readBody()` and emits `noindex` on generated `/api/*`
responses (static
`_headers` rules do not apply to Worker-generated responses). It also serves an
inert script at `/_vercel/speed-insights/script.js`: Vercel injects that URL at
runtime, and leaving it missing caused a 404 + MIME console error on staging.
The shim contains no telemetry code and is `no-store` + `noindex`.

Cloudflare `compatibility_date = 2026-11-24` enables `nodejs_compat`, so
`Buffer` and `crypto.randomBytes` work unchanged. Live staging proved that
`process.env` was **not** auto-populated from `--var` bindings, hence the
explicit copy above.

## Local proof (already run)

- `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → exit 0; SQL harness **495 passed, 0 failed**
  on a real temporary PostgreSQL cluster; all other suites 0 failed.
- `npm run build` → exit 0; bundle `index-L2XyCp3w.js`, same hash as the live
  Vercel build.
- `wrangler deploy --dry-run` → 1150.02 KiB / gzip 209.75 KiB, `ASSETS` binding.
- Live staging headers (measured): `/` and `/admin` 200, `/api/orders` 200 with
  `noindex, nofollow, noarchive` and `no-store`, unknown route real 404.
  CSP matches `vercel.json` byte-for-byte with no new `unsafe-inline`.

## Configuration (complete)

The owner entered all six secrets directly with `wrangler secret put`;
`wrangler secret list` confirms the six names (values never appeared in chat or
in a committed file):

```text
REACT_APP_SUPABASE_ANON_KEY
REACT_APP_SUPABASE_URL
SESSION_SECRET
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Optional Upstash values (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
were not set. `api/_lib.js` uses them for the shared rate limiter when present;
without them the Worker falls back to per-isolate memory, so login/coupon/
checkout limits are weaker than Vercel's. This is an accepted staging gap and
must be revisited before production cutover. `TRACKING_TOKEN_TTL_HOURS` also
stays at its safe default (720 hours).

Non-secret vars are deployed with every release:

```bash
npx wrangler deploy \
  --var PUBLIC_BASE_URL:https://zashm.mohammedhassanmail1.workers.dev \
  --var ALLOWED_ORIGINS:https://zashm.mohammedhassanmail1.workers.dev,http://localhost:3000
```

`PUBLIC_BASE_URL` is a bare https origin; the sitemap prefers a dedicated
`SITEMAP_ALLOWED_ORIGINS` and falls back to `ALLOWED_ORIGINS` for canonical URLs,
and stays fail-closed.

## Staging verification actually performed (measured)

- `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → exit 0; SQL harness **495 passed,
  0 failed** on a real temporary PostgreSQL 17 cluster; all other suites 0
  failed (Cloudflare worker **148/0**, sitemap **52/0**).
- `npm run build` → exit 0; `index-L2XyCp3w.js`, byte-identical hash to the live
  Vercel bundle. `wrangler deploy` → version
  `05ee31cc-02ea-4a93-b0eb-e5aff789296e`.
- Headers (curl): `/`, `/shop`, `/product/:id` → 200 with no `X-Robots-Tag`;
  `/admin`, `/cart`, `/checkout`, `/wishlist`, `/track`, `/track?tk=…`,
  `/api/*` and the telemetry shim → `noindex, nofollow, noarchive`;
  `/does-not-exist` → real 404 with `<title>Page Not Found — ZASHM`.
  The Cloudflare CSP is character-for-character identical to the live Vercel
  CSP, with no new `script-src 'unsafe-inline'`.
- Crawler parity (curl with real User-Agent): Googlebot on an unknown numeric
  product id → **404** + `noindex` + shipped `404.html`; the same URL with a
  browser UA → 200 SPA shell; Googlebot on a real product → 200. This ports
  `middleware.ts` behaviour that was missing from the first adapter.
- `/sitemap.xml` → only `*.workers.dev` URLs: `/`, `/shop` and the two real
  product URLs, read from `build/prerendered-products.json` via `ASSETS`.
- API probes: unknown tracking id → HTTP 200 `{"found":false}`;
  GET `/api/coupons/validate` and `/api/auth` → 405 (method guard intact);
  coupon apply from the cart → `OPTIONS 204` + `POST 200` and the UI message
  "Invalid or expired discount code".
- Browser (real page, no mocked network): home → shop → product → size/colour →
  add to bag → cart persists 1 item → checkout form → track deep link → admin
  login form with fake credentials (401, "Invalid credentials", no session).
  Product images load from Supabase Storage.
- After the telemetry shim: **0 console errors, 0 failed network requests**;
  `/_vercel/speed-insights/script.js` → 200 executable no-op, `no-store`,
  `noindex`. Before the shim that Vercel-injected URL produced a 404 + MIME
  error on Cloudflare.
- `wrangler tail`: 624 log events during the smoke test, **0 error-level**
  events and no secret/PII patterns.
- **No writes to Supabase**: no order was placed, no coupon/product/order/user
  row was created or changed. The only persistence was the browser-local bag.

## Residual gap before cutover

- Owner decision (2026-11-24): **no custom domain is being purchased now**. The
  migration stays on `*.workers.dev`; a `.com` domain must still be chosen and
  registered before the first paid ad. `zashm.com` was unavailable at the last
  check; Porkbun was around $11.81/year, subject to availability.
- Before DNS cutover, redeploy with `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS` set
  to the final custom-domain origin (and optionally a dedicated
  `SITEMAP_ALLOWED_ORIGINS`), then re-fetch `/sitemap.xml` to confirm canonical
  URLs use the domain, not `workers.dev`.
- The in-app browser harness exposes no viewport control, so 320/375/768/1440px
  could not be re-driven on the staging origin. The bundle is byte-identical to
  the Vercel build that was already verified at those widths; staging was
  measured at its available 816px viewport with `scrollWidth == clientWidth`
  (no horizontal overflow) on home, shop, product, cart, checkout and admin.
  Re-run the viewport matrix on a device/browser before DNS cutover.
- Admin product edit / order status / cancel were not exercised: there is no
  staging admin account, and creating one would be a Supabase write outside the
  approved scope.
- Order success page cannot be reached without placing a real order; it was
  intentionally not submitted.

## Rollback

- Keep Vercel deployment `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` and its alias.
- Do not point the custom domain at Cloudflare until after full verification.
- If Cloudflare is cut over and must be reverted, change DNS back to the Vercel
  alias; no database rollback is needed because no SQL was changed.
- Never weaken RLS, CSRF, CORS or origin checks to make a migration pass.
