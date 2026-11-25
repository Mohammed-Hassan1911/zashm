# ZASHM — Final launch checks (2026-11-25)

**Status:** `Conditional Go` remains. The image proxy is live and working.
The **SQL gate is complete**: every owner-returned verdict is `PASS` and the
owner explicitly confirmed the current counts are expected. Real-device
viewport/performance checks and the deferred custom-domain decision remain.
A final shop-card label refinement is **local, uncommitted and not deployed**
(§2.4).
This file records what could be proved from this environment and the exact
owner-side checks. No commit, push, deploy, DNS, Vercel, Supabase setting, secret
or data write was made from this environment for these checks.

---

## 1. SQL verification in Supabase — owner step

I could not run arbitrary SQL here: only the service-role REST key is available,
and there is no Supabase Management token / DB connection string. The repo has no
`exec_sql` RPC. I therefore used **read-only REST probes only** and recorded the
results below. The owner chose to run the authoritative SQL file personally.

### 1.1 What the owner must run

1. Open Supabase Dashboard → project `ptegprcbtfylqhbnbkih` → **SQL Editor** →
   **New query**.
2. Paste the whole contents of `supabase/verify_final_launch_readonly.sql`
   (ready-made: `verify_production_security.sql` + Extra A–D below). If the
   SQL Editor splits multi-line statements badly, paste the one-statement-per-line
   version `supabase/verify_final_launch_readonly_oneline.sql` instead. The
   results are identical.
3. Press **Run**. The file is `SELECT`-only: it changes nothing.
4. The supplied file does **not** emit RLS for `zshm_deploy_flags` /
   `zshm_storage_policy_backup`, all four trigger functions, all four trigger
   names, or the post-deletion coupon/stock drift check. Run the extra
   `SELECT`-only queries in §1.4 in the same SQL Editor.
5. Compare all output with `docs/production-remediation-handoff.md` §5/§4.2 and
   the live evidence in §1.2/§1.3 below. Do not run any migration to “fix” a
   result.
6. Send back only the result tables or a short pass/fail list. Do not paste
   customer PII; these queries report counts and catalog metadata only.

### 1.2 Expected / important interpretations

| Check | Requirement |
|---|---|
| `products_public` | View definition contains `WHERE (active IS TRUE)`; columns are exactly the public allow-list, with **no** `reservedStock`, `tags` or `active`. |
| Grants | `anon` / `authenticated` / `PUBLIC` cannot `SELECT` base `products` (table or columns); `anon` can `SELECT` `products_public`; `service_role` can `SELECT` `products`. |
| RLS | `orders`, `users`, `coupons` are emitted by the supplied file; `zshm_deploy_flags` and `zshm_storage_policy_backup` come from Extra A in §1.4. All five must have RLS enabled with 0 policies. Do **not** add policies to silence linter warnings. |
| Deploy flags | Both `products_public_phase1_applied` and `products_public_frontend_live` present (Phase 3 lockdown is live). |
| Sessions | `public.users.session_version` exists. |
| Storage | Bucket `products` is public, `file_size_limit = 5242880`, MIME allow-list present, RLS enabled, no unowned/public-listing policy. |
| Functions/triggers | The supplied file checks 12 functions and 2 triggers. Extra B/C cover the other two trigger functions (`zshm_product_review_sync_rating`, `handle_new_user_secure`) and the three required integrity triggers plus **one** reviewed auth provisioning trigger. Every required function must exist with `search_path` pinned to `public, pg_temp` and no blanket `PUBLIC`/`anon`/`authenticated` EXECUTE. `zshm_protect_last_admin`, `zshm_guard_coupon_delete` and `zshm_product_review_sync` must exist with `tgenabled = O`; on `auth.users`, either `on_auth_user_created_secure` or the reviewed legacy `on_auth_user_created` is acceptable, with exactly one enabled trigger. |
| Counts | Confirm they match the owner’s expected live state. Current counts are in §1.3. If any count is unexpected, **stop** and report; do not modify data. |
| Post-deletion drift | Because the historical raw `DELETE FROM public.orders` does not reconcile stock/coupon usage, run Extra D in §1.4 and report any mismatch. Do not repair data here. |

