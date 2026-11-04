-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · STAGED MIGRATION 2 OF 2 · DECLARED-ONLY STOCK RECOMPUTE
-- File: supabase/declared_only_stock_recompute.sql
-- Status: NOT APPLIED. Nothing in this repository has executed it. It is applied
--         only by the owner, in the Supabase SQL Editor, with explicit approval
--         (owner decision 1أ, 2026-11-04).
--
-- WHAT IT FIXES
--   products.stock has TWO writers: atomic_place_order() (a new purchase) and
--   atomic_adjust_stock() (cancel / un-cancel / delete). Both rewrote it as the
--   sum of EVERY variantStock key, orphaned keys included, while the admin panel
--   writes the sum of the DECLARED size × colour combinations only
--   (totalFor() in src/pages/AdminApp.js). The two rules disagree, so the first
--   sale of a product with orphans pushed stock back up:
--
--     Jacket Boxy, measured on a disposable PostgreSQL 17 cluster with the
--     production numbers (stock 18, declared pool 18, orphans 8):
--       buy 1 declared unit   stock 18 -> 25   (declared pool is 17)
--       buy 3 declared units  stock 25 -> 23   (declared pool is 14)
--       cancel one of them    stock 23 -> 24
--       restore an orphan key stock 24 -> 27   while only 18 can be sold
--
--   After this change the same sequence gives 18 -> 17 -> 14 -> 15 and the orphan
--   restore leaves the sellable counter where it was. Migration 1 of 2 already
--   applied the identical rule to atomic_place_order().
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It never deletes, zeroes or moves a variantStock key. Orphan quantities
--     stay in the row; they are only excluded from the sellable total
--     (owner decision 2ج: leave them, show a warning in the admin panel).
--   * Legacy products (a variant pool with no declared sizes/colors) keep the
--     old all-keys sum through the fallback inside zshm_sellable_stock(), so
--     restoring or re-deducting their historical orders changes nothing.
--   * Products with no variant pool at all are untouched: the global counter is
--     still incremented/decremented directly.
--   * No order row is modified, and no product row is rewritten by this file on
--     its own — stock only moves when the lifecycle functions run.
--
-- Apply AFTER supabase/reject_undefined_variants.sql, which creates
-- public.zshm_sellable_stock() (required below).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PRE-APPLY CHECKS (READ-ONLY — run these first and keep the output) ──────

-- 0a. The dependency. This MUST return the function, otherwise apply
--     supabase/reject_undefined_variants.sql first.
SELECT proname, pg_get_function_arguments(oid) AS arguments
  FROM pg_proc
 WHERE proname = 'zshm_sellable_stock';

-- 0b. Where the stored stock and the sellable pool disagree right now. This is
--     the drift this migration stops. Expect 1793739505270547 with 8 orphan
--     units; the row is NOT rewritten here, only on the next lifecycle call.
--     The expressions mirror zshm_sellable_stock() (both branches).
WITH variant_products AS (
  SELECT p.id, p.name, p.active, p.stock, p.sizes, p.colors, p."variantStock"
    FROM public.products p
   WHERE jsonb_typeof(p."variantStock") = 'object'
     AND p."variantStock" <> '{}'::jsonb
     AND jsonb_typeof(p.sizes)  = 'array' AND jsonb_array_length(p.sizes)  > 0
     AND jsonb_typeof(p.colors) = 'array' AND jsonb_array_length(p.colors) > 0
)
SELECT v.id, v.name, v.active, v.stock AS stored_stock,
       s.sellable_stock, k.all_keys_stock,
       COALESCE(v.stock, 0) - s.sellable_stock AS drift_units
  FROM variant_products v
  JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(
             CASE WHEN (v."variantStock" ->> (sz.value || '-' || co.value)) ~ '^-?[0-9]+$'
                  THEN (v."variantStock" ->> (sz.value || '-' || co.value))::integer
                  ELSE 0 END, 0))::integer, 0) AS sellable_stock
      -- DISTINCT mirrors zshm_sellable_stock(): duplicated legacy option lines
      -- must not count the same combination twice.
      FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(v.sizes))  AS sz(value)
     CROSS JOIN (SELECT DISTINCT value FROM jsonb_array_elements_text(v.colors)) AS co(value)
  ) s ON TRUE
  JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(
             CASE WHEN kv.value ~ '^-?[0-9]+$' THEN kv.value::integer ELSE 0 END,
             0))::integer, 0) AS all_keys_stock
      FROM jsonb_each_text(v."variantStock") AS kv(key, value)
  ) k ON TRUE
 WHERE v.stock IS DISTINCT FROM s.sellable_stock
 ORDER BY v.id;

