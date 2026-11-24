# Cloudflare Workers migration

Status: **staging deployed, not cut over**. Vercel remains the live rollback
target (`dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`, alias `za-shm.vercel.app`).
No Supabase catalog/customer data, grants, RLS, Vercel settings or DNS were changed.
A fake coupon probe may increment the operational `zshm_rate_limits` counter.
The base migration is committed as `4c0e2ef`/`25bb149` on `cloudflare-migration`
and pushed to `origin`. The later parity/review fixes are committed on this same
migration branch in a separate commit; the branch is **not merged** and was
**not deployed to production**.

Staging Worker: `https://zashm.mohammedhassanmail1.workers.dev`
Current version: `161d42a0-0224-4a49-9225-a3ac983491a7` (deployed from commit
`611eafbbf28469178c857f2d2c49159f0591de7a`; Worker tag `611eafb`)
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
- `scripts/test-cloudflare-worker.mjs` — 173 assertions for config parity,
  route coverage, adapter behaviour, headers, 404/SPA routing, prerendered
  product shells, `/api/sitemap` manifest parity, sitemap origin, lazy chunk-wise
  bounded body handling, crawler 404 parity, Origin/CSRF gates, Set-Cookie
  preservation, asset-binding failures, build-time origin rewriting, `/shop`
  generated shell, degraded sitemap cache and the Vercel-only telemetry shim.
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
- `wrangler deploy --dry-run` → 1152.90 KiB / gzip 210.22 KiB, `ASSETS` binding.
- Live staging headers (measured): `/` and `/admin` 200, `/api/orders` 200 with
  `noindex, nofollow, noarchive` and `no-store`, unknown route real 404.
  CSP matches `vercel.json` byte-for-byte with no new `unsafe-inline`.
- Independent review: the base migration had no findings; the parity/review
  rounds found 7 defects in total (2 SEO/sitemap parity gaps, 3 review findings,
  the `/shop` canonical gap and one rewrite-safety test gap). All are fixed,
  re-verified locally and live; the final re-review returned **no findings**.

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
were not set. They are **not required**: `api/_lib.js` first uses the durable
Supabase RPC `zshm_rate_limit` (already applied in production and service-role
only), and only falls back to bounded per-isolate memory when both Upstash and
the RPC are unavailable. Cloudflare's official `node:crypto` support covers the
`createHash` call used by that RPC, and a live staging coupon probe produced no
fallback warning or exception in `wrangler tail`. Upstash can still be added
later for lower-latency/global counters; it is an optimisation, not a cutover
blocker. `TRACKING_TOKEN_TTL_HOURS` stays at its safe default (720 hours).

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
  failed (Cloudflare worker **173/0**, sitemap **52/0**).
- `npm run build` → exit 0; `index-L2XyCp3w.js`, byte-identical hash to the live
  Vercel bundle. `wrangler deploy` → version
  `f966967d-0d23-480d-af3a-33f246f62038` after the parity fixes below, then
  version `161d42a0-0224-4a49-9225-a3ac983491a7` from commit `611eafb`.
- A staging/Vercel parity pass found and fixed two real gaps: the Worker now
  serves `build/product/<id>/index.html` (product title, canonical, OG/Twitter,
  Product JSON-LD, `<noscript>`) instead of the generic SPA shell, and
  `/api/sitemap` now receives the local prerender manifest (it previously
  logged "prerender manifest returned HTTP 404" and emitted only 2 URLs).
- An independent review then found three more defects, all fixed: (1) generated
  shells still advertised `za-shm.vercel.app` while the sitemap used the staging
  origin — Worker-served HTML now rewrites only server-approved build-time
  origins to `PUBLIC_BASE_URL` (canonical/site origins only — never CORS-only
  `ALLOWED_ORIGINS`), and `/shop` now gets its own generated shell;
  (2) an unreadable manifest silently produced a 2-URL sitemap with a 1-hour
  cache — it is now logged and uses the 300 s degraded cache; (3) docs drift.
  All are covered by the 173 Worker assertions and re-verified live.
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
  events and no secret/PII patterns. A later coupon probe also logged no
  shared-rate-limit fallback warning.
