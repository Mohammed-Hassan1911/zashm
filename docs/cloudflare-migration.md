# Cloudflare Workers migration

Status: **temporary production launch active on Cloudflare Workers**. Vercel
is retained only as the public 307 bridge and the rollback target: the public
alias `za-shm.vercel.app` now points to the approved redirect deployment
`dpl_9DfBJfoD3hWqFpukeCGEL9R6BsnQ`, while the original deployment
`dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` and the two SSO-gated production aliases
are preserved as the rollback state (see §Vercel → Cloudflare 307 redirect and
§Rollback). The base migration changed no Vercel settings; the separately
approved cutover is recorded below. No Supabase catalog/customer data, grants,
RLS or DNS settings were changed. A fake coupon probe may increment the
operational `zshm_rate_limits` counter. The base migration is committed as
`4c0e2ef`/`25bb149` on `cloudflare-migration` and pushed to `origin`. The later
parity/review fixes are committed on this same migration branch in a separate
commit; the branch is **not merged**.

Production Worker: `https://zashm.za-shm.workers.dev`
Staging Worker: `https://zashm-staging.za-shm.workers.dev`
Legacy Worker `https://zashm-stage3.za-shm.workers.dev`: deleted 2026-11-25 with
owner approval (see §Stage 3 cleanup). The original three URLs followed the
account subdomain change documented in Phase 5; the former
`*.mohammedhassanmail1.workers.dev` URLs are retired.
Owner Cloudflare account: `9fe493bc12463ea71e52fd2f040c5171`

## What changed

- `wrangler.toml` — Worker entrypoint, `build/` static assets, `ASSETS` binding,
  `not_found_handling = "404-page"` (unknown routes stay real 404s),
  `html_handling = "none"`, and selective `run_worker_first` patterns: `/*`
  keeps API/dynamic/private/telemetry routes Worker-first, while negative
  patterns let immutable CSS/JS/font/image files be served directly by Cloudflare
  Assets with the unchanged `public/_headers` CSP/cache rules.
- `worker.mjs` — translates Worker `(Request) => Response` into the existing
  Vercel-style `(req, res)` handlers in `api/`. Adds the shared security headers,
  `noindex` for private routes, SPA rewrites, `/api/errors` rewrite and
  `/sitemap.xml` routing. No API handler was rewritten.
- `public/_headers` — static-asset parity with `vercel.json` (CSP, HSTS,
  immutable cache, `noindex`).
- `scripts/test-cloudflare-worker.mjs` — 196 assertions for config parity,
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
  --var PUBLIC_BASE_URL:https://zashm-staging.za-shm.workers.dev \
  --var ALLOWED_ORIGINS:https://zashm-staging.za-shm.workers.dev,http://localhost:3000
```

`PUBLIC_BASE_URL` is a bare https origin; the sitemap prefers a dedicated
`SITEMAP_ALLOWED_ORIGINS` and falls back to `ALLOWED_ORIGINS` for canonical URLs,
and stays fail-closed.

## Staging verification actually performed (measured)

- `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → exit 0; SQL harness **495 passed,
  0 failed** on a real temporary PostgreSQL 17 cluster; all other suites 0
  failed (Cloudflare worker **196/0**, sitemap **55/0**).
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
  All are covered by the 196 Worker assertions and re-verified live.
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

## Workers Free optimization (uncommitted Staging draft)

Baseline commit `8f73b7a` was first deployed unchanged to the Staging Worker as
`c4bd9005-a19c-4701-973b-453a4d9cc422` (tag `8f73b7a-baseline`, message contains
the full SHA). Only then was selective routing applied as an **uncommitted**
draft and deployed as `73eb468a-81d8-44b7-bebf-1e1491edb07a`
(tag `routing-selective-v2`). No commit, push, DNS, domain, Vercel Production,
Supabase Production, secret rotation or Cutover was performed.

- Controlled same-origin replay on the exact browser asset graph: home
  **15 → 2** Worker invocations (document + telemetry shim), shop **18 → 2**,
  product **19 → 3** (adds `/api/reviews`). That is an **84–89% reduction** in
  Worker calls per full page view. Dynamic product HTML, canonical/OG, CSP, real
  404, sitemap, private `noindex`, API method guards and the telemetry no-op all
  still return 200/404/405 with the same headers.
- CPU per important route (Staging tail, one controlled request each): document
  0–1 ms, `/api/sitemap` 2 ms, `/sitemap.xml` 3 ms, `/api/reviews` 21 ms,
  `/admin`/`/cart` 0 ms, unknown order 1 ms. Worker code was not modified.
- GET-only load mix (5/15/30 concurrent clients, 25 s each): baseline p95
  **442/1229/2787 ms** vs optimized **304/1063/2136 ms**; all responses **200**,
  **0 × 429**, **0 × 5xx**, 0 client errors. Cloudflare GraphQL observed 1310
  Worker requests / 1.13 s CPU / 1535 subrequests / 0 errors for the baseline
  window, vs 856 / 0.97 s / 1178 / 0 for the optimized window. GraphQL aggregates
  undercount the all-static baseline, so the exact request graph above is the
  primary invocation evidence.
- Free planning: Workers Free allows **100,000 requests/day**. At 2–3 invocations
  per full page view the break-even is only **~33k–50k full page views/day**;
  with a 30% safety margin, plan for **~23k–35k/day**. If the store genuinely
  expects up to 100,000 full page views/day, Workers Paid will be required even
  after this optimization; Free only fits a materially smaller store.
- Staging data separation: the previous Production-backed Staging bundle was
  replaced. `npm run build` is now run with `REACT_APP_SUPABASE_URL` /
  `REACT_APP_SUPABASE_ANON_KEY` (and their `VITE_*` equivalents) set to
  `sfenutmgfawuhmvwkmhv`, `PUBLIC_BASE_URL` set to the `workers.dev` origin and
  `ALLOWED_ORIGINS` / `SITEMAP_ALLOWED_ORIGINS` set to the same Staging origin.
  The prerender therefore contains only the two Staging fixtures
  (`9900000000001`, `9900000000002`) and no Production Storage image URLs. A
  scan of `build/` finds zero occurrences of the Production project ref; the
  built `_headers`, bundle, preconnect and product shells all resolve to the
  Staging ref. No catalog/order/coupon/user row was copied from Production.
