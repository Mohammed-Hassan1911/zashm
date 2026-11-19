# ZASHM — Security rollout & production checklist

This file documents the items that **cannot be fixed from the repository alone**
(they need a Supabase/Vercel dashboard action or an explicit schema decision).
This file is guidance only; it does not apply anything by itself. Every
migration and Dashboard change below is a manual action. The production status
is recorded in §0 and must be re-verified, never assumed.

Last updated: 2026-11-19

---

## 0. Production state (verified 2026-11-19)

Project ref `ptegprcbtfylqhbnbkih`. The audit probes used the service-role key
and the public anon key for read-only checks (PostgREST `OPTIONS` on RPCs, `peek`
on the rate limiter, `select` on rows). No SQL was applied. The only production
data change in this pass was the owner-approved, reversible deactivation of four
test products recorded below.

Applied and confirmed by behaviour:

- **Order RPCs exist** — `OPTIONS /rest/v1/rpc/<fn>` returned `200` for
  `atomic_place_order`, `atomic_set_order_status`, `atomic_delete_order`,
  `atomic_edit_order`, `zshm_adjust_coupon_usage` and
  `zshm_restore_storage_policies`, so migrations #1–#3 and the coupon/storage
  helpers are installed.
- **Durable rate limiting** — `zshm_rate_limit(..., 'peek')` returned
  `{"count":0,"allowed":true,"remaining":10,"resetIn":0}`, so
  `rate_limit_storage.sql` is applied. With no Upstash variables in Vercel the
  database RPC *is* the shared limiter, not the per-instance fallback.
- **Session revocation** — `users.session_version` exists (values `19` and `1`
  for the two admins), so `session_revocation.sql` is applied and logout can
  invalidate a copied cookie.
- **Browser isolation** — anon `GET /rest/v1/products` → `401` (`42501`),
  anon `GET /rest/v1/orders` → `401`, anon `GET /rest/v1/products_public` →
  `200`. The `products_public` rollout and the `orders` lockdown are live.
- **Public signups closed** — `GET /auth/v1/settings` reports
  `disable_signup: true` (the first item of §3).
- **Stock invariant** — recorded before deactivation: `T-SHIRT` stock `27` =
  variant sum `27`, `Pant` stock `24` = variant sum `24`, and `reservedStock`
  is `0` on both.

Current data baseline (2026-11-19):

- anon `GET /rest/v1/products_public?select=id` now returns **0** ids. The four
  previously visible ids — `1794943849613141`, `1794955384475152`,
  `1795094753892375`, `1795095084457224` — were confirmed by the owner to be
  **test data**. They were deactivated with a service-role REST
  `PATCH active=false` after a backup of the four rows was captured locally;
  the change is reversible with `PATCH active=true`. No rows were deleted and no
  prices or stock values were rewritten.
- Orders, users, coupons and admin identities could **not** be live-counted from
  this environment (no Management token / DB connection string). The earlier
  baseline — orders `1`, users `2`, coupons `1`, order
  `ZSH-MWLGRZ7M-EC96FF20`, coupon `ZAMALEK`, admins `mohammed` and `ahmed` — is
  historical, not a 2026-11-19 live count.

Production https://za-shm.vercel.app serves the bundle built from `03b055f`
(`index-wOn8XH1_.js` and `index-CP2InU7q.css`), first deployed as
`zashm-cj604d2l1-zashm.vercel.app` (Ready/Production, 2026-11-20). Aliases:
`za-shm.vercel.app`, `zashm-zashm.vercel.app`,
`zashm-git-main-zashm.vercel.app`. Later docs-only pushes (starting with
`b66e03a`) trigger Vercel rebuilds with byte-identical output, so they do not
change the served assets.

Live verification at `03b055f`:

- `/shop` static metadata, canonical, OG/Twitter tags and `<noscript>` shell.
- `/prerendered-products.json` → 200 with `{"ids":[]}`.
- `/sitemap.xml` → two URLs only (home + `/shop`), `application/xml`,
  `s-maxage=3600`.
- `/admin`, `/cart`, `/checkout`, `/wishlist`, `/track` →
  `noindex, nofollow, noarchive`; an unknown route → real 404.
- security headers (CSP, HSTS, nosniff, `DENY`, referrer policy) intact; the live
  JS bundle has no service-role/session/Telegram/Upstash secret markers.
- `/og-image.jpg` → `public, max-age=0, s-maxage=86400,
  stale-while-revalidate=604800`.
- unauthenticated `GET /api/admin/orders` and `/api/admin/users` → `401`.
- a deactivated test product URL serves the generic SPA title with no stale
  Product JSON-LD.

An explicit `vercel --prod --yes` attempt returned `Not authorized` from the
CLI; the push to `main` auto-deployed the same commit successfully, and the live
checks above were performed against that production deployment. No second manual
deploy was attempted.

The previous release `a62069f` (`zashm-m7lv14t0k-zashm.vercel.app`,
2026-11-19) served `index-vIyADBiI.js` / `index-CREmyxBi.css` with the four then
test products in the sitemap; `ZSHM_REQUIRE_SQL_TESTS=1 npm test` passed 30
suites / 3395 assertions with 0 failures and the SQL suite really ran (490
passed). A 28-case 320/390/768/1440px browser sweep and computed-style checks
were performed at the earlier `7a0f3e6` build and are historical; they were not
repeated at `a62069f` or `03b055f`.

