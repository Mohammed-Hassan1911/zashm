-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · PRODUCT SIZE RANGES (owner-defined per-size height/weight windows)
--
-- WHY
--   The storefront "Find my size" tool asks the customer for height + weight
--   only (no tape measure) and recommends a size. The most accurate data for
--   that recommendation is the shop owner's own knowledge: for each product and
--   each size, the body height/weight window that size is cut for.
--
-- WHAT
--   1. Adds `public.products."sizeRanges" jsonb NOT NULL DEFAULT '{}'`.
--      Shape: { "M": { "minWeight": 60, "maxWeight": 75,
--                       "minHeight": 165, "maxHeight": 180 } }
--      Missing/null bounds mean "no limit on that side". An empty object means
--      "no owner windows" and the storefront falls back to the published chart.
--   2. Re-creates `public.products_public` with `"sizeRanges"` added to the
--      explicit public allow-list. Without this the browser cannot read the
--      windows and the admin inputs would appear to do nothing.
--
-- SAFETY
--   * Idempotent: safe to re-run.
--   * Additive only: no existing row, column, policy or grant is removed. The
--     default backfills every existing product with `{}`.
--   * The view is rebuilt from the SAME allow-list as
--     supabase/products_public_view.sql (plus "sizeRanges"), so `reservedStock`
--     and other internal columns stay hidden. Fail-closed guards below abort if
--     `reservedStock` ever becomes exposed.
--   * Apply order: run this AFTER supabase/products_public_view.sql (the view
--     must already exist) and BEFORE deploying the frontend that writes the
--     ranges. Nothing breaks if it is applied first, but the admin save will
--     report that the windows were not stored until the column exists.
--
-- ROLLBACK: see the commented block at the end. Rolling back drops the column,
--   which permanently deletes every owner-entered window. Take a backup first.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The column ───────────────────────────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS "sizeRanges" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Only an object is a valid payload. `null` / arrays / scalars are rejected so
-- a bad write can never reach the storefront.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname = 'products_sizeRanges_object_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT "products_sizeRanges_object_chk"
      CHECK (jsonb_typeof("sizeRanges") = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.products."sizeRanges" IS
  'Owner-defined per-size body windows for the storefront size finder: {"M":{"minWeight":60,"maxWeight":75,"minHeight":165,"maxHeight":180}}';

-- ── 2. Re-create the public view with the extended allow-list ───────────────
DROP VIEW IF EXISTS public.products_public;

DO $$
DECLARE
  v_allow   text[] := ARRAY[
    'id', 'name', 'category', 'price', 'salePrice', 'description',
    'stock', 'variantStock', 'sku', 'label',
    'colors', 'sizes', 'images', 'image', 'sizeGuide', 'sizeRanges',
    'rating', 'reviews'
  ];
  v_cols    text;
  v_hidden  text;
BEGIN
  IF 'reservedStock' = ANY (v_allow) THEN
    RAISE EXCEPTION 'products_public allow-list must not contain reservedStock';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
       AND column_name = 'active'
  ) THEN
    RAISE EXCEPTION 'public.products.active is required for the products_public filter';
  END IF;

  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products'
     AND column_name = ANY (v_allow);

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'public.products has none of the allow-listed public columns';
  END IF;

  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
    INTO v_hidden
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products'
     AND NOT (column_name = ANY (v_allow));
  IF v_hidden IS NOT NULL THEN
    RAISE NOTICE 'products_public does not expose these columns (review if intentional): %', v_hidden;
  END IF;

  EXECUTE format(
    'CREATE VIEW public.products_public WITH (security_invoker = false, security_barrier = true) '
    'AS SELECT %s FROM public.products WHERE active IS TRUE',
    v_cols
  );
END $$;

-- Keep the existing owner when the role cannot be changed (SQL Editor default).
DO $$
BEGIN
  EXECUTE 'ALTER VIEW public.products_public OWNER TO postgres';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not change view owner; keeping the current owner';
END $$;

-- ── 3. Grants: SELECT on the view only, for browser roles ───────────────────
REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.products_public TO anon, authenticated;

-- ── 4. Fail-closed verification ─────────────────────────────────────────────
DO $$
DECLARE
  v_allow text[] := ARRAY[
    'id', 'name', 'category', 'price', 'salePrice', 'description',
    'stock', 'variantStock', 'sku', 'label',
    'colors', 'sizes', 'images', 'image', 'sizeGuide', 'sizeRanges',
    'rating', 'reviews'
  ];
  v_bad text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO v_bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products_public'
     AND NOT (column_name = ANY (v_allow));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'products_public exposes non-allow-listed columns: %', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products_public'
       AND column_name = 'sizeRanges'
  ) THEN
    RAISE EXCEPTION 'products_public is missing sizeRanges';
  END IF;

  IF NOT has_table_privilege('anon', 'public.products_public', 'SELECT') THEN
    RAISE EXCEPTION 'anon cannot SELECT products_public after the migration';
  END IF;
END $$;

-- PostgREST caches the schema; reload so the new column is visible at once.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION (read-only; run after applying)
-- ══════════════════════════════════════════════════════════════════════════════
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'products'
--    AND column_name = 'sizeRanges';
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'products_public'
--  ORDER BY ordinal_position;   -- must include sizeRanges, never reservedStock
--
-- SELECT count(*) FILTER (WHERE "sizeRanges" = '{}'::jsonb) AS unconfigured,
--        count(*) FILTER (WHERE "sizeRanges" <> '{}'::jsonb) AS configured
--   FROM public.products;
--
-- -- Storefront read path (anon): must return 200 with a sizeRanges field.
-- SELECT id, "sizeRanges" FROM public.products_public LIMIT 5;

-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK (destructive: permanently deletes every owner-entered window)
-- ══════════════════════════════════════════════════════════════════════════════
-- BEGIN;
--   DROP VIEW IF EXISTS public.products_public;
--   -- Re-create the previous view WITHOUT sizeRanges (same allow-list as before):
--   DO $$
--   DECLARE
--     v_allow text[] := ARRAY[
--       'id', 'name', 'category', 'price', 'salePrice', 'description',
--       'stock', 'variantStock', 'sku', 'label',
--       'colors', 'sizes', 'images', 'image', 'sizeGuide',
--       'rating', 'reviews'
--     ];
--     v_cols text;
--   BEGIN
--     SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
--       INTO v_cols FROM information_schema.columns
--      WHERE table_schema = 'public' AND table_name = 'products'
--        AND column_name = ANY (v_allow);
--     EXECUTE format(
--       'CREATE VIEW public.products_public WITH (security_invoker = false, security_barrier = true) '
--       'AS SELECT %s FROM public.products WHERE active IS TRUE', v_cols);
--   END $$;
--   REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
--   GRANT SELECT ON public.products_public TO anon, authenticated;
--   ALTER TABLE public.products DROP CONSTRAINT IF EXISTS "products_sizeRanges_object_chk";
--   ALTER TABLE public.products DROP COLUMN IF EXISTS "sizeRanges";
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