- Environment-specific CSP: `worker.mjs` no longer hard-codes any Supabase host.
  `configuredSupabaseOrigin()` resolves the exact origin from the deployment's
  `REACT_APP_SUPABASE_URL` / `SUPABASE_URL` binding and inserts it into
  `connect-src`; an invalid or missing value yields the Supabase-free baseline
  rather than a Production fallback. `public/_headers` is an environment-neutral
  template with `__ZASHM_SUPABASE_ORIGIN__`, replaced at build time by
  `vite.config.js` from the same URL. Static assets bypassing the Worker and
  Worker-generated responses therefore describe the same project.
- Staging Worker secrets (`zashm`, Staging only): `REACT_APP_SUPABASE_URL`,
  `REACT_APP_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` were replaced with
  the Staging project values with `wrangler secret put`. The anon key was checked
  by SHA-256 prefix against the key embedded in the rebuilt bundle before upload;
  no service-role JWT or literal secret appears in `build/`, the Worker source or
  any log. `SESSION_SECRET` and the existing notification credentials were left
  untouched; no Production secret was rotated.
- Staging Worker vars (non-secret, passed on the deploy command only, not added to
  `wrangler.toml`): `PUBLIC_BASE_URL`, `SITEMAP_ALLOWED_ORIGINS` and
  `ALLOWED_ORIGINS` all equal `https://zashm-staging.za-shm.workers.dev`.
  Without them the sitemap fell back to the old `za-shm.vercel.app` origin and the
  API rejected the Staging Origin; the v2 deploy fixed both. A future Production
  Worker must receive its own vars and secrets; none are inherited from Staging.
- Future Production cutover configuration stays separate: the same code is
  deployed with Production's URL/anon/service-role bindings supplied in the
  production Worker environment, and `npm run build` is run with Production's
  env values. This is a distinct, owner-approved step; no Production ref is
  baked into the committed source or the Staging bundle.

## Staging data-isolation deploy verification (2026-11-24)

- Pre-deploy guard: `wrangler domains`/zone/route lookups found **zero** custom
  domains, routes and zones attached to this account, so `zashm` is reachable
  only on `workers.dev`. Only Worker `zashm` was deployed; Vercel and Supabase
  Production, DNS, main and paid plans were untouched. No commit or push was made.
- Deployment: `95ff1385-...` (v1) published the Staging-only build and secrets;
  `49cfc0f5-...` (v2) added the three Staging-only origin vars. Both are 100%.
- Published asset scan: every fetchable file under `build/` was downloaded from
  the live Worker: 0 Production refs, 0 `service_role` JWTs, 0 non-2xx responses.
  `build/_headers` is a Cloudflare config file and is intentionally not fetchable.
- Live route/header/metadata probe: 83/0 assertions — all pages and APIs return
  the expected status, every CSP allows only the Staging Supabase origin,
  canonical/OG/sitemap use the workers.dev origin, private paths are `noindex`,
  unknown paths are a real 404, and `STAGE3TEST10` returns `valid:true`.
- Browser network capture on `/`, `/shop` and a Staging product: the only
  Supabase request is `GET https://sfenutmgfawuhmvwkmhv.supabase.co/rest/v1/products_public`,
  zero Production hosts; the shop shows exactly 2 Staging fixtures. A pre-existing
  `zashm_cart` entry in the test browser profile (created during the earlier
  Production-backed Staging build) did request one old Production Storage image.
  After removing that local-only test state and reloading, the cart was empty and
  the network capture was again 100% Staging/workers.dev. No source change was
  needed; this is client-side residue, not a shipped bundle reference.
- Admin sessions through the Worker: 11/11 (anonymous 401, admin/support login,
  secure HttpOnly/SameSite cookie + CSRF, role deny 403, logout + revocation).
- COD/idempotency/stock: 20/20 assertions directly against Staging Postgres via
  the same `atomic_place_order` / `atomic_delete_order` RPCs the API calls. The
  order inserted at the server price, the replay returned the same order id with
  no second stock decrement, and `atomic_delete_order` restored stock to 8 and
  removed the test row. This was deliberately not triggered through the Worker
  HTTP path because this Worker's pre-existing Telegram destination cannot be
  verified as a staging-only chat; no test notification was sent anywhere.
- CPU/invocations: a 23-request replay produced 10 Worker invocations (13 static
  assets bypassed the Worker). Cloudflare GraphQL over the following 20 minutes
  recorded 1,523 requests, 2,095 subrequests, 0 errors, CPU P50 1,043 µs,
  P95 3,306 µs and P99 12,509 µs. Free allows 10 ms CPU **per request**; P95 is
  well inside it but P99 needs monitoring for `exceededCpu`. Load replay at 5/15/30
  clients completed with 0 × 429 and 0 × 5xx; p95 532/964/3,147 ms in the clean
  run (one earlier run had a single transient client-side `fetch failed`).
- Free remains sufficient for an initial launch at ~23k–35k full page views/day
  with a 30% margin; ~33k–50k/day is the hard break-even at 2–3 invocations per
  page view. 100,000 full page views/day requires Workers Paid.

## Owner follow-up verification (2026-11-24)

- **CPU limit check.** GraphQL `workersInvocationsAdaptive` with the `status`
  dimension over the last 6 hours returned **only `success`**: 6,646 requests,
  0 errors, no `exceededCpu`, no `exception`/`error`/`canceled` bucket. Filtering
  the exact 1,523-request window by `status=error`, `exception`, `canceled` and
  `exceededCpu` returned empty sets in every case, so the count of hard CPU
  failures (Cloudflare error 1102) is **0 of 1,523**. Cloudflare's GraphQL API
  exposes CPU only as quantiles (P50/P75/P90/P95/P99), not as a per-invocation
  count above 10 ms, and `wrangler tail` is sampled to ~8–10 events per session
  here; an exact "N over 10 ms" figure is therefore not available from this
  environment. The percentile bounds for that window (P95 3,306 µs, P99
  12,438 µs) put the number above 10 ms between ~1% and ~5% (≈16–81 requests),
  with **zero** failed invocations. A wider 90-minute window (8,210 requests)
  was healthier: P50 706 µs, P75 1,225 µs, P90 1,907 µs, P95 2,615 µs, P99
  6,623 µs. Controlled replay attributes the meaningful CPU to API routes only
  (`/api/reviews` ≈2 ms, `/api/sitemap` ≈1 ms, `/sitemap.xml` ≈1 ms; document
  routes and static assets 0–1 ms). No code change was justified: there is no
  error to fix, and P95 stayed >3× inside the 10 ms limit.