Safe PII verification: unauthenticated `GET /api/admin/orders` and
`GET /api/admin/users` both returned `401`, and the deployed bundle hash matched
the local build containing the 252-assertion limiter regression suite. No
121-request probe was run against production because a valid admin session was
not available.

All code-side Low work is now deployed: reduced-motion gallery, deferred hover
image fetch, route-scoped idle preload, refreshable `/og-image.jpg` cache,
validated `x-real-ip`, fail-closed Origin on unsafe methods, sanitised server
error logs, signed-token cleanup on the tracking page, minimal `?wa=1` prefill,
and immutable cache headers on new Storage uploads.

Final local proof for this tree: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 30
suites / 3450 assertions, 0 failures; the SQL suite really ran (490 passed on
temporary PostgreSQL 17). `npm run build` → `index-wOn8XH1_.js` +
`index-CP2InU7q.css`, shop shell written, an empty
`build/prerendered-products.json` published from a successful live
`products_public` read, and a clean secret scan. One earlier local build hit a
transient `fetch failed` and deliberately published no manifest; the re-run
succeeded, and the sitemap's fail-closed fallback is unchanged.

Until real products are added, the catalogue is intentionally empty and the
store is **not** ready for sale.

The previous release (`258d410`, deployment `zashm-hd57gi651-zashm.vercel.app`,
2026-11-19) verified instant product navigation with `scrollY=0`, the engraved
gold search field, the full-width phone sort, the composited finger-follow
gallery, the opacity-only size-guide exit, and the unified checkout CTAs. The one
before that (`662c96b`, deployment `zashm-oa1bk3ye8`, 2026-11-19)
verified the 136px phone sort control at 390px (32px height, 9.5px font), the
static metal gradient with a transform-only hover sweep on product names,
WhatsApp on home only (absent while the bag is open), the bag scrim with no
backdrop blur, and a stacked-frame photo crossfade on swipe. Those were
historical checks; the current gallery, sort and receipt rules are covered by the
new suite. An earlier release (`20f7bb7`, deployment
`zashm-fkh9b0dq7`, 2026-11-19) verified the 343px side drawer with a visible
storefront strip, checkout's single Cash-on-Delivery row with no badge or
"Available" copy, the 320px brand-font tracking page, the centred receipt meta
with one-line "Cash on delivery", rose discounts, the vertical phone timeline,
`/api/errors` GET → 405 and POST `{}` → 400, and an unknown path → 404.

**Not verifiable from this environment** (no Management token / DB connection
string), so these remain assumptions until checked in the dashboard:

- function attributes (`SECURITY DEFINER` vs `INVOKER`, pinned `search_path`,
  execute grants beyond what PostgREST exposes);
- RLS policies, storage policies, and column-level grants on the base tables;
- the last-admin trigger and the `atomic_*` internals;
- admin MFA (not offered by the custom login — see §3).

The 2026-11-07 record below is **historical and superseded**; its row counts
(orders 15, products 1) no longer match production.

> 2026-11-07: migrations #1, #2, #4, #5, #6, #7 plus `coupons_lockdown.sql`,
> `session_revocation.sql`, `rate_limit_storage.sql` and
> `stock_hardening_constraints.sql` were recorded as applied; migration #3 was
> applied and smoke-tested (`atomic_edit_order('ZSH-DOES-NOT-EXIST', 0, '{}')`
> → `{"ok": false, "reason": "not_found"}`).

---

## 1. Migrations awaiting approval (apply in this order)

Run each file in the Supabase SQL Editor, one at a time, after reviewing it.
They are idempotent where possible and none of them delete rows.

| # | File | What it changes |
|---|------|-----------------|
| 1 | `supabase/atomic_place_order.sql` (Revision 8) | Replaces order placement RPC: aggregates demand (per variant for variant products, per product for products without variants), ignores unused `reservedStock`, keeps `stock = sum(variantStock)`, increments coupon usage only after a successful INSERT, rejects inactive products/changed coupons, safely parses JSON, and compares cart signatures for idempotent retries. |
| 2 | `supabase/atomic_order_lifecycle.sql` | Adds `atomic_set_order_status` / `atomic_delete_order` (status changes + stock/coupon restore inside one transaction), legacy-safe item parsers, partial restore for missing products/variants, and the strict `zshm_adjust_coupon_usage` helper. Apply after #1 because it calls `atomic_adjust_stock`. |
| 3 | `supabase/atomic_edit_order.sql` | Adds `atomic_edit_order` (customer/items/coupon correction inside one transaction; lock order `orders` → `products` → `coupons`, optimistic revision in `timestamps.rev`, net stock reconciliation, coupon revalidation and usage move). Items are editable only in Pending/Confirmed; customer details stay editable in every status. Apply after #2 because it uses `atomic_adjust_stock` and the lifecycle helpers. |
| 4 | `supabase/admin_protection.sql` | Trigger that refuses to demote/delete the last admin (transaction advisory lock; covered by a real two-connection test). |
| 5 | `supabase/security_hardening.sql` | Function `search_path` pinning / privilege revokes; inspects every existing `auth.users` trigger and refuses to add a second provisioning trigger. It never drops/replaces an existing trigger and no longer defines a duplicate last-admin function. |
| 6 | `supabase/storage_hardening.sql` | `products` bucket: 5 MB limit, image MIME allow-list, RLS, and a restrictive policy preventing browser roles from listing product filenames while retaining public image downloads. Drops only policies provably scoped to `products`; blanket/other-bucket policies are kept for manual review. If the SQL role does not own `storage.objects` (normal in Supabase), it never runs `ALTER TABLE`/`DROP POLICY`; it reports the exact products-only policies for removal in **Dashboard > Storage > Policies**. Every policy dropped by the script is backed up verbatim and restorable with `zshm_restore_storage_policies()`. |
| 7 | `supabase/products_public_view.sql` | Creates `products_public` with `WHERE active IS TRUE` (inactive/NULL products never reach the public API) from an explicit public-column allow-list (`id, name, category, price, salePrice, description, stock, variantStock, sku, label, colors, sizes, images, image, sizeGuide, rating, reviews`; `reservedStock` is not in it, and `active/tags` are not selected). `rating`/`reviews` hold aggregates of approved reviews and are rendered by the product cards, so a Phase 1 re-run keeps them. Grants SELECT on the view, and after the staged rollout flag revokes the base table (table-level and column-level) from `PUBLIC`/`anon`/`authenticated`. |