### 1.3 Read-only REST evidence collected here (no SQL writes)

- Origin: `ptegprcbtfylqhbnbkih.supabase.co`.
- Anon probes: `products_public` → `200` with only the 18 allow-listed columns;
  `products`, `users`, `orders`, `coupons` → `401`.
- Service probes: all five objects reachable; `products_public` has no
  `reservedStock` column.
- `reservedStock` over all `products` rows: **0 non-zero**.
- `zshm_deploy_flags`: `products_public_phase1_applied` and
  `products_public_frontend_live`.
- Read-only counts: `products = 2`, `products_public = 2`, `users = 1` (all
  admin), `orders = 3`, `coupons = 1`. The post-deletion baseline in handoff
  §13.12/C4 was `products = 1`, `users = 1` admin, `orders = 0`; §4.2 records an
  even older superseded state. The current numbers are not explained by that
  deletion alone. The owner must confirm they are expected and run the drift
  check in §1.4 before Go. Nothing was changed here.
- REST OpenAPI exposed **16 callable RPCs**: `atomic_adjust_stock`,
  `atomic_delete_order`, `atomic_edit_order`, `atomic_place_order`,
  `atomic_set_order_status`, `zshm_adjust_coupon_usage`, `zshm_order_items`,
  `zshm_order_lines`, `zshm_order_signature`, `zshm_order_skipped_lines`,
  `zshm_rate_limit`, `zshm_refresh_product_rating`,
  `zshm_restore_storage_policies`, `zshm_sellable_stock`,
  `zshm_storage_policy_scope_is_products`, `zshm_valid_variant_stock`.
  The four repo functions not exposed as RPCs are trigger functions. The
  supplied SQL file checks two of them in §10/§11; Extra B/C cover all four and
  their trigger names, so they must not be treated as missing.

### 1.4 Extra read-only owner queries (run after the supplied file)

**A — RLS for the two flag/backup tables**

```sql
SELECT c.relname,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       count(p.policyname) AS policy_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p
         ON p.schemaname = n.nspname AND p.tablename = c.relname
 WHERE n.nspname = 'public'
   AND c.relname IN ('zshm_deploy_flags', 'zshm_storage_policy_backup')
 GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
 ORDER BY c.relname;
```

Expected: both rows `rls_enabled = true`, `policy_count = 0`.

**B — functions not fully covered by the supplied file**

```sql
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       p.proconfig AS settings,
       p.proacl AS grants
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'atomic_place_order', 'atomic_adjust_stock', 'atomic_set_order_status',
     'atomic_delete_order', 'atomic_edit_order', 'zshm_adjust_coupon_usage',
     'zshm_guard_coupon_delete', 'zshm_protect_last_admin',
     'zshm_product_review_sync_rating', 'handle_new_user_secure',
     'zshm_rate_limit', 'zshm_sellable_stock',
     'zshm_order_signature', 'zshm_order_items', 'zshm_order_lines',
     'zshm_order_skipped_lines', 'zshm_valid_variant_stock',
     'zshm_storage_policy_scope_is_products', 'zshm_restore_storage_policies',
     'zshm_refresh_product_rating'
   )
 ORDER BY p.proname;
```

Expected: every name present; `settings` includes `search_path=public, pg_temp`;
`grants` has no blanket `PUBLIC`/`anon`/`authenticated` `EXECUTE`.

**Live deviation found on 2026-11-25:** the owner’s read-only result showed
`zshm_valid_variant_stock(jsonb)` ACL
`{=X/postgres,postgres=X/postgres,service_role=X/postgres}` — i.e. `PUBLIC`
still has `EXECUTE`. The function is `IMMUTABLE`, pure validation for the
`products_variant_stock_shape` CHECK constraint, and reads/writes no data, so
the practical exposure is low. The repo migration
`supabase/stock_hardening_constraints.sql` never revoked the default `PUBLIC`
grant. The owner approved an explicit production SQL fix on 2026-11-25. Paste
`supabase/revoke_public_execute_valid_variant_stock.sql` in the SQL Editor and
Run; it fails closed if the target or `service_role` grant is missing, revokes
only `PUBLIC`, reloads the PostgREST schema cache, and prints a final `verdict`.
It was verified against a local throwaway PostgreSQL 17 cluster and printed
`PASS`. The owner then ran it in production and returned `verdict = PASS`,
`functions_found = 1`, `public_execute = 0`, `anon_execute = 0`,
`authenticated_execute = 0`, `service_execute = 1`, and ACL
`{postgres=X/postgres,service_role=X/postgres}`. This finding is now **closed**;
do not run any other migration to fix it.