- **Full order POST through the deployed Worker** (`verify-http-order.mjs`,
  26/0). The deployed Staging Worker still has `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID` bound (`wrangler secret list` shows the names only; no value
  was read). Unsetting them is a Staging secret change plus a deploy, which needs
  owner approval and was **not** done. Instead the test exercised only the two
  code paths that deliberately skip notification: (a) success through the
  documented idempotent-duplicate branch — the order was first written in
  Staging Postgres with the same idempotency key, then `POST /api/orders` was
  sent to the live workers.dev origin with deliberately wrong client totals
  (`1`); (b) fresh 422 refusals. The Worker returned 200 `duplicate:true` with
  server figures subtotal 200, coupon discount 20, Cairo shipping 65, total 245;
  stock stayed at 6 and coupon usage at 2. Fresh 422 paths rejected qty 9
  (stock message) and an invalid coupon. `atomic_delete_order` restored stock to
  8 and coupon usage to 1 and removed the test row. The Worker tail contained no
  `telegram`, no `api.telegram.org` and no Production ref; no secret was read or
  changed and Staging is the only project involved. **Residual:** a brand-new
  successful order on this Worker would still attempt a Telegram notification
  while those bindings exist; no such order was placed. If the owner requires the
  bindings literally removed rather than merely unused, approve a Staging-only
  secret deletion plus redeploy.
- **Stale cart from a previous environment.** Reproduced on the currently
  deployed bundle: a persisted cart line whose product is absent from the
  Staging catalogue still carried an old Production Storage URL and did issue
  that request when its lazy image loaded. Fixed locally in `src/store.js`:
  persisted image URLs are filtered to the current Supabase origin (data/blob/
  same-origin URLs remain) at load and at save, and a line with no live catalog
  product now raises a blocking `missing_product` issue with a Remove action.
  `scripts/test-stale-cart-isolation.mjs` (32/0) covers the guard; a local
  preview of the rebuilt Staging bundle with the hostile cart showed zero
  Production/Storage requests, an inline SVG fallback and the blocking message.
  **This fix is not deployed**: it is part of the uncommitted diff awaiting owner
  approval. The currently live version still has the old behaviour.
  A senior review of the diff found one Medium issue — a stale snapshot/cache
  catalogue could falsely block a valid line — now gated on
  `productsSource === 'live'` and executed in test section `[4]`. The two
  Supabase env resolvers (build-time and Worker) now share one precedence, and
  the CSP helpers default to `{}` so ambient build env cannot skew assertions.
- **Final local proof for this follow-up.** `ZSHM_REQUIRE_SQL_TESTS=1 npm test`
  → exit 0, **4,024 passed, 0 failed** (SQL harness actually ran, not skipped);
  `node scripts/test-cloudflare-worker.mjs` → **196/0** with and without an
  ambient `REACT_APP_SUPABASE_URL`; `node scripts/test-stale-cart-isolation.mjs`
  → **32/0**; `npm run build` with the Staging env → exit 0 and **zero**
  occurrences of the Production project ref in `build/`. `git rev-parse HEAD`
  is unchanged at `8f73b7a9146115ea83ea1789576014246849a265`.

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

## Phase 1 — independent Production preparation (2026-11-24)

Owner-approved scope: **preparation only**. No Worker was created or deployed,
no Production secret was entered or copied, no Zone/Custom Domain/DNS was
created, Workers Paid was not subscribed, and Vercel/Supabase Production and
`main` were untouched. The Staging Worker remains at
`bdc45ae7-f8bd-4f4f-9591-c8b57fc8aa61`.

- `wrangler.production.toml` is a distinct Worker configuration:
  `name = "zashm-production"` (superseded by `zashm` in Phase 5), `workers_dev = false`, **no `route`,
  `routes`, `pattern`, `zone_id`, `zone_name` or `custom_domain`**. It serves
  `./build-production`, keeps `not_found_handling = "404-page"`, and mirrors the
  reviewed Staging `run_worker_first` patterns exactly. It contains no
  Supabase project URL, no secret name/value, and no Staging host.
- `build:production:prep` writes a separate, ignored `build-production/` using
  the Production project ref only for CSP/preconnect, a **non-credential
  placeholder** anon key, and the non-public `production-prep.invalid`
  canonical origin. `ZASHM_SKIP_CATALOGUE_FETCH=1` prevents even a read request
  to Supabase; no product fixture is copied. `robots.txt`, JSON-LD and Speed
  Insights use the prepared origin instead of the legacy Vercel domain.
- `src/lib/production-env.mjs` is the shared fail-closed contract. When
  `ZASHM_ENVIRONMENT = "production"`, `src/lib/worker-runtime.mjs` returns a
  cached `noindex` 503 **before copying any binding or reaching an API handler** unless every
  required production binding is present, non-placeholder, points at
  `ptegprcbtfylqhbnbkih`, uses an approved https public origin, and keeps
  server-only names out of `VITE_*`/`REACT_APP_*`. Staging has no such flag and
  is unaffected.
- `scripts/verify-production-readiness.mjs` provides config-only, env-only and
  bundle-only gates; `scripts/test-production-isolation.mjs` adds 49 regression
  assertions. The full gate is intentionally **BLOCKED** in this environment
  (9 problems: no real Production bindings). That is the required fail-closed
  behaviour, not a deployment failure.
- Deterministic SHA-256 of the 36 prepared public files (relative path +
  content, sorted) at verification time:
  `de91fdda0c32bb0a6a546ab7db4ac81f8817414a265c2e38d06e8a284dee2510`.
  A scan of `build-production/` found **0** Staging refs, **0** Vercel
  Production refs, **0** JWT/Telegram/Upstash values and **0** server-only
  secret names.
- `npm run build` succeeds. Its plain invocation uses the ambient local env,
  so that generated, ignored `build/` was **removed** rather than kept as
  Staging evidence or reused for a deploy. The deployed Staging bundle is
  unchanged.