- Staging vs Vercel parity (13 GET cases): identical status, CSP (564 chars,
  byte-identical), `X-Content-Type-Options`, HSTS, `X-Frame-Options`, COOP and
  private-route `noindex` on `/`, `/shop`, `/product/:id`, `/admin`,
  `/track?tk=…`, `/definitely-missing`, `/sitemap.xml`, `/api/sitemap`,
  `/api/admin/products`, `/api/admin/orders`, `/api/auth`,
  `/api/coupons/validate` and a Googlebot unknown product (404 + `noindex`).
  Unauthenticated admin GETs are 401 on both; method-guarded API GETs are 405.
- Login protection (fake accounts only, no real user touched): 12 failed logins
  returned 401 and the 13th returned **429** from the account-level shared
  budget. The egress IP rotated across different Egyptian addresses during the
  probes, so the per-IP/per-email budgets correctly did not fire; the
  account-level budget (12 per 15 min) still did. No session was created.
- Responsive matrix: the exact staging build and API were driven through a
  local same-origin proxy (frame headers stripped only to allow iframes) at
  **320/375/768/1440px** across 8 routes (home, shop, product, cart, checkout,
  wishlist, track, unknown 404) = **32 measurements, 0 horizontal overflows**.
  Product images: 11 loaded, 0 broken at every width. WhatsApp is visible and
  scroll-to-top remains absent at all four widths. Decorative
  `shop-hero-glow`/gallery frames extend past the viewport but are clipped and
  do not create page scroll.
- **No store-data writes**: no order was placed, no coupon/product/order/user
  row was created or changed. The only persistence was the browser-local bag;
  a fake coupon probe can increment the operational `zshm_rate_limits` counter,
  but no catalog or customer record was touched.

## Stage 2 verification (commit `611eafb` only)

- Deployed **only** the migration branch commit `611eafb` to Cloudflare Workers
  staging with `wrangler deploy --tag 611eafb --message "…611eafb…"`. The
  resulting version `161d42a0-0224-4a49-9225-a3ac983491a7` is active at 100% in
  deployment `e9fdd587-b44c-45bd-aeda-e442a0aec73f`; `wrangler versions list`
  shows the commit tag and full commit SHA in the version annotations.
- Vercel Production was **not** changed. Read-only `vercel alias ls` confirms
  `za-shm.vercel.app` and `zashm-git-main-zashm.vercel.app` still point to
  `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` (READY). The GitHub integration created a
  branch preview alias `zashm-git-cloudflare-migration-zashm.vercel.app` →
  `dpl_96ed4MLnZmgu3Ut4Nr5yDrL8k9LV`; it is not Production and was not deleted.
- Live smoke after the commit deploy: 18 GET cases (17 application routes/APIs
  plus one Googlebot case) matched status and the six compared security headers
  on staging vs Vercel, except the intentional Vercel-only telemetry URL. The
  staging telemetry shim returns a no-op with `no-store`/`noindex`; Vercel's
  platform-served real script uses long cache and no extra robots/CSP headers.
  CSP remained 564 characters on every application response.
- Canonicals on `/`, `/shop` and the product are all `workers.dev`; zero
  `za-shm.vercel.app` occurrences in HTML or sitemap. Supabase image URLs and
  `schema.org` URLs remain unchanged. `/api/sitemap` and `/sitemap.xml` each
  return 4 staging URLs with the healthy 3600 s cache.
- Browser smoke on home, shop, product, cart and checkout: 0 console errors,
  correct titles/canonicals, no horizontal overflow at the desktop viewport.