**C — three integrity triggers plus one reviewed auth provisioning trigger**

```sql
WITH trg AS (
  SELECT t.tgname,
         t.tgenabled,
         fn.nspname || '.' || p.proname AS function_name,
         pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p      ON p.oid = t.tgfoid
    JOIN pg_namespace fn ON fn.oid = p.pronamespace
   WHERE n.nspname = 'auth'
     AND c.relname = 'users'
     AND NOT t.tgisinternal
)
SELECT CASE WHEN count(*) FILTER (
                  WHERE tgenabled = 'O'
                    AND tgname IN ('on_auth_user_created_secure', 'on_auth_user_created')
              ) = 1
             AND count(*) FILTER (WHERE tgenabled <> 'O') = 0
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       jsonb_agg(jsonb_build_object(
         'trigger', tgname,
         'function', function_name,
         'enabled', tgenabled,
         'definition', definition
       )) AS auth_triggers
FROM trg;
```

Expected: `verdict = PASS` with exactly one enabled trigger on `auth.users`.
`supabase/security_hardening.sql` explicitly allows either
`on_auth_user_created_secure` → `handle_new_user_secure()` or the reviewed
legacy `on_auth_user_created` → `handle_new_user()`. The owner’s 2026-11-25
result showed the legacy form enabled with `verdict = PASS`, exactly one enabled
trigger, `on_auth_user_created` → `public.handle_new_user`, `tgenabled = O`, and
`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW
EXECUTE FUNCTION handle_new_user()`. The function body review is still pending:
run the query in §1.5 and send its result before deciding whether to keep it or
repoint it. Do not drop or replace it blindly.
The three non-auth integrity triggers remain:
`zshm_protect_last_admin`, `zshm_guard_coupon_delete`,
`zshm_product_review_sync`, all with `tgenabled = O`, as already confirmed by
the owner’s PASS result.

**D — post-deletion coupon/stock drift check (read-only)**

```sql
SELECT c.code,
       COALESCE(c."usageCount", 0) AS usage_count,
       (SELECT count(*)
          FROM public.orders o
         WHERE upper(btrim(COALESCE(o."discountCode", ''))) = upper(c.code)
           AND lower(COALESCE(o.status, '')) <> 'cancelled') AS active_orders_using_coupon
  FROM public.coupons c
 ORDER BY c.code;

SELECT id, name, stock, "variantStock"
  FROM public.products
 ORDER BY id;
```

Expected: `usage_count` matches `active_orders_using_coupon`; the stock snapshot
matches the owner’s intended inventory. A raw order deletion can leave drift,
so report any mismatch instead of silently editing data.

### 1.5 Final auth function body review — owner step

The owner confirmed the enabled trigger is the legacy
`on_auth_user_created` → `public.handle_new_user`, and returned its definition:
`SECURITY DEFINER`, `SET search_path TO 'public'`, inserting only `(id, email)`
into `public.users`, then `RETURN NEW`. It contains no destructive statement,
no `admin` assignment and no role taken from `raw_user_meta_data`; it also has
no `ON CONFLICT` guard and does not set `role`. The column-default result below
showed `role DEFAULT 'manager'`, so this section is **not closed**: a successful
future auth provisioning would grant manager permissions (`products.write`,
`orders.write`, `discounts.write`, `reviews.write`) instead of `support`. The
function also omits `name`, `passwordhash` and `createdate`, which are all
`NOT NULL` with no default; confirm whether a `BEFORE INSERT` trigger fills them.

The first verdict query in this section used `max(boolean)` and failed on the
owner’s PostgreSQL with `42883`. Use the corrected query below instead.

```sql
SELECT pg_get_functiondef('public.handle_new_user'::regproc) AS definition;
```