- `wrangler deploy --dry-run --config wrangler.production.toml` succeeded with
  40 files from `build-production` (1159.10 KiB / 211.65 KiB gzip) and only
  `ASSETS` plus the non-secret `ZASHM_ENVIRONMENT` binding. This is a local
  bundle check; no public endpoint exists.

### Cost correction carried into the plan

- At the stated operating assumption of **75,000 Worker requests/day** the
  monthly usage is 2.25M requests and 4.5M CPU-ms, both inside Paid's included
  10M/30M, so the correct cost is **$5.00/month on Paid** ($0 on Free while
  under the daily cap). Free usage is 75% of 100k/day, leaving exactly **25k
  requests/day = 25% headroom** before error 1027.
- **$6.80/month is not the expected bill at 75k/day.** It applies only to the
  extreme sensitivity case of 100k full page views/day × 5 Worker calls × 3 ms
  CPU: 15M requests and 45M CPU-ms per 30-day month ⇒
  `$5 + 5M × $0.30/M + 15M × $0.02/M = $6.80`.
- Spending Limit is **account-wide and shared by every Worker/environment**,
  not a Production-project cap; it covers requests and CPU after included
  usage, excludes the $5 subscription, rejects new invocations with **1103**,
  and leaves Worker-free static assets available.
- If launch is on/after **2026-12-01**, Workers Logs uses Cloudflare
  Observability pricing: Free 0.5 GB ingestion/day with 7-day retention;
  Paid 50 GB ingestion + 10 GB-month storage per billing cycle, then
  `$0.25/GB` ingestion and `$0.10/GB-month` storage, shared account-wide with
  Traces/Containers/R2/AI Gateway/Issues. No Logpush is enabled and no fixed
  log cost is assumed.

## Phase 3 — brand-named temporary workers.dev preparation (2026-11-24)

Owner-approved scope: local protected testing only. The ZASHM-branded temporary
origin was `https://zashm-production.mohammedhassanmail1.workers.dev`; Phase 5
replaced it with `https://zashm.za-shm.workers.dev`. It was used
**only** in a deleted, uncommitted local env file. No public activation, DNS,
Custom Domain, Route, Zone, Cutover, Vercel change, Production secret change or
Production data change occurred.

- The workerd startup error (`Incorrect type for map entry 'CSP'`) was fixed in
  source, not with a wrapper: `worker.mjs` now exports only the default handler,
  and all named test helpers live in `src/lib/worker-runtime.mjs`. Node suites
  import the helpers from the shared module. A regression assertion prevents
  named exports from returning to the runtime entrypoint.
- `src/lib/production-env.mjs` permits the exact temporary origin **only** when
  the non-secret opt-in `ZASHM_TEMP_WORKERS_DEV=1` is present. Without that flag
  a `workers.dev` canonical is still rejected; the Staging host
  `zashm-staging.za-shm.workers.dev` is never accepted even with the flag.
- Direct `wrangler dev --local --config wrangler.production.toml` now starts
  without any wrapper. Local env used the temporary origin as
  `PUBLIC_BASE_URL`, added it to `SITEMAP_ALLOWED_ORIGINS` together with the
  prepared build origin so canonical URLs could be rewritten, and set the opt-in
  flag. The temp file and local state directory were deleted afterwards.
- GET-only evidence from `127.0.0.1:8793`: `/` and `/shop` returned 200 with
  canonical URLs on the temporary ZASHM workers.dev origin; `/sitemap.xml` and
  `/api/sitemap` returned 200 with two `loc` entries on that origin and no
  Vercel/Staging/placeholder origin; private/admin routes returned `noindex`;
  unauthenticated `/api/admin/*` GETs returned 401; `/does-not-exist` stayed a
  real 404; CSP and all baseline security headers were present and CSP allowed
  only the Production Supabase origin. 28 GET lines and 0 non-GET lines appear
  in the dev log.
- Secret scan: 0 hits in `build-production/`, 0 in all local response bodies,
  0 in the dev log. No secret value was printed.
- Remote boundary unchanged: `workers_dev = false`, zero Routes, zero Custom
  Domains, zero Zones, workers.dev still `404 / error code: 1042`, no new Worker
  version, active version still `3c9e2bdd-038e-46e8-80d9-cd8d1127f06e`.

### Separate owner approval required to activate temporary workers.dev

1. Obtain explicit owner approval for public activation. Nothing below has been
   executed.
2. Change `wrangler.production.toml` to `workers_dev = true` **only at that
   point**; keep zero Routes/Custom Domains/Zones.
3. Inject the non-secret bindings `PUBLIC_BASE_URL` = the temporary ZASHM
   workers.dev origin, `SITEMAP_ALLOWED_ORIGINS` = that origin (plus the prepared
   build origin if the prep artifact is reused), and
   `ZASHM_TEMP_WORKERS_DEV = 1`. Do not alter existing secret values.
4. Deploy with `wrangler deploy --config wrangler.production.toml`, record the
   new Version ID, then verify the public workers.dev URL, canonical, sitemap,
   CSP/security headers, admin 401s, and the continued absence of Routes,
   Custom Domains and Zones.
5. Rollback: restore `workers_dev = false` and redeploy the previous retained
   version. No DNS or database rollback is involved.

## Phase 4 — temporary workers.dev launch (2026-11-24)

Owner approval was explicit: publish the Production Worker (then named
`zashm-production`, renamed to `zashm` in Phase 5) on its default Cloudflare
workers.dev hostname only, with no paid domain, no DNS change, no Route, no Zone,
no Custom Domain, no Workers Paid subscription, no secret rotation, and no change
to Vercel Production, Supabase Production or `main`.

- `wrangler.production.toml` now sets `workers_dev = true` for
  `zashm`, with zero routes/domains/zones and `preview_urls = false`
  so no extra hashed public endpoint is created. Staging `wrangler.toml`
  keeps its reviewed settings (`zashm-staging`, `workers_dev = true`, `./build`).