Two further files are required but are **not** counted in the seven above:

- `supabase/coupons_lockdown.sql` — run only after the server-only coupon code
  is deployed, following its own SECTION 0 → 1 → 2 procedure.
- `supabase/session_revocation.sql` — adds `users.session_version`; safe to run
  before or after deployment because both sides default to `0` until applied.
  Once applied, logout also bumps the current user's `session_version`, so a
  copied cookie stops working immediately (all of that user's sessions are
  revoked). Without the migration, logout only clears cookies and a stolen
  cookie can live up to the 4-hour token TTL.
- `supabase/rate_limit_storage.sql` — optional shared Supabase RPC fallback for
  rate limiting when Upstash is absent or unavailable. Apply and verify it
  before relying on database-backed limits. Without this migration and a
  healthy Upstash instance, limits are per warm serverless instance.

### Product reviews (applied & deployed 2026-11-07)

**Status:** applied to production project `ptegprcbtfylqhbnbkih` and deployed
in commit `6b7f339` (production deployment `dpl_FtVeud6W7KgXRsQ3LL7FE3wBNJY9`,
alias `https://za-shm.vercel.app`). Verified with the anon key that
`products_public` exposes `rating`/`reviews`, still hides `reservedStock`
(a 400 when requested), `product_reviews` is service-role only (RLS on, no
`anon`/`authenticated` grants), the sync trigger exists, and
`GET /api/reviews?productId=1793846979234526` returns
`{"summary":{"average":0,"count":0},"reviews":[]}`. Row counts were unchanged
by the migration (orders 17, products 1, users 2, coupons 1; no review rows).

`supabase/product_reviews.sql` adds `public.product_reviews` (service-role
only), the trigger that keeps `products.rating` / `products.reviews` in sync
with **approved** reviews, and re-creates `products_public` with `rating` and
`reviews` appended to the same allow-list. It must be applied **before**
deploying `api/reviews.js`, the storefront review section, or the admin Reviews
tab; otherwise those requests fail. The file keeps the owner-rights view
(`security_invoker = false, security_barrier = true`), grants SELECT on the
view only, and never deletes or rewrites an existing review. No review exists
in production until one is submitted after deployment, and submissions start
`pending` until an admin approves them.

### Review photos (applied 2026-11-16)

`supabase/product_review_photos.sql` adds the optional
`public.product_reviews."photoPath"` text column and a fail-closed length /
path CHECK. Only the short object path is stored; the image bytes live in the
existing public `products` bucket under `reviews/<productId>/<24 hex>.<ext>`.
No new bucket, no browser Storage policy: `api/reviews.js` writes with the
service-role key, and the public API returns a URL only for **approved**
reviews.

**Applied 2026-11-16** (project `ptegprcbtfylqhbnbkih`) with
`supabase db query --linked --file supabase/product_review_photos.sql` after
`product_reviews.sql`. Verified afterwards: a service-role
`select=id,"photoPath"` returns the existing rows with `photoPath: null`, and
`pg_constraint` shows `product_reviews_photo_path_len` with the expected
NULL / 10–300 chars / no leading `/` / no `..` definition. The migration is
idempotent (`ADD COLUMN IF NOT EXISTS` + guarded constraint) and never
modifies an existing row. Rollback drops the column and forgets the paths; the
files stay in the bucket and can be deleted manually.

The deployed code stays safe if the column is ever missing: the API probes it
and answers `photosEnabled: false`, so the form keeps working without the
picker and a submission that still carries a photo saves the review without it
(`photoSaved: false`). A cached "no" is re-probed after 60 s, so a warm
instance picks the column up shortly after a late migration instead of waiting
for a cold start; transient probe failures are never cached.

### Product size windows (applied 2026-11-13)

`supabase/product_size_ranges.sql` adds
`public.products."sizeRanges" jsonb NOT NULL DEFAULT '{}'` and re-creates
`products_public` with `sizeRanges` added to the allow-list. The storefront
"Find my size" tool uses these owner-defined per-size height/weight windows;
without the column the tool falls back to the published chest chart and the
admin save reports `warnings.sizeRanges = 'column-missing'` instead of
pretending the windows were stored.