```sql
WITH f AS (
  SELECT p.prosrc, p.prosecdef, p.proconfig, p.proacl
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.handle_new_user()')
)
SELECT CASE WHEN count(*) = 1
             AND bool_and(prosrc ~* 'insert\s+into\s+(public\.)?users')
             AND bool_and(prosrc ~* 'return\s+new')
             AND bool_and(prosrc !~* 'update|delete|truncate|alter|drop|grant|revoke|set\s+role')
             AND bool_and(prosrc !~* '''admin''')
             AND bool_and(prosrc !~* 'raw_user_meta_data.*role')
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       bool_or(prosrc ~* 'insert\s+into\s+(public\.)?users') AS provisions_public_users,
       bool_or(prosrc ~* '''admin''') AS grants_admin_role,
       bool_or(prosrc ~* 'on\s+conflict[\s\S]*do\s+nothing'
               OR prosrc ~* 'unique_violation') AS has_conflict_guard,
       bool_or(prosrc ~* '\brole\b') AS assigns_role,
       bool_or(prosrc !~* 'update|delete|truncate|alter|drop|grant|revoke|set\s+role') AS no_destructive_or_role_change,
       max(prosrc) AS source,
       bool_or(prosecdef) AS security_definer,
       max(proconfig::text) AS settings,
       max(proacl::text) AS grants
  FROM f;
```

The owner’s corrected verdict was `PASS`, but with `has_conflict_guard = false`
and no `role` assignment. The column query then returned:
`id/name/email/role/passwordhash/createdate/session_version` are `NOT NULL`,
`role DEFAULT 'manager'::text`, `session_version DEFAULT 0`, and
`name/passwordhash/createdate` have **no default**. This is a provisioning and
least-privilege finding, not a clean PASS. Run this final read-only query before
any decision:

```sql
SELECT tgname,
       tgenabled,
       pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t
 WHERE t.tgrelid = 'public.users'::regclass
   AND NOT t.tgisinternal
 ORDER BY tgname;
```

The owner then confirmed that the only trigger on `public.users` is
`zshm_protect_last_admin` (`BEFORE DELETE OR UPDATE`); there is **no**
`BEFORE INSERT` trigger. Therefore the legacy function cannot provision a new
user at all, and if it did it would assign `manager`. The owner approved the
full fix on 2026-11-25. Paste
`supabase/fix_auth_user_provisioning.sql` in the SQL Editor and Run. It:
fails closed if the reviewed legacy body is no longer present; changes
`users.role DEFAULT` to `support`; replaces `handle_new_user()` with an explicit
insert of every `NOT NULL` column, `role = 'support'`, a password hash marker that
can never validate, and `search_path = public, pg_temp`; keeps the
`on_auth_user_created` trigger; reloads the PostgREST schema; and prints a final
`verdict`. It was exercised against a local PostgreSQL 17 cluster mirroring the
owner’s column layout and returned `PASS`, including a successful simulated auth
insert. The owner then ran it in production and returned:
`verdict = PASS`, `role_default = 'support'::text`,
`settings = {search_path=public, pg_temp}`, ACL
`{postgres=X/postgres,service_role=X/postgres}`, `legacy_trigger_enabled = 1`
and `auth_triggers = 1`. This finding is now **closed**.

### 1.6 Owner-returned SQL result summary

| Owner result | Outcome |
|---|---|
| Base grants / view / flags / session_version / storage / counts | `PASS`; counts `products=2`, `products_public=2`, `users=1` admin, `orders=3`, `coupons=1`, `reservedStock=0`. Owner explicitly confirmed these counts are expected. |
| Extra A — flags/backup RLS | `PASS`, 2 tables, no failing tables. |
| Extra B + grant fix | `PASS`; all 20 functions present; original `PUBLIC` EXECUTE on `zshm_valid_variant_stock` removed and verified. |
| Extra C + auth fix | Three integrity triggers `PASS`; `auth.users` has exactly one enabled legacy trigger; function body review and least-privilege fix now `PASS`. |
| Extra D — coupon drift | `PASS`, 1 coupon, no mismatches. |
| Stock snapshot | Both products match `sum(variantStock) = stock`; no negative or non-integer values. |