- Non-secret `[vars]`: `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS` and
  `SITEMAP_ALLOWED_ORIGINS` are all the temporary canonical origin
  `https://zashm.za-shm.workers.dev` (the Phase 4 value was
  `https://zashm-production.mohammedhassanmail1.workers.dev`; see Phase 5);
  `ZASHM_TEMP_WORKERS_DEV = "1"` satisfies the fail-closed guard; and
  `ZASHM_STOREFRONT_NOINDEX = "1"` adds `X-Robots-Tag: noindex, nofollow,
  noarchive` to Worker-handled routes and bakes the same header plus
  `<meta name="robots" content="noindex, nofollow, noarchive">` into the static
  Cloudflare Assets shells, while leaving checkout and purchasing fully usable.
  Private/admin/API paths keep their existing noindex header.
- The launch artifact is built from Production Supabase settings and the real
  public anon key into `build-production/`; no preparation placeholder or
  Vercel/Staging origin remains. Server-only credentials stay as Worker secrets.
- `scripts/verify-production-readiness.mjs` now accepts workers.dev **only** when
  the exact temporary origin, opt-in flag, sitemap allow-list and storefront
  noindex flag are present. Any Route, Zone, Custom Domain or Staging reference
  still fails the gate.
- Rollback: set `workers_dev = false`, redeploy the retained previous version,
  or point traffic back to the untouched Vercel Production deployment
  `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`. No DNS rollback is involved.

## Phase 5 — workers.dev rename and account subdomain (2026-11-24)

Owner request: expose the temporary storefront as
`https://zashm.za-shm.workers.dev` and Staging as
`https://zashm-staging.za-shm.workers.dev` with no extra cutover, no change to
`main`, and no destructive Worker recreation. Target availability was checked
first (`GET /accounts/{account_id}/workers/subdomains/za-shm` returned 404 with
"available but not configured"), and the complete pre-change inventory was
captured: 3 Workers, 0 Custom Domains, 0 Zones and no Routes in either config.

Renames used the beta Workers API `PATCH /accounts/{account_id}/workers/workers/{id}`
with only `{"name": ...}`. No Worker or version was deleted or recreated, and no
secret value was read, printed or rotated.

- Staging: Worker ID `f58073be25504ac097a464f6dd885a15` was renamed from
  `zashm` to `zashm-staging` (PATCH 200). Its ID, 32 retained versions, latest
  version `bdc45ae7-f8bd-4f4f-9591-c8b57fc8aa61` and four secret bindings were
  unchanged. It briefly served `...mohammedhassanmail1.workers.dev` before the
  account subdomain change, then the final `za-shm` URL.
- Account subdomain: `PUT /workers/subdomain` alone returned 409
  "Account already has an associated subdomain." The supported sequence was
  `DELETE /workers/subdomain` (204) followed by
  `PUT {"subdomain":"za-shm"}` (200). The previous value
  `mohammedhassanmail1` was the rollback target and was not needed; a GET now
  confirms `za-shm`. All three Workers acquired the new hostname automatically.
- Production: Worker ID `b7fd1d0db3314691bc9c46a9319bbcda` was renamed from
  `zashm-production` to `zashm` (PATCH 200). Its ID, 13 retained versions,
  latest version `14bb7766-60ff-4a13-a21d-d0d69a9792d3`, eight secret bindings
  and `preview_urls = false` were unchanged.
- Retained legacy Worker `zashm-stage3` (ID
  `6f485b23dfc247c5b810fe1e4d1f356d`, 11 versions) was not renamed or
  redeployed; only its account-derived URL changed.

Post-rename deploys reused the same Worker IDs and added versions without
removing rollback history:

- Production `wrangler deploy --config wrangler.production.toml` produced
  version `e0c390f5-7e70-49a0-ac73-200a3da4eec6` at 12:08:14Z and deployment
  `daaea4fe-f226-4fb2-a27f-2f71ceabe268`. Its non-secret bindings are now all
  `https://zashm.za-shm.workers.dev`, and the eight secret names are unchanged.
  Rollback targets remain version `14bb7766-...` and deployment `bd834a36-...`.
- Staging was rebuilt from its own public catalogue and anon key into `build/`
  (0 Production refs), then redeployed with `PUBLIC_BASE_URL` and
  `SITEMAP_ALLOWED_ORIGINS` set to
  `https://zashm-staging.za-shm.workers.dev` and `ALLOWED_ORIGINS` set to that
  origin plus `http://localhost:3000`. That first post-rename deploy produced
  version `409a8e6e-6010-4484-b3b5-bdadbcf2e513` at 12:17:07Z and deployment
  `f32f5f56-c966-4774-9a6c-fdbc3904633f`. Its four secret names are unchanged;
  rollback targets are version `bdc45ae7-...` and deployment `e23f08c6-...`.
- Owner then required Staging to be fully `noindex` while remaining usable for
  tests. `wrangler.toml` now pins `ZASHM_STOREFRONT_NOINDEX = "1"` as a runtime
  binding, and the static artifact must additionally be built with the same
  build-time flag, because Cloudflare Assets can serve prerendered HTML before
  the Worker runs:

  ```bash
  ZASHM_STOREFRONT_NOINDEX=1 npm run build
  npx wrangler deploy \
    --var PUBLIC_BASE_URL:https://zashm-staging.za-shm.workers.dev \
    --var ALLOWED_ORIGINS:https://zashm-staging.za-shm.workers.dev,http://localhost:3000 \
    --var SITEMAP_ALLOWED_ORIGINS:https://zashm-staging.za-shm.workers.dev \
    --var ZASHM_STOREFRONT_NOINDEX:1
  ```

  This added version `62420756-a496-43e6-a69c-ee1a3d3f0cac` at 18:14:58Z and
  deployment `baa63ee3-1462-49f8-b41b-c2380ec7c328`, without deleting any
  previous version. Canonical, OG, sitemap, robots and CSP stay on the Staging
  origin, and every Staging route now carries
  `noindex, nofollow, noarchive` via both baked meta/header and Worker runtime.
  Pages and APIs still return their normal testable statuses; only crawler
  directives changed. Rollback remains version `409a8e6e-...` / deployment
  `f32f5f56-...` or the older `bdc45ae7-...` / `e23f08c6-...`.

Verification:

- `npm test` with `ZSHM_REQUIRE_SQL_TESTS=1`: 37 scripts, 4109 assertions,
  0 failed. The real PostgreSQL 17 suite ran in a temporary cluster and was
  auto-destroyed; no suite was skipped. Telegram-notification "skipped" lines
  are expected unit-test fixtures, not skipped suites.
