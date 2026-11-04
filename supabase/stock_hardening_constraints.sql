-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · STOCK HARDENING CONSTRAINTS
-- File: supabase/stock_hardening_constraints.sql
--
-- Status: NOT APPLIED. Nothing in this repository has executed it. It is applied
--         only by the owner, in the Supabase SQL Editor, with explicit approval.
--
-- PURPOSE
--   Enforce at the database level what the catalogue already promises:
--     * products.active / products.stock / products."reservedStock" are not NULL
--     * products.stock and products."reservedStock" are never negative
--     * products."variantStock" is a JSON object whose keys are non-empty,
--       whitespace-free labels and whose values are non-negative integers
--       (max 1,000,000 — the same cap api/_lib.js enforces).
--
-- WHY CAMEL CASE MATTERS
--   The two stock columns are quoted identifiers: "variantStock" and
--   "reservedStock". Unquoted SQL is folded to lower case, so the previous draft
--   failed on PostgreSQL 17 with `column "reservedstock" does not exist` and
--   `column "variantstock" does not exist`. Every reference below is quoted.
--
-- LEGACY DATA POLICY (no silent repair)
--   This migration NEVER deletes, zeroes, moves or normalises a row. Section 1
--   inspects the table first and ABORTS the whole transaction if any row would
--   violate a constraint, listing the offending ids/counts. That is deliberate:
--     * "reservedStock" is unused by the storefront (see AGENTS.md); it is never
--       written by any code path and must not be "cleaned" here.
--     * variantStock orphan keys (e.g. M-White / L-White for Jacket Boxy) are
--       real historical quantities. They are excluded from the sellable total by
--       zshm_sellable_stock(), but the rows stay untouched.
--     * Duplicate declared sizes/colours are now de-duplicated by the API and by
--       zshm_sellable_stock(); this file does not rewrite existing arrays.
--   If the preflight reports rows, fix them deliberately (after a backup) with an
--   explicit UPDATE reviewed by the owner, then run this file again. Only two
--   cleanup shapes are supported and both are intentionally commented out in
--   section 1c: NULL active → false, NULL stock → 0. There is no automatic
--   remediation of variantStock.
--
-- PREREQUISITES (run READ-ONLY first, keep the output)
--   1. supabase/verify_production_security.sql
--   2. Section 0 below (read-only counts, no writes)
--   3. supabase/products_public_view.sql Phase 1 must already be applied: the
--      hardening runs on public.products, which the browser never reads.
--
-- EXECUTION ORDER (with approval only)
--   1. supabase/atomic_place_order.sql            (REVISION 10)
--   2. supabase/reject_undefined_variants.sql     (migration 1 of 2, staging)
--   3. supabase/declared_only_stock_recompute.sql (migration 2 of 2, staging)
--   4. supabase/atomic_order_lifecycle.sql
--   5. supabase/admin_protection.sql
--   6. supabase/security_hardening.sql
--   7. supabase/coupons_lockdown.sql
--   8. supabase/session_revocation.sql
--   9. supabase/storage_hardening.sql
--  10. supabase/products_public_view.sql          (Phase 1 → deploy → Phase 3)
--  11. supabase/stock_hardening_constraints.sql   (THIS FILE, last)
--   If a migration is already applied, re-running it is safe: every CREATE OR
--   REPLACE FUNCTION is idempotent, and this file guards every constraint with a
--   catalog check. Steps 2 and 3 replace the same function bodies as step 1 and
--   only exist for the two-step rollout of an already-deployed environment.
--
-- ROLLBACK
--   supabase/stock_hardening_constraints_rollback.sql — executable as-is.
--   It drops the four constraints, the helper function and the NOT NULL flags.
--   It never touches data.
--
-- TESTED ON
--   Disposable PostgreSQL 17 cluster (scripts/test-sql-concurrency.mjs):
--   applied twice in a row, applied after a NULL row aborts cleanly, and the
--   rollback file restores the pre-migration shape. No production SQL was run.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PREFLIGHT REPORT (READ-ONLY — run and keep the output) ────────────────
-- Nothing is modified by this section. Every count below must be zero before
-- the transaction in section 1 can commit.
SELECT
  count(*)                                            AS products_total,
  count(*) FILTER (WHERE active IS NULL)              AS active_null,
  count(*) FILTER (WHERE stock IS NULL)               AS stock_null,
  count(*) FILTER (WHERE stock < 0)                   AS stock_negative,
  count(*) FILTER (WHERE "reservedStock" IS NULL)     AS reserved_null,
  count(*) FILTER (WHERE "reservedStock" < 0)         AS reserved_negative,
  count(*) FILTER (
    WHERE "variantStock" IS NOT NULL
      AND jsonb_typeof("variantStock") <> 'object'
  )                                                  AS variant_not_object
