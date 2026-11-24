# Production ↔ Staging schema comparison

**Status:** Executed with read-only access on 24 November 2026. Every statement
ran inside `BEGIN READ ONLY` and ended with `ROLLBACK`. No schema, data, grants,
policies, secrets, DNS, or deployment was changed in either project. The local
Supabase link was temporarily pointed at Staging for its snapshot and restored
to Production immediately afterwards.

## Purpose

Prove that Supabase Staging (`sfenutmgfawuhmvwkmhv`) has the same *schema
surface* the application expects from Supabase Production
(`ptegprcbtfylqhbnbkih`) before any cutover. Data is deliberately different.

## Read-only snapshot

`supabase/schema_snapshot_readonly.sql`:

- runs inside `BEGIN READ ONLY` and ends with `ROLLBACK`;
- uses only `SELECT` statements against `pg_catalog` and read-only counts;
- never creates, alters, drops, inserts, updates, deletes, grants, or revokes;
- never rotates or reads secret values;
- was syntax-checked against a throwaway local PostgreSQL 17 cluster, not
  against Supabase.

Run it once per project with a **read-only** connection:

```bash
psql "$STAGING_READONLY_URL" -v ON_ERROR_STOP=1 \
  -f supabase/schema_snapshot_readonly.sql > /tmp/zashm-staging-schema.txt

psql "$PRODUCTION_READONLY_URL" -v ON_ERROR_STOP=1 \
  -f supabase/schema_snapshot_readonly.sql > /tmp/zashm-production-schema.txt

diff -u /tmp/zashm-staging-schema.txt /tmp/zashm-production-schema.txt
```

Use `-qAt` instead of the default aligned output for a machine-friendly diff if
desired; run it identically on both projects.

## Expected differences (data, not schema)

| Area | Production | Staging | Safe? |
|---|---|---|---|
| Product rows | Real catalogue | Fixtures `9900000000001`, `9900000000002`, inactive `9900000000003` | Yes—fixtures are isolated by project |
| Coupons | Real coupons | `STAGE3TEST10` with controlled usage | Yes |
| Admin/staff users | Real accounts | `stage3-admin@test.invalid`, `stage3-support@test.invalid` | Yes |
| Orders | Real customer orders | Test order created and deleted during verification | Yes |
| Supabase project ref | `ptegprcbtfylqhbnbkih` | `sfenutmgfawuhmvwkmhv` | Expected |
| Vercel env values | Production-only key set | Staging-only key set, independent `SESSION_SECRET`, no Telegram | Expected |

## Schema differences that are **not** acceptable

Treat any of these as a blocker and stop before cutover:

1. A missing expected function from the snapshot list, or a different argument
   signature/return type.
2. `products_public` missing, non-`security_invoker`, or without the
   `active IS TRUE` filter / explicit allow-list.
3. Base `products`, `users`, `orders`, or `coupons` readable by `anon` or
   `authenticated` (service role only).
4. RLS disabled or expected policies missing on protected tables.
5. `reservedStock` nonzero or negative on any row (AGENTS.md stop condition).
6. Any unexpected admin/user/order/coupon count that suggests staging data in
   Production or real Production data copied into Staging.
7. Different order lifecycle constraint definitions between the two projects.

## Execution result (24 November 2026)

Both snapshots were captured through the Supabase CLI against the Management
API, one statement at a time, each wrapped in `BEGIN READ ONLY` / `ROLLBACK`.

**Production passed every application-critical invariant:**

- all 20 expected functions exist with matching signatures/volatility/security;
- all 9 expected relations exist with the expected kinds;
- all 32 checked columns exist with the expected types;
- `products_public` has the explicit allow-list, `active IS TRUE`, and
  `security_barrier=true, security_invoker=false`;
- grants on `products`, `users`, `orders`, and `coupons` expose no
  `anon`/`authenticated` privileges;
- the expected stock, reserved-stock, variant-shape, active-boolean, and
  coupon-code constraints exist;
- `nonzero_reserved_stock = 0` and `negative_reserved_stock = 0`.

**Differences found in Staging (Production was not changed):**

| Difference | Production | Staging | Assessment |
|---|---|---|---|
| `products` RLS | enabled | disabled | Browser roles have no grants on the base table in either project, and the public view is `security_barrier` with an allow-list. Still a hardening gap in Staging; align before treating Staging as a full mirror. |
| `products.createdAt` | present | missing | Not used by the verified journeys; does not affect Production. |
| `coupons.coupons_code_key` | `UNIQUE (code)` | missing | Staging could accept duplicate coupon codes; Production is protected. |
| `products_public` column order | different | different | Same allow-list and same `WHERE active IS TRUE`; `security_barrier=true, security_invoker=false` in both. Cosmetic only. |

Data counts differ as expected (Production: 1 admin / 1 order / 1 coupon / 2
products; Staging: 2 admin / 2 order / 1 coupon / 3 products). No unexpected
Production count or reserved-stock value was found.

## Interpretation

- The **identity**, data-count, and project-ref rows are expected to differ.
- Function presence/signature, grants, `products_public` filter/options, and
  all stock/order constraints match.
- The three structural differences above are Staging-side only. They do not
  invalidate Production readiness, but they must be recorded before any future
  decision to make Staging a byte-for-byte schema mirror.
- No Production schema, data, or configuration was modified to obtain this
  result. Cutover remains approval-gated.