- `git diff --check` exited 0. The full `npm run verify:production` gate with
  local env returned `READY: 0 problem(s)` for config, environment and the
  39-file Production bundle.
- `wrangler deploy --dry-run` passed for both configurations before each deploy.
- GET-only Cloudflare smoke after the final Staging deploy: 31 checks,
  0 failures. Production `/`, `/shop`, product, `/cart`, `/checkout`,
  `/wishlist`, `/track`, `/admin`, sitemap, robots and 404 all used the new
  canonical/origin and carried `noindex, nofollow, noarchive`; `/api/orders`
  returned `{"found":false}` and `/api/admin/products` returned 401. Staging
  showed the same read-only/admin behaviour with Staging-only refs, and all
  Staging public pages, sitemap, robots, API responses and 404s now carry the
  same noindex directive while still returning normal testable statuses.
  There were no 429/5xx responses, no old-subdomain or Vercel origin in
  response bodies, and the former `*.mohammedhassanmail1.workers.dev` hosts no
  longer serve a storefront. The first smoke attempt had one transient TLS
  error (`curl` exit 35) on Staging `/`; a clean rerun passed all 31 checks.
- Final API state: account subdomain `za-shm`; the same 3 Worker IDs;
  0 Custom Domains; 0 Zones; no Route in either config; Production
  `previews_enabled = false`; Staging `previews_enabled = true`. Retained
  versions: Production 14, Staging 34, legacy `zashm-stage3` 11. Secret values
  cannot be read back through the API, so preservation was proven by unchanged
  binding names, IDs, versions and settings, not by comparing values.

No Vercel deployment/settings, Supabase data/settings, DNS, paid resources or
`main` were changed on net. Vercel rollback deployment
`dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` and every retained Cloudflare version remain
available.

### Closure verification (2026-11-24)

- Vercel automatic Git preview remains active: before this closure commit, alias
  `zashm-git-cloudflare-migration-zashm.vercel.app` pointed to READY deployment
  `dpl_ELetHqCEu3Wg6SaCaRsLUYmzRNNM`, whose Git metadata records branch
  `cloudflare-migration` and commit `5cd6fe8`. Production alias still points to
  `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`. A new preview is expected to be generated
  automatically from the closure commit; no manual Vercel deployment was made.
- Vercel SSO deployment protection is `all_except_custom_domains` and Git fork
  protection is enabled. A read-only preview probe with `vercel curl`
  auto-created two automation-bypass secrets; the owner approved restoring the
  prior state, both were removed, and the final project has
  `protectionBypass = 0` with no `VERCEL_PROTECTION_BYPASS` env var. No Vercel
  deployment was created, promoted or deleted during this work.
- The committed worker configs and prepared artifacts match what is deployed:
  both live home pages carry the same canonical, OG URL and noindex markers as
  `build-production/index.html` and `build/index.html`, and the live Staging
  Worker version reports the exact origin/noindex bindings from
  `wrangler.toml`.
- Supabase isolation was checked with GET-only REST calls to `products_public`:
  the Production anon key returns 200 only on Production ref
  `ptegprcbtfylqhbnbkih` and 401 on Staging; the Staging anon key returns 200
  only on Staging ref `sfenutmgfawuhmvwkmhv` and 401 on Production. No SQL,
  schema, RLS, data, order or customer record was changed.
- Every rollback artifact remains available: Cloudflare version counts are
  Production 14, Staging 34 and legacy `zashm-stage3` 11; the Vercel rollback
  deployment and its alias are untouched.

## Stage 3 cleanup (2026-11-25)

The owner approved deleting only the legacy Worker `zashm-stage3`. Before the
deletion its 10 retained deployments were captured to
`docs/evidence/zashm-stage3-deployments-before-delete.json` (author emails
redacted); the latest was deployment
`36e4313e-6a69-4f17-9f13-bf07f48a2d1d` / version
`417af14c-55c3-4a63-85c1-2b1b3d574dd6` at `2026-11-24T03:10:17.619745Z`, with
`Phase 3 rollback drill` at `83d7e36f-e6a8-4e6f-b36d-703912f3d0e7`.

`npx wrangler delete zashm-stage3 --force` succeeded. Post-delete checks:
`wrangler deployments list` reports “This Worker does not exist on your
account” and `https://zashm-stage3.za-shm.workers.dev/` returns 404. Production
`zashm` and Staging `zashm-staging` still return 200 with the baked
`noindex, nofollow, noarchive` header. No config, Vercel deployment, DNS,
Supabase setting or customer/order data was changed. The original `zashm-stage3`
Worker cannot be restored from this environment; recreating it would be a new
deployment from scratch and was not requested.

The Vercel → Cloudflare 307 cutover was approved and executed **separately** and
is recorded in the next section. Nothing in the stage3 cleanup changed Vercel.

## Vercel → Cloudflare 307 redirect (2026-11-25, owner-approved)

- Inventory: one Vercel team (`zashm`), **0 custom domains**, three production
  aliases on the original rollback deployment
  `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`: `za-shm.vercel.app` (public),
  `zashm-zashm.vercel.app` and `zashm-git-main-zashm.vercel.app` (both already
  behind Vercel SSO). Both preview aliases remain SSO-protected.
- Attempt 1 (`dpl_C3Y6nE9rZR1pefaxUq1mQRCzmXWX`) added only `/:path*` rules.
  `--expect-redirect` reported **31 passed / 1 failed**: root `/` stayed 200
  because Vercel's `/:path*` did not match the empty path. The launch was
  stopped immediately, all three aliases were restored to `dpl_C38…`, and the
  failed deployment was kept idle (not deleted).
- Attempt 2 (single additional approved deploy) added an explicit
  `{ "source": "/" }` rule for `za-shm.vercel.app` before the catch-all.
  Deployment `dpl_9DfBJfoD3hWqFpukeCGEL9R6BsnQ`
  (`https://zashm-d8e3ip8v1-zashm.vercel.app`) is READY and now owns the public
  alias `za-shm.vercel.app`. The two SSO-gated production aliases remain on the
  original deployment; no customer traffic used them.