-- 0c. The live definition — this output IS the rollback copy.
SELECT pg_get_functiondef(oid) AS definition
  FROM pg_proc
 WHERE proname = 'atomic_adjust_stock';

-- ── 1) BACKUP ──────────────────────────────────────────────────────────────────
-- Keep the 0c output (function body) and the 0b result (stock before-image) in
-- the release ticket. This file changes no data; the numbers only move when the
-- lifecycle functions run for a real order.

-- ── 1b) DEPENDENCY GUARD (fails loudly BEFORE anything is replaced) ────────────
DO $$
BEGIN
  IF to_regprocedure('public.zshm_sellable_stock(jsonb, jsonb, jsonb)') IS NULL THEN
    RAISE EXCEPTION
      'apply supabase/reject_undefined_variants.sql first: public.zshm_sellable_stock() is missing';
  END IF;
END;
$$;

-- ── 2) ATOMIC STOCK ADJUSTMENT ─────────────────────────────────────────────────
-- Verbatim copy of section 4 of supabase/atomic_place_order.sql (REVISION 10).
-- It MUST stay byte-identical — scripts/test-undefined-variant.mjs compares the
-- two on every npm test run. CREATE OR REPLACE, so re-running is safe.


CREATE OR REPLACE FUNCTION public.atomic_adjust_stock(
  p_lines jsonb,
  p_delta integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line RECORD;
  v_prod public.products%ROWTYPE;
  v_id bigint;
  v_var jsonb;
  v_total_qty integer;
  v_has_variants boolean;
  v_available integer;
  v_touched boolean;
  v_restored integer := 0;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  -- Validate the payload. Type, length and line checks are separate statements
  -- so a non-array can never reach jsonb_array_length() or a cast.
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_delta IS NULL OR p_delta NOT IN (-1, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS it
     WHERE jsonb_typeof(it) <> 'object'
        OR COALESCE(it ->> 'productId', '') !~ '^[1-9][0-9]{0,17}$'
        OR COALESCE(it ->> 'qty', '') !~ '^[1-9][0-9]{0,8}$'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_line');
  END IF;

  -- Lock all products in deterministic order. A product that no longer exists
  -- is a HARD error when deducting (p_delta = -1): an order must never silently
  -- lose stock. On restore (p_delta = +1) it is skipped and reported, so the
  -- remaining, still-existing lines can be restored. This is the partial-restore
  -- contract used by cancellation and order deletion.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    ORDER BY 1
  LOOP
    PERFORM 1
    FROM public.products
    WHERE id = v_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF p_delta = 1 THEN
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
          'code', 'missing_product',
          'reason', 'missing_product',
          'productId', v_id
        ));
      ELSE
        RETURN jsonb_build_object(
          'ok', false,
          'reason', 'missing_product',
          'productId', v_id
        );
      END IF;
    END IF;
  END LOOP;

  -- Preflight: validate ALL requested stock changes before updating ANY row.
  -- Only products that still exist are examined; the missing ones were handled
  -- above (restore: warning, deduct: returned). This keeps the "validate
  -- everything, then write" guarantee for every row that will be touched.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    WHERE EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (it ->> 'productId')::bigint
    )
    ORDER BY 1
  LOOP
    SELECT * INTO v_prod
    FROM public.products
    WHERE id = v_id;

    v_has_variants :=
      v_prod."variantStock" IS NOT NULL
      AND jsonb_typeof(v_prod."variantStock") = 'object'
      AND v_prod."variantStock" <> '{}'::jsonb;

    IF v_has_variants THEN
      FOR v_line IN
        SELECT
          COALESCE(it ->> 'size', '') || '-' ||
          COALESCE(it ->> 'color', '') AS vkey,
          SUM((it ->> 'qty')::integer)::integer AS qty
        FROM jsonb_array_elements(p_lines) AS it
        WHERE (it ->> 'productId')::bigint = v_id
        GROUP BY 1
        ORDER BY 1
      LOOP
        IF v_line.vkey IN ('', '-')
           OR NOT (v_prod."variantStock" ? v_line.vkey) THEN
          -- Restoring a variant that no longer exists must not resurrect it or
          -- block the whole restore; report it and skip that line. Deduction
          -- stays strict: selling a vanished variant is a real error.
          IF p_delta = 1 THEN
            v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
              'code', 'missing_variant',
              'reason', 'missing_variant',
              'productId', v_id,
              'variant', v_line.vkey
            ));
            CONTINUE;
          END IF;
          RETURN jsonb_build_object(
            'ok', false,
            'reason', 'missing_variant',
            'productId', v_id,
            'variant', v_line.vkey
          );
        END IF;

        -- A negative delta means stock is being deducted.
        IF p_delta = -1 THEN
          v_available :=
            COALESCE((v_prod."variantStock" ->> v_line.vkey)::integer, 0);
          IF v_line.qty > v_available THEN
            RETURN jsonb_build_object(
              'ok', false,
              'reason', 'unavailable',
              'productId', v_id,
              'variant', v_line.vkey,
              'available', v_available,
              'requested', v_line.qty
            );
          END IF;
        END IF;
      END LOOP;

    ELSE
      -- Products without variants: ALL lines compete for the same global
      -- stock, so aggregate them before comparing exactly once.
      SELECT COALESCE(SUM((it ->> 'qty')::integer), 0)::integer
        INTO v_total_qty
        FROM jsonb_array_elements(p_lines) AS it
       WHERE (it ->> 'productId')::bigint = v_id;

      IF p_delta = -1 THEN
        v_available := COALESCE(v_prod.stock, 0);
        IF v_total_qty > v_available THEN
          RETURN jsonb_build_object(
            'ok', false,
            'reason', 'unavailable',
            'productId', v_id,
            'available', v_available,
            'requested', v_total_qty
          );
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- All lines passed validation. Apply the changes, skipping the missing
  -- products/variants that were reported above (restore only).
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    WHERE EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (it ->> 'productId')::bigint
    )
    ORDER BY 1
  LOOP
    SELECT * INTO v_prod
    FROM public.products
    WHERE id = v_id;

    v_var := v_prod."variantStock";
    v_has_variants :=
      v_var IS NOT NULL
      AND jsonb_typeof(v_var) = 'object'
      AND v_var <> '{}'::jsonb;

    SELECT COALESCE(SUM((it ->> 'qty')::integer), 0)::integer
    INTO v_total_qty
    FROM jsonb_array_elements(p_lines) AS it
    WHERE (it ->> 'productId')::bigint = v_id;

    v_touched := false;
    IF v_has_variants THEN
      FOR v_line IN
        SELECT
          COALESCE(it ->> 'size', '') || '-' ||
          COALESCE(it ->> 'color', '') AS vkey,
          SUM((it ->> 'qty')::integer)::integer AS qty
        FROM jsonb_array_elements(p_lines) AS it
        WHERE (it ->> 'productId')::bigint = v_id
        GROUP BY 1
        ORDER BY 1
      LOOP
        -- Missing variant on a restore: already reported by the preflight.
        IF v_line.vkey IN ('', '-')
           OR NOT (v_var ? v_line.vkey) THEN
          CONTINUE;
        END IF;
        v_var := jsonb_set(
          v_var,
          ARRAY[v_line.vkey],
          to_jsonb(
            COALESCE((v_var ->> v_line.vkey)::integer, 0)
            + (p_delta * v_line.qty)
          )
        );
        v_touched := true;
        v_restored := v_restored + 1;
      END LOOP;

      -- Invariant: global stock equals the SELLABLE variant stock (§2b) — the
      -- same rule atomic_place_order() uses, so cancelling an order cannot push
      -- stock back above the declared pool. Only write when at least one existing
      -- variant was actually adjusted.
      IF v_touched THEN
        UPDATE public.products
        SET
          "variantStock" = v_var,
          stock = public.zshm_sellable_stock(v_var, v_prod.sizes, v_prod.colors)
        WHERE id = v_id;
      END IF;

    ELSE
      UPDATE public.products
      SET stock = GREATEST(COALESCE(stock, 0) + (p_delta * v_total_qty), 0)
      WHERE id = v_id;
      v_restored := v_restored + 1;
    END IF;
  END LOOP;

  -- `restored` = number of product groups actually adjusted. Callers use
  -- restored > 0 to decide stockRestored; warnings explain what was skipped.
  RETURN jsonb_build_object('ok', true,
                            'restored', v_restored,
                            'warnings', v_warnings);