FROM public.products;

-- 0b. Variant keys that are not "<size>-<colour>" at all, empty, padded, or that
--     carry a negative / non-integer / oversized quantity. Reported, never fixed.
SELECT p.id, p.name, kv.key, kv.value
  FROM public.products p
  CROSS JOIN LATERAL jsonb_each_text(p."variantStock") AS kv(key, value)
 WHERE jsonb_typeof(p."variantStock") = 'object'
   AND (
        btrim(kv.key) = ''
     OR kv.key <> btrim(kv.key)
     OR kv.value !~ '^[0-9]+$'
     OR kv.value::numeric > 1000000
   )
 ORDER BY p.id, kv.key
 LIMIT 200;

-- ── 1) TRANSACTION: preflight → constraints (all or nothing) ─────────────────
BEGIN;

-- Never wait forever behind a long transaction on a live catalogue: if the
-- ACCESS EXCLUSIVE lock cannot be taken in five seconds, abort and retry later.
SET LOCAL lock_timeout = '5s';
-- Keep the session path deterministic while running raw DDL.
SET LOCAL search_path = public, pg_temp;

-- ── 1a) FAIL-CLOSED PREFLIGHT ────────────────────────────────────────────────
-- Raises before any constraint is added, so a dirty table is never "repaired"
-- and never half-migrated. The whole transaction (including the helper function
-- created in 1b) rolls back.
DO $$
DECLARE
  v_active_null      bigint;
  v_stock_null       bigint;
  v_stock_negative   bigint;
  v_reserved_null    bigint;
  v_reserved_neg     bigint;
  v_variant_bad      bigint;
  v_sample           text;
BEGIN
  SELECT
    count(*) FILTER (WHERE active IS NULL),
    count(*) FILTER (WHERE stock IS NULL),
    count(*) FILTER (WHERE stock < 0),
    count(*) FILTER (WHERE "reservedStock" IS NULL),
    count(*) FILTER (WHERE "reservedStock" < 0),
    count(*) FILTER (
      WHERE "variantStock" IS NOT NULL
        AND (
          jsonb_typeof("variantStock") <> 'object'
          OR EXISTS (
            SELECT 1
              FROM jsonb_each_text("variantStock") AS kv(key, value)
             WHERE btrim(kv.key) = ''
                OR kv.key <> btrim(kv.key)
                OR kv.value !~ '^[0-9]+$'
                OR kv.value::numeric > 1000000
          )
        )
    )
    INTO v_active_null, v_stock_null, v_stock_negative,
         v_reserved_null, v_reserved_neg, v_variant_bad
    FROM public.products;

  SELECT string_agg(id::text, ', ' ORDER BY id)
    INTO v_sample
    FROM (
      SELECT id
        FROM public.products
       WHERE active IS NULL
          OR stock IS NULL
          OR stock < 0
          OR "reservedStock" IS NULL
          OR "reservedStock" < 0
          OR (
               "variantStock" IS NOT NULL
               AND (
                 jsonb_typeof("variantStock") <> 'object'
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_each_text("variantStock") AS kv(key, value)
                    WHERE btrim(kv.key) = ''
                       OR kv.key <> btrim(kv.key)
                       OR kv.value !~ '^[0-9]+$'
                       OR kv.value::numeric > 1000000
                 )
               )
             )
       ORDER BY id
       LIMIT 20
    ) bad;

  RAISE NOTICE 'ZASHM stock preflight: active_null=%, stock_null=%, stock_negative=%, reserved_null=%, reserved_negative=%, variant_invalid=%',
    v_active_null, v_stock_null, v_stock_negative, v_reserved_null, v_reserved_neg, v_variant_bad;

  IF (v_active_null + v_stock_null + v_stock_negative
      + v_reserved_null + v_reserved_neg + v_variant_bad) > 0 THEN
    RAISE EXCEPTION
      'ZASHM stock hardening aborted: % row(s) would violate the constraints (ids: %). No data was changed. Review section 1c of supabase/stock_hardening_constraints.sql, fix the rows explicitly after a backup, then re-run.',
      v_active_null + v_stock_null + v_stock_negative + v_reserved_null + v_reserved_neg + v_variant_bad,
      COALESCE(v_sample, 'unknown');
  END IF;