- Isolated test harness: throwaway PostgreSQL 17 cluster (auto-destroyed), fake
  Supabase clients, dummy env values and a temporary egress guard that blocked
  all non-loopback DNS/TCP/TLS/`fetch`. Under that guard:
  `test-sessions-admin` 93/0, `test-admin-products` 97/0,
  `test-order-lifecycle` 106/0, `test-order-pricing` 126/0,
  `test-checkout-idempotency` 8/0, `test-coupons` 97/0,
  `test-order-edit` 131/0 and `test-sql-concurrency` 495/0. Zero egress-block
  events. This proves login/session creation, 4h expiry, tamper rejection,
  logout revocation, admin order edit/status/delete RPC contracts and atomic
  order/coupon/stock behaviour on isolated data — **not** against the live
  Supabase project.
- Local Supabase stack could not be started: `supabase status` reports Docker or
  Podman missing. A cloud staging Supabase project was not created because that
  would require new credentials and production-adjacent configuration changes.
- The store is Cash on Delivery only (`src/pages/CartPage.js:1415`); there is no
  payment gateway or sandbox integration in the shipped code. A gateway
  sandbox test therefore cannot be run without a separate approved feature and
  credentials.

## Residual gap before cutover

- Owner decision (2026-11-24): **no custom domain is being purchased now**. The
  migration stays on `*.workers.dev`; a `.com` domain must still be chosen and
  registered before the first paid ad. `zashm.com` was unavailable at the last
  check; Porkbun was around $11.81/year, subject to availability.
- Before DNS cutover, redeploy with `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS` set
  to the final custom-domain origin (and optionally a dedicated
  `SITEMAP_ALLOWED_ORIGINS`), then re-fetch `/sitemap.xml` **and** a product,
  `/shop` and `/` to confirm canonical/OG URLs use the domain. The Worker
  rewrites approved build-time origins at response time, so a rebuild is not
  required for canonical correctness, but rebuilding with the final origin is
  still recommended so the shipped HTML is self-consistent.
- The 320/375/768/1440px matrix was driven through a local proxy of the exact
  staging build/API (iframe viewport emulation) rather than a physical device.
  A short device/browser pass is still worth doing before DNS cutover, but no
  overflow was measured in 32 route×width combinations.
- Admin product edit / order status / cancel were not exercised: there is no
  staging admin account, and creating one would be a Supabase write outside the
  approved scope.
- Order success page cannot be reached without placing a real order; it was
  intentionally not submitted.
- Admin write paths, successful login/session creation, 4h expiry, logout
  revocation and the full order lifecycle were proved in the isolated local
  harness above (zero egress). They were **not** repeated against a hosted
  staging Supabase because none exists and creating one needs separate approval.
- No sandbox payment test is possible: the current store is Cash on Delivery
  only. `docs/launch-returns-and-payments-playbook-ar.md` describes a future
  payment design, not shipped code.
- A physical-device pass was not performed from this environment. The available
  evidence remains the 32 route×width browser/iframe measurements.
- Rollback review: current Vercel Production (`dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`)
  is READY and still owns the alias; previous production
  `dpl_EqWWhqzsVDXuLMFnkA6UWUtMUNoY` is also READY and is the documented
  rollback target. Because no DNS cutover happened, the current rollback action
  is simply to keep Vercel serving. `vercel rollback` was previously rejected
  by the plan, so a failed future Vercel deploy must be reverted by redeploying
  the last known-good build; no rollback was executed here.
- No DNS, Vercel or Supabase production setting may be changed, and no real
  order or customer record may be created, until the remaining hosted/device
  tests are approved and completed in a separate step.

## Rollback

- Keep Vercel deployment `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` and its alias.
- Do not point the custom domain at Cloudflare until after full verification.
- If Cloudflare is cut over and must be reverted, change DNS back to the Vercel
  alias; no database rollback is needed because no SQL was changed.
- Never weaken RLS, CSRF, CORS or origin checks to make a migration pass.