Apply it **after** `products_public_view.sql` and `product_reviews.sql`. Both
of those files now build the view from the intersection of their allow-list and
the columns that actually exist, so re-running either one after this migration
keeps `sizeRanges`; re-running it before simply omits the column until it is
added. The migration is idempotent (quoted constraint name, `IF NOT EXISTS`)
and fails closed if `reservedStock` ever enters the allow-list. Its rollback
block drops the column and therefore **permanently deletes every owner-entered
window** — take a backup first.

**Applied 2026-11-13** (project `ptegprcbtfylqhbnbkih`, session role `postgres`,
no dependants on the view). Verified after applying:

- `products."sizeRanges"` is `jsonb`, `NOT NULL`, default `'{}'::jsonb`;
  constraint `products_sizeRanges_object_chk` exists; all 3 existing products
  were backfilled with `{}`.
- `products_public` exposes `sizeRanges` and still hides `reservedStock`;
  `anon` can SELECT the view and cannot SELECT `products`.
- PostgREST read paths return the column (anon view `200`, service-role table
  `200`), so the schema cache was reloaded.
- A `BEGIN; UPDATE … sizeRanges …; ROLLBACK;` round-trip on the T-Shirt row
  wrote and read back the window and left the row as `{}`, proving the write
  path before the owner re-saved from the admin.

Pre-apply state (view definition, grants, columns, product ids, counts) is in
`backups/2026-11-13T11-07-36Z-size-ranges-pre-apply/`.

Deploy the updated frontend and `/api/orders` together: the API now requires
the frontend's persistent idempotency key. Verify the atomic order-placement
migration is applied before accepting production orders.

After #7, verify with an **anon** key (not the service role):

- `GET /rest/v1/products_public` → rows, **no** `reservedStock` column.
- `GET /rest/v1/products?select=reservedStock` → 401/403.
- Storefront product list, cart, checkout and order tracking still work.
- Admin product create/edit still work (service role).
- **Admin product listing was fixed in the repository (H-01/F-01):** the console
  now calls the authenticated `GET /api/admin/products` (service role,
  `products.read`) and keeps full rows, including inactive products and `tags`.
  It no longer reads the public view, so editing a product cannot clear `tags`.
  This must be deployed **before** Phase 3. Verify by opening Products in the
  admin console: deactivated products are visible with an `INACTIVE` badge, and
  saving an edit preserves its tags.

**Rollout order for #6 (enforced by the file, not just documented):** the first
run creates the view, grants SELECT on it and **skips Phase 3** (the base-table
revoke) because `public.zshm_deploy_flags` does not yet contain
`products_public_frontend_live`. The old storefront keeps reading `products`
during this phase. Deploy the frontend that reads `products_public`, then record
the flag and re-run the same file:

```sql
INSERT INTO public.zshm_deploy_flags (name, note)
VALUES ('products_public_frontend_live', 'new bundle deployed')
ON CONFLICT (name) DO NOTHING;
```

The re-run revokes the base table from `PUBLIC`, `anon` and `authenticated`
(table-level and column-level) and verifies all three with
`has_table_privilege()` plus a column-ACL check. This prevents applying the file
"all at once" from breaking the old bundle before the new one is live, and stops
a lingering column grant from re-exposing `reservedStock`. Phase 3 also aborts
if the view is missing, unreadable by `anon`, still exposes `reservedStock`, or
returns a different row set than `products WHERE active IS TRUE`.

Run `supabase/verify_production_security.sql` (read-only) after each phase and
compare its output with `docs/production-remediation-handoff.md §5`.

Rollback for #6 is at the bottom of the file. If you roll it back, also revert
`src/store.js` and `src/lib/security.js` to `from('products')`.

---

## 2. SEC-24 — `reservedStock` is intentionally unused

**Local status: fixed and covered by tests. Production status: not verified.**

The storefront and order API do not subtract `reservedStock`; availability is
based on `stock` or the selected `variantStock` entry. Nothing writes or expires
reservations, so adding a reservation lifecycle would be a separate product
decision. Keep the legacy column for compatibility and do not add a writer.
`supabase/atomic_place_order.sql` Revision 8 must be applied and verified on
Production before relying on this behavior there. A read-only probe on
2026-11-19 confirmed the function exists and is callable by `service_role`; its
deployed revision body still cannot be confirmed without database access. COD
orders deduct real stock atomically at placement; no inventory is held until
delivery.

---

## 3. SEC-28 — Supabase Auth / dashboard settings (manual)

**Status: not applied — requires dashboard access (no Management API token in
this environment).**

The store uses its own `users` table + scrypt passwords for admin/staff, so
Supabase Auth is not the login path. Still, any public signup surface should be
closed:

1. **Authentication → Providers → Email**
   - Disable "Enable sign ups" (public registration).
   - Require email confirmation (`mailer_autoconfirm = false`) if email auth is
     ever enabled.
2. **Authentication → URL Configuration**
   - Site URL: the production storefront origin.
   - Redirect allow-list: only that origin (no wildcards).
3. **Authentication → Policies / MFA**
   - Enable MFA (TOTP) for the admin account, or require it via your plan.
4. **Passwords**
   - Minimum length 12, leaked-password protection on (if available).
5. **API keys**
   - Confirm the `service_role` key is only in server-side environment
     variables (Vercel), never in `VITE_*` / `REACT_APP_*` variables.

