# ZASHM — Security rollout & production checklist

This file documents the items that **cannot be fixed from the repository alone**
(they need a Supabase/Vercel dashboard action or an explicit schema decision).
This file is guidance only; it applies nothing automatically. **Nothing in this file has been applied automatically** by the repository or by this audit — every migration and
Dashboard change below is a manual action whose production status must be
recorded in the final production-readiness audit, never assumed here.

Last updated: 2026-11-01

---

## 1. Migrations awaiting approval (apply in this order)

Run each file in the Supabase SQL Editor, one at a time, after reviewing it.
They are idempotent where possible and none of them delete rows.

| # | File | What it changes |
|---|------|-----------------|
| 1 | `supabase/atomic_place_order.sql` (Revision 8) | Replaces order placement RPC: aggregates demand (per variant for variant products, per product for products without variants), ignores unused `reservedStock`, keeps `stock = sum(variantStock)`, increments coupon usage only after a successful INSERT, rejects inactive products/changed coupons, safely parses JSON, and compares cart signatures for idempotent retries. |
| 2 | `supabase/atomic_order_lifecycle.sql` | Adds `atomic_set_order_status` / `atomic_delete_order` (status changes + stock/coupon restore inside one transaction), legacy-safe item parsers, partial restore for missing products/variants, and the strict `zshm_adjust_coupon_usage` helper. Apply after #1 because it calls `atomic_adjust_stock`. |
| 3 | `supabase/admin_protection.sql` | Trigger that refuses to demote/delete the last admin (transaction advisory lock; covered by a real two-connection test). |
| 4 | `supabase/security_hardening.sql` | Function `search_path` pinning / privilege revokes; inspects every existing `auth.users` trigger and refuses to add a second provisioning trigger. It never drops/replaces an existing trigger and no longer defines a duplicate last-admin function. |
| 5 | `supabase/storage_hardening.sql` | `products` bucket: 5 MB limit, image MIME allow-list, RLS, and a restrictive policy preventing browser roles from listing product filenames while retaining public image downloads. Drops only policies provably scoped to `products`; blanket/other-bucket policies are kept for manual review. If the SQL role does not own `storage.objects` (normal in Supabase), it never runs `ALTER TABLE`/`DROP POLICY`; it reports the exact products-only policies for removal in **Dashboard > Storage > Policies**. Every policy dropped by the script is backed up verbatim and restorable with `zshm_restore_storage_policies()`. |
| 6 | `supabase/products_public_view.sql` | Creates `products_public` with `WHERE active IS TRUE` (inactive/NULL products never reach the public API) from an explicit public-column allow-list (`id, name, category, price, salePrice, description, stock, variantStock, sku, label, colors, sizes, images, image, sizeGuide`; `reservedStock` is not in it, and `active/tags/rating/reviews` are not selected), grants SELECT on the view, and after the staged rollout flag revokes the base table (table-level and column-level) from `PUBLIC`/`anon`/`authenticated`. |

Two further files are required but are **not** counted in the six above:

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

Deploy the updated frontend and `/api/orders` together: the API now requires
the frontend's persistent idempotency key. Verify the atomic order-placement
migration is applied before accepting production orders.

After #6, verify with an **anon** key (not the service role):

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
Production before relying on this behavior there. COD orders deduct real stock
atomically at placement; no inventory is held until delivery.

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

## 5. Known remaining findings

| ID | Status | Note |
|----|--------|------|
| SEC-24 | Fixed locally; production pending | `reservedStock` is intentionally unused — see §2; verify atomic migration Revision 8 on Production. |
| SEC-28 | Open (manual) | Supabase Auth settings — see §3. |
| SEC-07 | Mitigated | `/api/coupons/validate` still returns the discount value so the cart can show it. It is rate-limited (10/min/IP) and lockout-protected (5 failures/15 min per IP+code), and the server recomputes the discount at checkout. |
| Public coupon metadata | Accepted | The endpoint reveals whether a code exists and its value. This is required for the cart UX and is bounded by the limits above. |

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
   variantStock, sku, label, colors, sizes, images, image, sizeGuide`.
   `active` is only a filter (not selected), and `tags`, `rating` and `reviews`
   are not read by the storefront, so they are no longer exposed.
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
  local PostgreSQL 15+ cluster in a temp directory, applies all six migrations and
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