All SQL evidence returned by the owner is `PASS`, and the owner confirmed the
counts are expected. The SQL gate is now **complete**. No production SQL was
applied from this environment; the two owner-approved fixes were pasted and run
by the owner in the Supabase SQL Editor.

---

## 2. Viewport/performance checks

The connected browser cannot resize its own window (`window.resizeTo` is inert),
and the live Worker sends `frame-ancestors 'none'` / `X-Frame-Options: DENY`, so
the live page cannot be iframed directly. To get real CSS-pixel viewports
without touching production, a temporary **local, read-only reverse proxy**
(`127.0.0.1:8791`) forwarded `GET`/`HEAD` to
`https://zashm.za-shm.workers.dev` and stripped only framing/CSP headers in a
local wrapper page. The wrapper rendered the live response in iframes of
320/375/768/1440 CSS px. This is a browser layout check against live content,
**not** a real-device or field-CWV test. The proxy was stopped afterwards; no
production request other than normal page/asset GETs was made.

### 2.1 Owner step on real devices — still required

Open `https://zashm.za-shm.workers.dev/` and `/shop` on:

- iPhone Safari (phone, ~375–430 CSS px)
- Android Chrome (phone, ~360–430 CSS px)
- Tablet Safari/Chrome (~768 CSS px)
- Desktop Chrome/Safari (~1440 CSS px)

On each:

1. Home, Shop, one product page, Cart, Checkout and Track render without
   horizontal scrolling.
2. Product images load through `/img/v1/`; no broken images and no direct
   Supabase Storage image request in the network panel.
3. On `/shop`, the outside card label sits flush above the photo, keeps the
   product-page pill shape but is a shade smaller, and never covers the image
   (§2.4). This refinement is local only and is not yet on the Worker.
4. WhatsApp is visible on Home only, above the header/nav/modals and safe-area
   aware; it is unmounted while the bag dialog is open.
5. No console errors, no CSP errors, no 404s for app assets.
6. Do **not** submit a real order or payment. Cart/coupon/checkout may be
   inspected without confirmation.
7. Send screenshots plus any failure description. If a browser exposes Web
   Vitals, send LCP/CLS/INP; otherwise a short note that field CWV is
   unavailable is enough.

### 2.2 Lab evidence collected here (not a device test)

- Browser trace on live `/shop` at the available 1000px viewport: 2730 events,
  **0 long tasks**, **0 ms long-task blocking**. The tool explicitly does not
  calculate LCP/INP/CLS or a Lighthouse performance score, so no field-CWV or
  real-device claim is made.
- Network on the same reload: 24 requests, **2** `/img/v1/w1200/...` image
  requests, **0** direct `supabase.co/storage` image requests; both proxy
  images were `image/avif`, `cf-cache-status: HIT`, `x-zashm-image: hit`.
- Earlier final smoke: Lighthouse accessibility/best-practices/SEO `1/1/1`
  with no failures; no performance category was emitted. `ZSHM_REQUIRE_SQL_TESTS=1
  npm test` → 40 suites / 4373 passed / 0 failed (real PostgreSQL suite ran:
  495/0); `npm run build` passed.

### 2.3 Live-content layout matrix collected here (2026-11-25)

Measured inside the 320/375/768/1440 CSS-px iframes above; `scrollWidth ==
innerWidth` on every route checked, so no horizontal page scroll:

| Width | `/shop` grid | Nav | Result |
|---|---|---|---|
| 320 | `131px 131px` | `.mobile-nav` visible at bottom | PASS |
| 375 | `156.5px 156.5px` | `.mobile-nav` visible at bottom | PASS |
| 768 | `353px 353px` | `.mobile-nav` visible at bottom | PASS |
| 1440 | `320px × 4` | desktop header buttons visible, `.mobile-nav` `display:none` | PASS |

- Coverage: `/shop` at 320/375/768/1440; `/` at 320/375/1440; one product page
  at 320/375/768; `/cart` at 375/768; `/checkout` and `/track` at 375/1440.
  No horizontal overflow, no broken images, and no direct `supabase.co/storage`
  image requests were observed on any of them. Product/shop images loaded
  through `/img/v1/` (for example 10 proxy images and 0 direct Supabase images
  on the 320px product page).