- `node scripts/test-vercel-cloudflare-redirect.mjs --expect-redirect` →
  **21 passed / 0 failed** after the review tightened the script: the 307 and
  exact `Location` (path **and** query) are asserted for the **public alias
  only** over `/`, `/?probe=123`, `/shop?sort=newest`,
  `/product/1?utm=preflight`, `/cart?x=1`, `/checkout`, `/admin` and
  `/track?track=…&tk=…`. The two SSO-gated aliases are checked separately for
  their unchanged SSO challenge, not counted as redirect passes. Raw headers
  confirmed `Location: https://zashm.za-shm.workers.dev/?probe=123` and the
  full tracking query. `OPTIONS`/`POST` from the old Vercel Origin are
  fail-closed (no CORS grant, 403 before any handler); the Cloudflare Origin
  gets the exact CORS grant. Previews still answer 302 to `vercel.com/sso-api`.
  No order was created and no customer/order row was read or written. An
  explicit mode flag is now required; `--preflight` is the pre-cutover baseline
  and correctly fails 2 assertions now that the redirect is live.
- Cookie/localStorage impact is unchanged from the handoff record: session and
  CSRF cookies are host-only, and cart/wishlist live in origin-scoped browser
  storage, so admins re-login on Cloudflare and an existing Vercel bag must be
  rebuilt. Tracking tokens travel in the URL, so they survive the redirect.
- **Operational constraints (not changed in this review):** the explicit `/`
  rule is scoped to `za-shm.vercel.app` as approved. The two SSO aliases must
  **not** be re-pointed to `dpl_9Df…`, because Vercel's `/:path*` does not match
  the empty path and their root would then serve the SPA instead of a 307.
  Their catch-all rules in `vercel.json` are currently inert while they remain
  on `dpl_C38…`. Host patterns are dot-escaped but unanchored; anchoring them
  would require another Production deploy, which was not approved. Vercel's
  bodyless 307 responses do not carry the Cloudflare CSP/robots headers; the
  destination response does, and was verified.
- Rollback remains `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC`; the executable alias
  commands are in the **Rollback** section below. No Cloudflare, Supabase, DNS,
  secret, SSO or deployment-deletion change was made.

## Storefront performance release (2026-11-25, owner-approved)

Owner approval covered deployment and post-deploy verification only. The
working tree commit `5f62e15c36dae70db3ba5800a548c398cf6f6a1b`
(`perf: stabilise shop LCP and product CLS on cold loads`) was built locally
from the real Production origin/anon key into `build-production/` and deployed
directly to Worker `zashm`; **no push, Vercel, DNS, Supabase, secret or data
change was made**.

- Artifact: `index-DgN9MCIU.js` + `index-C5S0Kll9.css`; dry-run read 46 files
  (1164.36 KiB / 213.02 KiB gzip) with only `ASSETS` and the seven reviewed
  non-secret vars. A 39-file scan found one JWT with `role=anon` and no
  Staging/Vercel/placeholder reference, service-role value, session secret,
  Telegram or Upstash token.
- Deployment: version `1ead16fb-85c8-440c-8672-babbca38101a`, deployment
  `8968cc7e-dd47-4f6d-bf38-98aed61aef9b`, created
  `2026-11-25T02:01:34.771263Z`, tag `perf-5f62e15`, 100% traffic. Eight secret
  names are unchanged. The previous hardened version
  `2d53453a-689b-441a-9e9e-5289c8988cd6` / deployment
  `fc618b23-3244-4d8f-8e70-46ce4b2234ff` remains retained as the immediate
  rollback target.
- Pre-deploy gates: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 39 suites / 4263
  passed / 0 failed (SQL 495 / 0, actually run); `npm run build` passed;
  `npm run verify:production:config` → `READY: 0 problem(s)`; `git diff --check`
  clean; final read-only review found no Blocker/High/Medium defect.
- Live GET-only smoke: `/`, `/shop`, `/product/1795385879888720`, `/cart`,
  `/checkout`, `/track`, `/admin`, `/sitemap.xml` and `/robots.txt` all 200
  with CSP and `noindex, nofollow, noarchive`; `/no-such-page-a0` stayed 404.
  Canonicals use `https://zashm.za-shm.workers.dev`, the new bundle hash is
  present and the old `index-B4VjJ2E2.js` is gone.
- Live CORS: the canonical Origin gets `access-control-allow-origin`,
  `access-control-allow-credentials: true` and `Vary: Origin`; the retired
  Vercel Origin and `https://evil.example` get no CORS grant. Browser console
  errors were 0 on `/shop`, a real product, `/cart` and `/checkout`; `/shop`
  serves the first row as `eager/high` and later cards as `lazy/low`.
- Post-deploy Lighthouse 13.6 (`simulate`) was variable across runs. Mobile
  `/shop`: score 0.62–0.86, LCP 6684–3627 ms, CLS 0. Real product: score
  0.82–0.83, CLS 0, LCP 4105–4533 ms. `/cart`: score 0.85–0.92, CLS 0.
  `/checkout`: score 0.74, CLS 0. Desktop `/shop`: score 0.56–0.61, CLS
  ~0.0015. No field RUM was collected; the owner accepted lab-only evidence
  and the remaining LCP/TTFB variance.
- Rollback: redeploy version `2d53453a-…` / deployment `fc618b23-…` (keeps the
  `ALLOWED_ORIGINS` hardening), or the older `f06cfd8e-…` /
  `79e44e77-…` if a full pre-hardening rollback is required. Git-local
  rollback is `git revert --no-edit 5f62e15`. No database rollback is needed.

## Cloudflare Images image-proxy release (2026-11-25, owner-approved)

Owner approval covered implementing, deploying, committing and pushing the image
proxy. The deployed Worker matches commit
`1257cc1ffcf89210e6d3713c2fdef0fbcf66dc61` on `origin/cloudflare-migration`;
the commit/push happened after deployment. No Vercel alias/deployment, DNS,
custom domain, Supabase setting/metadata, secret or product/order/coupon/data
write was made. The original photos remain in Supabase Storage.

- Design: same-origin `/img/v1/w160|w480|w1200/<base64url key>` requests; the
  Worker builds the origin URL only from `VITE_SUPABASE_URL` and a key restricted
  to `products/`, applies `cf.image`, negotiates one concrete format (AVIF, WebP
  or JPEG), caches it in the Cloudflare Cache API under a format-specific key,
  and returns `Cache-Control: public, max-age=31536000, immutable`. The browser
  falls back to the original Supabase URL and then the `/media` mirror path
  (currently empty until the snapshot sync is enabled); OG/Twitter/JSON-LD still
  advertise the original Supabase asset.
