# Production ↔ Staging schema comparison (prepared, not executed)

**Status:** Prepared only. No Production connection was used. No Production SQL
was executed. No schema, data, grants, policies, secrets, DNS, or deployment was
changed.

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

## Interpretation once both snapshots exist

- The **identity**, data-count, and project-ref rows are expected to differ.
- Function presence/signature, relation kind, RLS flags, policy names/expressions,
  grants, and constraints should match.
- If a difference appears only in a policy expression due to a renamed fixture
  role or Supabase-managed policy, report it rather than patching Production.

No comparison result can be stated yet because the Production read-only
connection/token is not available from this environment. Owner approval and
read-only access are required before running the Production snapshot.