Verification: an unauthenticated `POST /auth/v1/signup` must be rejected once
signups are disabled (it may still return 200 on some plans; check the Auth logs
for "signup disabled").

---

## 4. Production environment variables (Vercel)

Set these in **Project → Settings → Environment Variables** for Production and
Preview as appropriate. Values are not stored in the repo.

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | yes | Project URL (server). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only DB access. Never expose to the browser. |
| `SESSION_SECRET` | yes | HMAC key for sessions **and tracking links**. Changing it invalidates existing tracking links and sessions. |
| `ALLOWED_ORIGINS` | recommended | Comma-separated exact origins allowed for CORS/CSRF. Example: `https://<your-domain>` (plus a preview domain only if you need it). |
| `PUBLIC_BASE_URL` | recommended | Origin used in tracking links. Example: `https://<your-domain>`. |
| `UPSTASH_REDIS_REST_URL` | optional | Enables the shared/durable rate limiter. |
| `UPSTASH_REDIS_REST_TOKEN` | optional | Token for the above. |
| `TRACKING_TOKEN_TTL_HOURS` | optional | Unset/empty = new tracking links expire after 720 hours (30 days). A positive number overrides that lifetime. Previously issued legacy links remain valid; rotating `SESSION_SECRET` invalidates all links. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | Order notifications. |

Upstash is the primary shared limiter when configured. The database RPC migration
is used when Upstash is absent or unavailable. If neither shared provider is
available, the bounded limiter is only per warm serverless instance.

**Current production state (verified 2026-11-19):** no Upstash variables are set,
so `zshm_rate_limit` is the active shared limiter. That is durable and correct,
but every login / coupon / error request pays a database round-trip, and under
sustained abuse the database becomes the bottleneck. Adding Upstash is a
performance improvement, not an open security hole.

**Exact Upstash setup (manual, not performed):**

1. Create a free Upstash Redis database in the same region as the Vercel
   functions.
2. Copy its **REST URL** and **REST token** (not the `redis://` URL).
3. In Vercel: Project → Settings → Environment Variables → add both variables
   for **Production** and **Preview**, then redeploy.
4. Verify no `VITE_`/`REACT_APP_` copy exists (it would ship to the browser).
5. Apply `supabase/rate_limit_storage.sql` before relying on its database
   fallback. Check Vercel logs for `Shared rate limit unavailable` and confirm
   neither shared provider is failing; that warning means limits have degraded
   to per-instance counters.

Verification: log in as admin, open an order, copy its tracking link, and check
that the link host matches `PUBLIC_BASE_URL`. Send a request with a foreign
`Origin` header to `/api/admin/users` — it must return 403.

---

## 4b. Outage resilience — snapshot, same-origin image mirror, WhatsApp fallback

**Status (2026-11-07): implemented, committed (ae6deea), pushed, and deployed to
production (https://za-shm.vercel.app serves /assets/index-HD5wpGoL.css and
the empty backup at /catalog-snapshot.json).** No external account, credential,
credit card, or environment variable is involved.

Goal: if Supabase (or its Storage) is unreachable, ZASHM keeps looking like a
store instead of an empty error page, and a customer can still place an order on
WhatsApp.

| Layer | Behaviour |
|---|---|
| Catalogue | `src/store.js` reads `products_public` first. On network/5xx/empty failure it serves `public/catalog-snapshot.json` (same origin, real public columns only), sets `productsSource: 'snapshot'`, and shows a non-blocking banner. If the snapshot is also missing it keeps the persisted copies already in `localStorage`. |
| Images | `SafeImage` / `useImageFallback` try the live Supabase Storage URL, then the committed copy under `/media/<bucket path>`, then the neutral placeholder. Non-Supabase URLs and `..` paths are never mirrored. Vercel serves `/media/*` with `Cache-Control: public, max-age=31536000, immutable` (upload names are random and never overwritten). |
| Ordering | `/api/orders` still runs only against the DB. When a placement fails with status `0`, `408` or `≥500`, checkout shows a bilingual WhatsApp hand-off prefilled with the bag (name, size, colour, qty, estimated total). Validation errors (`400`/`409`) do **not** offer it. |
| Floating actions | The banner is inline and the WhatsApp CTA is a normal link; the always-visible WhatsApp FAB and scroll-to-top keep their `z-index: 30000` behaviour. |

**Routine after catalogue or image changes (manual, no credentials):**

```bash
npm run resilience:dry -- --skip-images   # plan the snapshot only
npm run resilience:sync -- --skip-images  # rewrite public/catalog-snapshot.json
npm run resilience:dry                    # plan snapshot + image mirror
npm run resilience:dry -- --prune         # plan snapshot + image mirror + deletions
npm run resilience:sync -- --prune        # apply, deleting unreferenced images
```

The snapshot and the mirrored images are committed with the site, so they must
be regenerated and reviewed before a release that changes the catalogue. The
script refuses any single image above **1.5MB** (`MIRROR_MAX_FILE_MB`), removes
a stale copy of an oversized file, and exits non-zero so the release is blocked
until the image is compressed or the limit is deliberately raised. It also
refuses to grow the whole mirror past **200MB** (override with `MIRROR_MAX_MB`
only after reviewing the repository size). `--best-effort` exists for build
hooks but a release run should fail loudly.