END;
$$;

-- ── 1b) VARIANT SHAPE HELPER ─────────────────────────────────────────────────
-- A CHECK constraint cannot contain a subquery, so the per-key validation lives
-- in one IMMUTABLE function. It returns true for NULL (the column stays
-- nullable, matching the DEFAULT '{}' used by every insert path).
CREATE OR REPLACE FUNCTION public.zshm_valid_variant_stock(p_stock jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_stock IS NULL THEN true
    WHEN jsonb_typeof(p_stock) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each_text(p_stock) AS kv(key, value)
       WHERE btrim(kv.key) = ''
          OR kv.key <> btrim(kv.key)
          OR kv.value !~ '^[0-9]+$'
          OR kv.value::numeric > 1000000
    )
  END;
$$;

-- ── 1c) LEGACY DATA (OPT-IN ONLY — never uncomment without owner approval) ───
-- If — and only if — the preflight above reports rows, take a backup first:
--
--   CREATE TABLE public.products_backup_stock_hardening AS
--   SELECT * FROM public.products;
--
-- then review and run the specific statements you actually need:
--
--   -- NULL active means "unknown"; the storefront hides non-active rows.
--   -- UPDATE public.products SET active = false WHERE active IS NULL;
--   --
--   -- UPDATE public.products SET stock = 0 WHERE stock IS NULL;
--
-- There is deliberately NO statement for "reservedStock": the column is unused
-- and is never written by ZASHM. There is deliberately NO statement for
-- "variantStock": orphan or malformed keys are historical data and must be
-- reviewed by the owner, not rewritten by a migration.

-- ── 1d) NOT NULL (idempotent) ────────────────────────────────────────────────
-- SET NOT NULL is a no-op when the column is already NOT NULL, so re-running is
-- safe. The preflight above guarantees there is no NULL left to reject.
ALTER TABLE public.products
  ALTER COLUMN active SET NOT NULL,
  ALTER COLUMN stock SET NOT NULL,
  ALTER COLUMN "reservedStock" SET NOT NULL;

-- ── 1e) CHECK CONSTRAINTS (idempotent, catalog-guarded) ──────────────────────
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Each block adds the constraint
-- only when its name is absent, so a second run is a no-op and never raises
-- "constraint already exists".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname  = 'products_active_boolean'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_active_boolean CHECK (active IN (true, false));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname  = 'products_stock_nonnegative'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_stock_nonnegative CHECK (stock >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname  = 'products_reserved_nonnegative'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_reserved_nonnegative
      CHECK ("reservedStock" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname  = 'products_variant_stock_shape'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_variant_stock_shape
      CHECK (public.zshm_valid_variant_stock("variantStock"));
  END IF;
END;
$$;

-- ── 1f) POST-VERIFY (inside the transaction, before COMMIT) ──────────────────
-- Expected: every "attnotnull" true and all four constraints present.
SELECT a.attname, a.attnotnull AS not_null
  FROM pg_attribute a
 WHERE a.attrelid = 'public.products'::regclass
   AND a.attname IN ('active', 'stock', 'reservedStock', 'variantStock')
 ORDER BY a.attname;

SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
 WHERE c.conrelid = 'public.products'::regclass
   AND c.conname IN (
     'products_active_boolean',
     'products_stock_nonnegative',
     'products_reserved_nonnegative',
     'products_variant_stock_shape'
   )
 ORDER BY c.conname;

COMMIT;

-- ── 2) AFTER COMMIT ──────────────────────────────────────────────────────────
-- Re-run supabase/verify_production_security.sql and keep its output in the
-- release ticket. The storefront path (products_public) is unaffected: the view
-- reads the same rows and none of the constraints change a sellable total.