END;
$$;

-- ── 3) PRIVILEGES ──────────────────────────────────────────────────────────────
-- Identical to section 5 of the canonical file; re-asserted so this migration is
-- complete on its own.
REVOKE ALL ON FUNCTION public.atomic_adjust_stock(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_adjust_stock(jsonb, integer) TO service_role;

-- ── 4) POST-APPLY VERIFICATION (READ-ONLY unless you run the probe) ────────────
-- SELECT proname FROM pg_proc
--  WHERE proname IN ('atomic_adjust_stock', 'zshm_sellable_stock', 'atomic_place_order');
--
-- SELECT has_function_privilege('anon', 'public.atomic_adjust_stock(jsonb, integer)', 'EXECUTE') AS anon_can,
--        has_function_privilege('service_role', 'public.atomic_adjust_stock(jsonb, integer)', 'EXECUTE') AS svc_can;

-- 4a. Behavioural probe — a declared restore and an orphan restore on ONE
--     product, inside a transaction that is ROLLED BACK. Substitute the product
--     id of a test/staging row (never a production row):
-- BEGIN;
--   SELECT public.atomic_adjust_stock('[{"productId":1,"qty":1,"size":"M","color":"Black"}]'::jsonb,  1);
--   SELECT stock, "variantStock" FROM public.products WHERE id = 1;   -- stock +1 (declared key)
--   SELECT public.atomic_adjust_stock('[{"productId":1,"qty":1,"size":"M","color":"White"}]'::jsonb, 1);
--   SELECT stock, "variantStock" FROM public.products WHERE id = 1;   -- orphan key +1, stock UNCHANGED
-- ROLLBACK;
-- On Production, run only the read-only checks above; the behaviour is already
-- proven by scripts/test-sql-concurrency.mjs sections [3l] and [3m].

-- ── 5) DEPLOYMENT ORDER ────────────────────────────────────────────────────────
--   1. run checks 0a–0c and keep the output,
--   2. apply supabase/reject_undefined_variants.sql (helper + atomic_place_order),
--   3. apply THIS file (atomic_adjust_stock),
--   4. deploy api/orders.js and the storefront build,
--   5. re-run section 4 verification, then reconcile the Jacket Boxy orphans in
--      the admin panel whenever the owner decides (no SQL needed).
-- Applying this file WITHOUT migration 1 raises a hard error at section 1b,
-- before any definition is replaced, so the order cannot be silently reversed.

-- ── 6) ROLLBACK POLICY ─────────────────────────────────────────────────────────
-- Paste the 0c output back in the SQL editor (CREATE OR REPLACE of the previous
-- definition). Stock values that were already rewritten stay as they are; if the
-- owner needs the previous numbers, restore them from the 0b before-image with a
-- reviewed UPDATE of the specific product rows — never a blanket recalculation.
-- Do not drop zshm_sellable_stock() while atomic_place_order() still calls it.