**Removing a product (and reclaiming its mirror space):**

- **Deleted in Supabase:** nothing else to do. `npm run resilience:sync` drops it
  from the snapshot automatically and reports its orphaned images; add `--prune`
  to delete them from `public/media`.
- **Still live but must stay out of the backup** (temporary/test row, or a
  product not meant to be browsable offline): add its id to
  `scripts/resilience-exclude.json` under `excludedIds`, then run
  `npm run resilience:sync -- --prune`. The row in Supabase is never modified.
- Pruning deletes only files inside `public/media/products/` that no snapshot
  product references (and removes the empty folders). A dry run lists them
  first. The script refuses to prune when `products_public` itself returns zero
  rows (possible revoked grant/RLS regression); `--force-prune` overrides that
  only after confirming the empty catalogue is intended.

**Current state:** the only live row is the temporary/test product
`1793846979234526`, so it is listed in `scripts/resilience-exclude.json` and the
shipped backup is intentionally empty (`count: 0`, no mirrored images) until a
real product is published. Repeat visitors still get their persisted catalogue
from `localStorage` during an outage; the banner and WhatsApp hand-off still
appear.

**Verification:**

- Snapshot + image path: run Vite with an invalid `VITE_SUPABASE_URL`; the
  homepage must render the catalogue, show the backup banner, and load the real
  product images from `/media/products/…` (the failed Supabase requests are
  expected). This was verified locally on 2026-11-07.
- Order path: force `/api/orders` to `500`; checkout must keep the real error and
  additionally show the WhatsApp hand-off; a `400` must not.
- Secret check: `grep -rE "R2_|SERVICE_ROLE|SESSION_SECRET" build/assets` must be
  empty.
- Integrity: `scripts/test-resilience.mjs §8` fails if a snapshot image has no
  committed mirror file, the mirror exceeds the budget, or it contains an
  unreferenced image; §6c/§6d cover the exclusion list and the prune path.

**Caveats:**

- The snapshot is a point-in-time copy. Prices/stock shown from it are only a
  browsing aid; the server remains authoritative and ordering via WhatsApp is
  completed by the team.
- The mirror protects against a Supabase outage, not a Vercel outage: if Vercel
  is down the whole storefront (and the snapshot) is down anyway.
- Committed images grow the repository. Re-run the sync only when the catalogue
  changes, and check `du -sh public/media` before committing.
- `scripts/test-resilience.mjs` covers URL mapping, traversal rejection, the
  snapshot reader, outage classification, the WhatsApp message, the mirror
  helpers/wiring, the per-image/total limits, the exclusion list, the prune path,
  and the committed files (106 checks). It runs as part of `npm test`.

---

## 5. Known remaining findings

| ID | Status | Note |
|----|--------|------|
| SEC-24 | Fixed locally; production pending | `reservedStock` is intentionally unused — see §2; verify atomic migration Revision 8 on Production. |
| SEC-28 | Partially applied | Public signups are **closed** (`disable_signup: true`, verified 2026-11-19). Still open: MFA for the admin accounts (the custom scrypt login has no second factor) and the URL allow-list check — see §3. |
| SEC-07 | Mitigated | `/api/coupons/validate` still returns the discount value so the cart can show it. It is rate-limited (10/min/IP) and lockout-protected (5 failures/15 min per IP+code), and the server recomputes the discount at checkout. |
| Public coupon metadata | Accepted | The endpoint reveals whether a code exists and its value. This is required for the cart UX and is bounded by the limits above. |
| `/api/errors` | Accepted | Unauthenticated by design (the browser reports its own crashes). Served by `api/_errors.js` through an `api/auth` rewrite (Hobby 12-function cap). 30 reports/10 min/IP, 8 KB body cap, every field sanitised and truncated, one log line per report, one Telegram alert per distinct error (6/hour/instance, 30-min dedupe). No storage, no echo, no PII. |
| Login budget | Hardened | `api/auth.js` keeps per-IP (20) and per-IP+email (5) budgets and adds per-account (12/15 min) so rotating IPs cannot brute-force one account. A successful login clears the IP+email and account budgets. |

---

## 6. Data-loss warnings before applying

- **Deleting an order with a missing product.** The current local migrations
  partially restore stock for every existing product/variant and report a
  `missing_product` / `missing_variant` warning for skipped lines. The removed
  product's stock cannot be restored after its row is deleted. Verify
  `atomic_order_lifecycle.sql` Revision 3 and the matching `atomic_place_order`
  migration are applied before relying on partial restoration in Production.
- **Storage policy backup.** `storage_hardening.sql` never drops a blanket policy
  (`USING (true)`) or a policy that mentions another bucket; it reports them with
  `NOTICE` for manual review. Only `products`-scoped policies are removed, after
  being copied to `public.zshm_storage_policy_backup` (not browser-readable).
  Policies that must be removed manually are copied there first as well.
  The script also checks whether the current role can manage `storage.objects`.
  Supabase normally owns that table through its storage role, so the SQL Editor
  role cannot `ALTER TABLE` or `DROP POLICY`; in that case the file skips those
  operations and reports `MANUAL ACTION REQUIRED` with exact policy names. Remove
  them in **Dashboard > Storage > Policies**, then re-run the file. Never change
  the table owner or disable RLS to work around the error. Restore backed-up
  policies with `SELECT public.zshm_restore_storage_policies();` (or pass a name
  array) from a role that can manage `storage.objects`.

