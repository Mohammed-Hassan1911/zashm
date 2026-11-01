---
name: Supabase Database
description: Use when changing ZASHM's PostgreSQL schema, RLS policies, grants, views, migrations, RPCs, or when planning/verifying Supabase production SQL safely.
---

# ZASHM Supabase Database

## Mission

Change the ZASHM database without exposing customer data, breaking checkout, or
locking out the service role. Every schema/RLS change must be idempotent,
reversible, verified with real PostgreSQL, and documented.

## Environment facts

- Project ref: `ptegprcbtfylqhbnbkih` (`https://ptegprcbtfylqhbnbkih.supabase.co`).
- The browser uses the **anon** key; it may only read `products_public`.
- Every serverless route uses the **service role** key, server-side only.
- `service_role` has `BYPASSRLS` in Supabase; migrations that depend on it must
  fail closed if that is not true.
- The repo has no arbitrary-SQL RPC (`exec_sql` returns `PGRST202`). Schema work
  happens in the SQL Editor/psql; never invent a remote exec endpoint.
- Production migration state is **not** guaranteed to match the repository. Read
  `docs/production-remediation-handoff.md` and
  `docs/security-production-checklist.md` first; never rerun blindly.

## Core schema (repo expectations)

| Table / object | Important columns | Access |
|---|---|---|
| `public.products` | `id bigint`, `name`, `category`, `price`, `salePrice`, `stock`, `variantStock jsonb`, `reservedStock` (legacy), `images`, `image`, `sizes`, `colors`, `description`, `sku`, `label`, `tags`, `active` | browser: **no**; service role only |
| `public.products_public` (view) | explicit allow-list, `WHERE active IS TRUE` | anon/authenticated `SELECT` |
| `public.users` | `id`, `name`, `email`, `passwordhash`, `role`, `session_version` | browser: **no**; service role only |
| `public.orders` | `id text` (`ZSH-…`), `items jsonb`, `status`, totals, `customer`, `phone`, `address`, `city`, `date`, `timestamps`, `discountCode`, `tracking_url` | browser: **no**; service role only |
| `public.coupons` | `id`, `code` (unique), `type` (`percentage`/`fixed`), `value`, `discountValue`, `active`, `startDate`, `endDate`, `usageLimit`, `usageCount`, `minOrderAmount`, `maxDiscount` | browser: **no**; service role only |
| `public.zshm_deploy_flags` | `name`, `note` | rollout gates |

`variantStock` is an object keyed by `"<size>-<color>"` (e.g. `"M-Black": 8`).
For products **with** variants, availability is per key. For products **without**
variants, availability is global `stock`, summed across cart lines.

`reservedStock` is **retained but unused**: no writer/expiry exists and it is
excluded from `products_public` and from every availability calculation. Do not
reintroduce it into math, and do not drop it without an explicit decision and a
backup.

## Functions (authoritative behaviour)

| Function | Signature | Purpose |
|---|---|---|
| `atomic_place_order` | `(p_order jsonb, p_idempotency_key text default null) returns jsonb` | one-transaction order insert, stock decrement, coupon lock/usage, idempotency signature |
| `atomic_adjust_stock` | `(p_lines jsonb, p_delta integer) returns jsonb` | deduct (`-1`, strict) or restore (`+1`, partial: reports `missing_product`/`missing_variant`, restores existing lines) |
| `atomic_set_order_status` | `(p_id text, p_expected_status text, p_new_status text, p_timestamps jsonb default null) returns jsonb` | lock order, optimistic status check, stock/coupon reconciliation |
| `atomic_delete_order` | `(p_id text) returns jsonb` | lock, optional restore, delete, warnings |
| `zshm_adjust_coupon_usage` | internal helper | tolerant `coupon_not_found`; usage decrement clamped |
| `zshm_guard_coupon_delete` | trigger | refuses deleting a coupon referenced by a non-cancelled order (`coupon_in_use`, SQLSTATE 23503) |
| `zshm_protect_last_admin` | trigger | refuses demoting/deleting the last admin |