- `.shop-hero-glow` and the product gallery frames extend past the viewport,
  but their containers clip them: document `scrollWidth` stayed equal to
  `innerWidth`. The product gallery is a horizontal carousel by design.
- WhatsApp appeared on Home only: 54×54 px at `x=16`, `y=904`, `z-index:30000`
  at 375px; 44×44 px at `x=24`, `y=982`, `z-index:30000` at 1440px. It was not
  present on `/shop`, product, `/cart`, `/checkout` or `/track`.
- A product card tap navigated to the product route; size `M` was selected by
  default and the `ADD TO BAG` control hit-tested correctly after scrolling.
  The fixed mobile nav did not cover it. No order, coupon, cart-write or payment
  request was submitted.
- Clean page loads produced **0 console errors**. One earlier Home load showed
  `ERR_CONNECTION_CLOSED` while the temporary local proxy was restarting; a
  fresh load of the same URL was clean. That error is not attributable to the
  deployed Worker.
- These are layout/DOM/network observations from a Chromium browser, not iOS
  Safari/Android Chrome rendering, touch behaviour, OS safe-area insets or field
  Core Web Vitals. The owner device step in §2.1 therefore remains open.

### 2.4 Final shop-card label refinement (local, uncommitted)

The owner resolved the label placement after several iterations. The final
local state is:

- The shop card label is **outside the photo, flush with its top edge**
  (`.product-card-labels-above { position: static; margin: 0; }`). It never
  overlays the image and never reserves a visible gap above it.
- It keeps the **same pill shape, gradient, border and lit stud** as the product
  page label, but is **a shade smaller**: desktop `9px` type / `5px 11px`
  padding / `4px` stud versus the product page `10px` / `7px 15px` / `5px`;
  at ≤768px it is `9px` / `3px 7px` / `4px` versus `10px` / `3px 8px` / `5px`.
- The product page label itself was restored to its original row above the
  gallery image and was not changed by this refinement.
- The label row is always reserved so labelled and unlabelled cards keep their
  photos aligned in a grid row.

Local browser verification (Vite on `localhost:3000`, not the Worker):

- Desktop 816px: card badge `114×26px`, product badge `137×32px`, both rounded
  pills; card `gap: 0` to the image, product `10px`, no horizontal overflow.
- 375px CSS viewport: both badges `111×24px` at ≤768px rules, card `gap: 0`,
  `scrollWidth == innerWidth`.
- `node scripts/test-ux-fixes.mjs` → 116 passed, 0 failed;
  `node scripts/test-product-zoom.mjs` → 35 passed, 0 failed;
  `npm run build` passed; `ZSHM_REQUIRE_SQL_TESTS=1 npm test` → 40 suites /
  4377 passed / 0 failed, with the real PostgreSQL suite actually running
  (495 passed, 0 failed); `git diff --check` clean.

These files are **uncommitted** and the change is **not deployed** to the
Worker. It is therefore not production-verified; the owner must include it in
the real-device check after their own commit/push/deploy decision. No commit,
push or deploy was made from this environment.

---

## 3. Domain status

The owner confirmed no card is currently available. Therefore:

- Canonical origin stays `https://zashm.za-shm.workers.dev` with `noindex`.
- No domain purchase, DNS change, Cloudflare custom-domain binding, Vercel alias
  change, or `noindex` removal was made.
- Vercel remains the untouched 307 rollback bridge. Custom-domain rollout is
  deferred until the owner buys/chooses a name and explicitly approves the
  change.

---

## 4. Gate to change `Conditional Go` → `Go`

All of the following must be true:

- [x] SQL gate: all owner-returned verdicts in §1.6 are `PASS`, including both
      approved production fixes, and the owner confirmed the current counts
      (`products=2`, `users=1` admin, `orders=3`, `coupons=1`) are expected.
- [ ] Owner completes the phone/tablet/desktop checks and reports no blocking
      layout, image, label, WhatsApp or console failure (§2.1/§2.4).
- [ ] Owner buys/chooses the custom domain and explicitly approves DNS,
      Cloudflare custom-domain binding, `noindex` removal and any Vercel
      alias work — or explicitly accepts `workers.dev + noindex` as the
      permanent launch origin.

Until then the deployed image-proxy release is **live and functional**, but not
formally signed off for official announcement.