**Dashboard steps when the SQL role cannot manage `storage.objects` (manual):**

1. Storage → Buckets → `products`: set **File size limit** to `5 MB` and
   **Allowed MIME types** to `image/jpeg, image/png, image/webp, image/gif,
   image/avif`.
2. Storage → Policies → `objects`: remove policies that are scoped **only** to
   the `products` bucket and are not ownership-guarded (typically a public
   `SELECT` or a permissive `INSERT`/`UPDATE`/`DELETE`). The upload API uses the
   service role, so browser write policies are not needed.
3. Keep at least one ownership-guarded SELECT policy if the bucket must remain
   public for product images; keep RLS **enabled** and never change the table
   owner. If unsure, stop and restore the exact policy names from
   `public.zshm_storage_policy_backup`.
4. Re-run `supabase/storage_hardening.sql`; the `MANUAL ACTION REQUIRED` notices
   should disappear, and `supabase/verify_production_security.sql` sections 11–12
   should show the limits and only the intended policies.

---

## 7. Database linter findings reviewed (2026-10-31)

These findings were reviewed against the migrations and API code. Only the
column-level grant gap below required a migration change.

### 7.1 `public.products_public` is SECURITY DEFINER — ACCEPTED

`products_public` deliberately uses `security_invoker = false` (owner rights)
with `security_barrier = true`.

`security_invoker = true` is **incompatible with this rollout**:

- an invoker-rights view runs with the caller's privileges, so `anon` would need
  `SELECT` on `public.products` for the view to return rows;
- Phase 3 revokes the base table from `PUBLIC`/`anon`/`authenticated`;
- granting that access back would let anon query `public.products` directly
  (for example `?select=reservedStock`), which is exactly what SEC-27 prevents.

Granting only the allow-listed columns on the base table would make the view
work, but it still grants anon direct access to the base table, so it is not an
acceptable alternative under the rollout requirements.

The accepted mitigations are:

1. The view is built from an explicit column allow-list; `reservedStock` is not
   in it, and the migration aborts if it is ever added to the allow-list. The
   final list is `id, name, category, price, salePrice, description, stock,
   variantStock, sku, label, colors, sizes, images, image, sizeGuide, rating,
   reviews`. `active` is only a filter (not selected) and `tags` is not read by
   the storefront, so neither is exposed. `rating`/`reviews` are exposed because
   the product cards render them; they hold aggregates of approved reviews only.
2. The view applies the public visibility predicate itself
   (`WHERE active IS TRUE`), because an owner-rights view does not inherit RLS
   row filters. Inactive and `NULL`-active products never reach the public API,
   even if a browser asks for them directly.
3. `stock` and `variantStock` are exposed because the storefront needs
   availability and per-variant cart limits. They are public availability
   counters (the same class as `stock`), never `reservedStock`, cost or internal
   reservation data. Checkout availability is still decided server-side.
4. The view is owned by `postgres`, so its owner-rights read continues to work
   after Phase 3.
5. Phase 3 revokes both table-level **and column-level** privileges on
   `public.products` from `PUBLIC`, `anon` and `authenticated`, then proves it
   with `has_table_privilege()` and `aclexplode(attacl)`.
6. The view itself is granted only `SELECT`, never write privileges.

**Do not silence this linter warning by granting base-table access.** The
safest supported alternative is to keep this view SECURITY DEFINER with the
allow-list and the Phase 3 checks. A dedicated low-privilege view owner is
possible as future defence-in-depth, but it does not remove the warning.

One pre-rollout check: the view mirrors the known public predicate
(`active IS TRUE`) but cannot infer an **additional** RLS row predicate on
`products`. The repository contains no `products` policy definition, so inspect
`pg_policies` with the pre-flight query in the migration before Phase 3. If a
policy hides rows for another reason, copy that predicate into the view before
revoking base-table access.

### 7.2 RLS enabled with no policies — INTENTIONAL

`public.coupons`, `public.orders`, `public.users`, `public.zshm_deploy_flags`
and `public.zshm_storage_policy_backup` are intentionally deny-all for browser
roles.

- `coupons`: RLS enabled, browser policies dropped, table and column grants
  revoked from `PUBLIC`/`anon`/`authenticated`; only `service_role` keeps
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` (`supabase/coupons_lockdown.sql`).
- `zshm_deploy_flags` and `zshm_storage_policy_backup`: RLS enabled and
  `REVOKE ALL` from `PUBLIC`/`anon`/`authenticated`.
- `orders` and `users`: RLS enabled with no policies. PostgreSQL returns no rows
  (and rejects writes) for any role that does not bypass RLS. The API and admin
  console use the service-role client (`api/_lib.js`), and Supabase's
  `service_role` has `BYPASSRLS`, so reads/writes keep working.

Do **not** add permissive policies to silence this warning. Verify with a
read-only query:

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('coupons','orders','users',
                     'zshm_deploy_flags','zshm_storage_policy_backup');

SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'service_role';
```

### 7.3 Unused indexes — KEPT, pending usage data

The linter only reports that these indexes have no recorded scans. That is not
enough evidence to drop them, and the repository does not have
`pg_stat_user_indexes` history. None were dropped.