All functions use `SET search_path = public, pg_temp`; keep that. Order locking is
always `orders` → `products` (ascending id) to stay deadlock-free. Money is
computed in `api/orders.js`, then recomputed/validated in SQL from the locked
coupon row; never trust client prices.

## Migration order (when applying from scratch)

1. `atomic_place_order.sql`
2. `atomic_order_lifecycle.sql` (calls `atomic_adjust_stock`)
3. `admin_protection.sql`
4. `security_hardening.sql`
5. `coupons_lockdown.sql` — **only after** the server-only coupon code is deployed
   (SECTION 0 read-only → review → SECTION 1 → SECTION 2)
6. `session_revocation.sql` (safe before/after deploy; both sides default to 0)
7. `storage_hardening.sql` (review NOTICEs; storage.objects may need Dashboard)
8. `users_orders_lockdown.sql` — **only after** the API-based users/orders code is
   deployed (SECTION 0 → 1 → 2)
9. `products_public_view.sql` — Phase 1 only; deploy the frontend that reads the
   view; then set `products_public_frontend_live`; then rerun for Phase 3
10. `verify_production_security.sql` (read-only) after each phase

This is stricter than the checklist's older numbering: never run a lockdown
before the corresponding API path is live. When in doubt, run the file's own
SECTION 0 and follow its gates.

## Writing migrations: rules

- **Idempotent:** `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, `DROP VIEW IF EXISTS` before recreate.
- **Fail closed:** guard on required prerequisites (e.g. `service_role` must
  `BYPASSRLS`; view must exist before Phase 3), and `RAISE EXCEPTION` with a
  clear message instead of silently broadening access.
- **No data destruction:** no `DELETE`, `TRUNCATE`, `DROP TABLE`, or column drop
  without a written backup and explicit approval. Prefer additive changes.
- **Both RLS and grants:** deny-all RLS plus `REVOKE`/`GRANT` so a future
  permissive policy cannot silently reopen a table. `service_role` keeps access.
- **Column allow-list views:** list public columns explicitly; new columns must
  be a deliberate decision. Never expose `reservedStock`, `passwordhash`, PII,
  coupon usage counters, or internal notes.
- **Staged rollout:** a view/grant change that requires a matching frontend must
  be gated by `zshm_deploy_flags`; the old bundle must keep working until the new
  one is verified in production.
- **Reversibility:** every file ends with verification queries and a rollback
  section, including how to restore dropped policies/grants.
- **No cross-file dependency inversion:** a file may only call functions created
  by an earlier file in the order above.

## Verification workflow

1. **Local first:** `scripts/test-sql-concurrency.mjs` spins up a temporary
   PostgreSQL cluster, applies the migrations, and runs real concurrency tests.
   In CI `ZSHM_REQUIRE_SQL_TESTS=1` makes a skipped DB a failure.
2. Add a test for every new function/branch: success, conflict, missing row,
   concurrent callers, and legacy payload shapes.
3. **Read-only production check:** `supabase/verify_production_security.sql`
   (catalog queries only). Compare with the expected values in the handoff doc.
4. **Anon smoke test:** `GET /rest/v1/products_public` returns rows without
   `reservedStock`; `GET /rest/v1/products?select=reservedStock` returns 401/403.
5. **Service-role smoke test:** admin product list/create/edit and checkout still
   work after every grant change.

## Stop conditions

Stop and report (do not "fix" silently) when:

- `reservedStock` is nonzero, negative, or unexpected.
- Production admin/user/order/coupon counts differ from the documented baseline.
- A migration would run twice with conflicting definitions or staged flags.
- `service_role` would lose `SELECT`/`INSERT`/`UPDATE`/`DELETE` or `BYPASSRLS`.
- Any step could delete or rewrite real customer/order data.
- The SQL role does not own an object the migration wants to alter (common for
  `storage.objects`); report the exact manual Dashboard action instead of
  escalating privileges.

## Deliverables for a DB change

- The migration file with header (purpose, order, gates, rollback).
- Updated test coverage proving the behaviour on real PostgreSQL.
- Updated handoff/checklist docs for any new order/gate/decision.
- A short risk statement: what breaks if applied late, early, or twice.