- Artifact: production rebuild used the same real origin/public anon key as the
  deployed bundle, produced `index-B1fOZKAP.js` + `index-C5S0Kll9.css`, and the
  final dry run read 46 files (1170.66 KiB / 214.68 KiB gzip). A 39-file scan found one
  `anon` JWT, zero Staging/placeholder references and zero forbidden secrets;
  the two `vercel-scripts.com` matches are CSP entries only.
- Gates: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 40 suites / 4373 passed / 0 failed
  (SQL 495 / 0, actually run); `npm run build` passed;
  `npm run verify:production:config` → `READY: 0 problem(s)`; `git diff --check`
  clean. A read-only review found four issues (format negotiation cached under
  a URL-only key, `Range` poisoning, original fallback cached as immutable and
  HEAD cache-hit body); all were fixed with regression tests before the first
  deploy. A final review found two Low issues (`Accept` q-values ignored and docs
  overstating the empty `/media` mirror); both were fixed before the final
  redeploy.
- Deployment: Worker `zashm` final version
  `698ec41c-3698-4db8-9793-911eeab4d906`, deployment
  `11086225-df23-4546-8e9d-bee810de3e3d`, created
  `2026-11-25T03:15:59.784239Z`, 100% traffic (deploy command included
  `--tag image-proxy-qvalue-20261125`). The earlier image-proxy version
  `ad093362-6c7b-41b8-9e40-b6102b25fb00` / deployment
  `96a1be4f-ff2c-4f04-b763-557ebe70185a` is retained as an intermediate rollback
  target. The eight secret names are unchanged.
- Live GET-only smoke: the nine page/sitemap/robots routes stayed 200 with CSP
  and `noindex, nofollow, noarchive`; the unknown route stayed 404. A real
  `w1200` image returned AVIF `60153` bytes (sample Supabase original: `120634`
  bytes), `x-zashm-image: transformed` then `hit` on repeat, distinct AVIF/WebP/
  JPEG variants, and a query-buster still hit the same cache entry. `w480` and
  `w160` returned `24579` and `3176` AVIF bytes. After the final redeploy,
  `Accept: image/avif;q=0,image/webp` returned WebP and
  `image/avif;q=0,image/webp;q=0,*/*;q=1` returned JPEG. Invalid key → 404,
  POST → 405.
- Browser smoke: `/shop` cards request `/img/v1/`, expose 480w/1200w `srcSet`,
  and made zero direct Supabase Storage image requests; product hero and zoom
  use `w1200`, thumbnails/bag/cart/checkout use `w160`, and console errors were
  0 on shop, product, cart, checkout and track. Lighthouse emitted
  accessibility/best-practices/SEO 1/1/1 with no failures; the harness did not
  emit a performance category, so no new LCP/field-CWV claim is made.
- Rollback: redeploy the intermediate image-proxy version
  `ad093362-6c7b-41b8-9e40-b6102b25fb00` / deployment
  `96a1be4f-ff2c-4f04-b763-557ebe70185a`, the perf version
  `1ead16fb-85c8-440c-8672-babbca38101a` /
  `8968cc7e-dd47-4f6d-bf38-98aed61aef9b`, or the retained hardened version
  `2d53453a-689b-441a-9e9e-5289c8988cd6` /
  `fc618b23-3244-4d8f-8e70-46ce4b2234ff`. No database rollback is needed.
  Git-local rollback is
  `git revert --no-edit 1257cc1ffcf89210e6d3713c2fdef0fbcf66dc61`. Supabase
  object `cache-control` metadata was deliberately not changed.

## Owner final checks (2026-11-25)

The live Worker and Vercel 307 bridge were not changed by these checks. The
remaining launch caveats and the exact owner-side steps are recorded in
`docs/final-launch-checks-2026-11-25.md`:

- SQL verification was run by the owner in the Supabase SQL Editor using
  `supabase/verify_production_security.sql` plus Extra A–D in
  `docs/final-launch-checks-2026-11-25.md` §1.4; all verdicts were `PASS` and the
  owner confirmed the counts are expected. Only read-only REST probes were
  possible from this environment.
- Owner real-device checks remain. A temporary local read-only proxy to the live
  Worker did produce a 320/375/768/1440 CSS-px layout matrix (all routes had
  `scrollWidth == innerWidth`, 0 console errors, 0 direct Supabase images, and
  correct WhatsApp/nav behaviour); see
  `docs/final-launch-checks-2026-11-25.md` §2.3. That is not iOS Safari/Android
  Chrome or field CWV. Lab trace showed 0 long tasks, 2 cached AVIF proxy image
  hits and 0 direct Supabase image requests on live `/shop`.
- A final shop-card label refinement was made locally only: the outside badge
  is flush above the photo, keeps the product-page pill but a shade smaller; the
  product page label is unchanged. It is uncommitted and **not** on the Worker
  (see `docs/final-launch-checks-2026-11-25.md` §2.4). No commit, push or deploy
  was made here.
- With no card available, the canonical origin remains
  `https://zashm.za-shm.workers.dev` with `noindex`. No custom domain, DNS,
  Vercel alias or `noindex` change was made.

## Rollback

- Keep Vercel deployment `dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC` and its alias.
- Immediate alias restoration (read-only verification after each command;
  this was executed once after the failed attempt 1 and must **not** be run
  again unless the owner explicitly approves a rollback):

  ```bash
  vercel alias set dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC za-shm.vercel.app
  vercel alias set dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC zashm-zashm.vercel.app
  vercel alias set dpl_C38pB3xWTz7RQaBq8YFGF3Kt5dBC zashm-git-main-zashm.vercel.app
  ```

  Then `curl -I https://za-shm.vercel.app/` must return **200** from the old
  storefront with no `Location` to Cloudflare. No database rollback is needed.
- Do not point the custom domain at Cloudflare until after full verification.
- If Cloudflare is cut over and must be reverted, change DNS back to the Vercel
  alias; no database rollback is needed because no SQL was changed.
- Never weaken RLS, CSRF, CORS or origin checks to make a migration pass.