| Index | Current code usage | Classification |
|---|---|---|
| `coupons_code_idx` (`coupons.code`) | `/api/coupons/validate` and `/api/orders` filter by `code`. | Needed unless a unique/PK index already covers `code`; check `pg_index`/constraints first. The app still guards against duplicate codes, so this is not provably redundant. |
| `coupons_active_dates_idx` (`active, "startDate", "endDate"`) | No server query filters these three columns; coupon expiry is evaluated in JS after a code lookup. | Likely unused by current code, but keep until usage data and ad-hoc/admin queries are confirmed. |
| `orders_date_idx` (`date DESC`) | `/api/admin/orders` orders the full list by `date DESC`. | May be used for large tables; report can be a low-traffic/dashboard artefact. Usage-dependent. |
| `orders_status_idx` (`status`) | No server query filters by `status`; status changes fetch by `id`. | Likely unused by current code, but low write cost; usage-dependent. |
| `products_category_idx` (`category`) | Storefront fetches all products and filters categories client-side; admin filters client-side. | Likely unused by current code, but keep until a representative traffic window confirms it. |

Before removing anything, run this read-only query **on production** and keep
the result for at least one representative traffic window:

```sql
SELECT relname,
       indexrelname,
       idx_scan,
       idx_tup_read,
       idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
 WHERE schemaname = 'public'
   AND relname IN ('coupons','orders','products')
 ORDER BY relname, idx_scan;
```

Also compare `pg_indexes.indexdef` with `pg_constraint` to find true duplicates
(same columns, same predicate). Only a duplicate of a constraint-backed index
is safe to drop without waiting for usage data. The five indexes above are not
duplicates on their face, so `ACTION REQUIRED: gather usage data before any
drop`.

---

## 8. Deployment rules used for this work

- This audit performed **no** `git commit`, `push`, `merge` or deploy. The
  security-remediation changes described here are local and uncommitted on
  top of `a0e78f4`; the branch's last commit predates this remediation.
- No SQL/migration was executed against production or staging.
- No production data was modified or deleted.
- No Vercel/Supabase settings or environment variables were changed.
- `npm test` includes `scripts/test-sql-concurrency.mjs`. It starts a disposable
  local PostgreSQL 15+ cluster in a temp directory, applies the staged migrations and
  runs real concurrent transactions (idempotency races, last-admin demotions,
  legacy order rows, view phases, storage policies, `auth.users` triggers). When
  PostgreSQL's `initdb`/`pg_ctl`/`psql` are not installed it prints `SKIPPED` and
  exits 0; it never connects to a remote database.

  **CI requires it:** a skip is only safe on a developer machine. The
  repository now ships `.github/workflows/ci.yml`, which installs PostgreSQL
  tools, exports `ZSHM_REQUIRE_SQL_TESTS=1` and runs `npm test` + `npm run
  build`; the harness exits non-zero instead of skipping. Local equivalent:

  ```bash
  sudo apt-get install -y postgresql-16
  export PGBIN=/usr/lib/postgresql/16/bin
  export ZSHM_REQUIRE_SQL_TESTS=1
  npm test
  ```

  `initdb` refuses to run as root, so the CI job must run as an unprivileged
  user (GitHub-hosted runners already do).

---

## Recent repository changes (2026-11-01 follow-up pass)

These are already in the working tree (uncommitted) and are covered by the local
test suite; they do not change the migration order above.

- `reservedStock` is retained but removed from all availability math (no
  writer/expiry exists). Availability = `max(0, stock)` without variants, or
  `variantStock["<size>-<color>"]` with variants.
- `atomic_adjust_stock` now supports partial restore: cancellation and deletion
  restore stock for every line whose product/variant still exists and report
  `missing_product` / `missing_variant` warnings instead of aborting. Un-cancel
  (deduction) stays strict.
- Coupons: usage is incremented only after a successful order insert; a coupon
  referenced by a non-cancelled order cannot be deleted (DB + API guard);
  `coupon_not_found` is tolerated where appropriate.
- `public.users` / `public.orders`: deny-all RLS + revoked grants (service role
  only), matching the existing lockdown migration.
- Floating actions are fixed on the storefront at `--floating-action-z: 30000`
  with safe-area offsets. WhatsApp stays visible; scroll-to-top appears after
  scrolling down and hides near the top. Admin panel intentionally excluded
  (its content scrolls in an inner container).
- `pageUrl('track')` now preserves both `?track=` and `?tk=` so secure tracking
  links are not stripped on navigation; `TrackOrder` syncs the URL accordingly.
- `updateCartQty` returns `{ success, error }`; cart UI toasts the bilingual
  stock-limit message instead of silently ignoring it.
- Product image container cursor changed to `default` (no zoom/lightbox).
- Admin accessibility: linked labels, `aria-invalid`/`aria-describedby`,
  `role="dialog"`/`aria-modal` with Escape close and focus management,
  keyboard-accessible upload/CSV drop zones, labelled password toggles.
- `api/_lib.js` `maskOrderForLimitedAccess` comment corrected to match the
  implementation (all PII including `phone` is cleared without a secure token).
- Latest verification: `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 922 passed, 0
  failed (SQL suite actually ran on a temporary PostgreSQL 17 cluster);
  `npm run build` → success; `npm audit --omit=dev` → 0 vulnerabilities;
  built bundle contains only the anon JWT (no service-role key/secret).
