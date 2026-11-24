-- ─── ZASHM STAGING-ONLY SCHEMA PARITY ────────────────────────────────────────
-- Purpose: align Supabase Staging (sfenutmgfawuhmvwkmhv) with the schema
--          surface already verified read-only on Production
--          (ptegprcbtfylqhbnbkih).
--
-- SCOPE:   STAGING ONLY. Never run this file against Production.
--          It changes no customer, order, coupon, product or admin data.
--
-- Safety:  refuses to run unless the known Staging fixture product
--          '9900000000001' exists. Production has no such fixture.
--          Every step is idempotent or guarded, and the whole migration is
--          one transaction. A rollback section is included at the end.
--
-- Usage:   supabase link --project-ref sfenutmgfawuhmvwkmhv
--          supabase db query --linked --file supabase/staging_schema_parity.sql

BEGIN;
SET LOCAL search_path = public, pg_temp;

-- [0] Fail closed if this is not Staging -------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = '9900000000001') THEN
    RAISE EXCEPTION
      'REFUSING: staging fixture product 9900000000001 is absent — not Staging';
  END IF;
END $$;

-- [1] Enable RLS on products, matching Production ---------------------------
-- Preflight confirmed zero policies on products in both projects. Refuse to
-- enable RLS if a browser-role policy exists, because that would change the
-- effective exposure of the base table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
  ) THEN
    RAISE EXCEPTION
      'products has a browser-role RLS policy; review before enabling RLS';
  END IF;
END $$;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- [2] Add products."createdAt" if absent, matching Production exactly ------
DO $$
DECLARE
  v_type    text;
  v_default text;
BEGIN
  SELECT data_type, column_default
    INTO v_type, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products'
     AND column_name = 'createdAt';

  IF NOT FOUND THEN
    ALTER TABLE public.products
      ADD COLUMN "createdAt" timestamptz DEFAULT now();
  ELSIF v_type IS DISTINCT FROM 'timestamp with time zone'
     OR v_default IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION
      'unexpected existing products.createdAt definition: % / %', v_type, v_default;
  END IF;
END $$;

-- [3] Add the coupon-code uniqueness constraint, matching Production -------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.coupons GROUP BY code HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate coupon codes found; refusing to add UNIQUE(code)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_code_key'
  ) THEN
    ALTER TABLE public.coupons
      ADD CONSTRAINT coupons_code_key UNIQUE (code);
  END IF;
END $$;

-- [4] Rebuild products_public with Production's exact column order ---------
-- Preflight confirmed no external dependents (only the view's own composite
-- type and rewrite rule). Refuse to rebuild if that changes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.refobjid = 'public.products_public'::regclass
      AND d.deptype <> 'n'
      AND d.classid NOT IN ('pg_type'::regclass, 'pg_rewrite'::regclass)
  ) THEN
    RAISE EXCEPTION
      'products_public has external dependents; stop and review';
  END IF;
END $$;

DROP VIEW IF EXISTS public.products_public;

CREATE VIEW public.products_public
  WITH (security_barrier = true, security_invoker = false) AS
 SELECT id,
        name,
        price,
        "salePrice",
        category,
        stock,
        image,
        description,
        label,
        rating,
        reviews,
        sku,
        images,
        colors,
        sizes,
        "variantStock",
        "sizeGuide",
        "sizeRanges"
   FROM public.products
  WHERE active IS TRUE;

-- Restore the preflight grants exactly. Supabase default privileges can grant
-- ALL on newly created relations to browser roles, so strip every write
-- privilege from anon/authenticated after the rebuild.
GRANT SELECT ON public.products_public TO anon, authenticated;
GRANT ALL ON public.products_public TO service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.products_public FROM anon, authenticated;

-- [5] Verification (fails the transaction if any invariant is wrong) --------
DO $$
DECLARE
  v_columns text;
  v_options text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
    INTO v_columns
    FROM pg_attribute a
   WHERE a.attrelid = 'public.products_public'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF v_columns IS DISTINCT FROM
     'id,name,price,salePrice,category,stock,image,description,label,rating,reviews,sku,images,colors,sizes,variantStock,sizeGuide,sizeRanges' THEN
    RAISE EXCEPTION 'products_public column order mismatch: %', v_columns;
  END IF;

  SELECT string_agg(o.opt, ', ' ORDER BY o.opt)
    INTO v_options
    FROM pg_class c
    CROSS JOIN LATERAL unnest(c.reloptions) AS o(opt)
   WHERE c.oid = 'public.products_public'::regclass;

  IF v_options IS DISTINCT FROM 'security_barrier=true, security_invoker=false' THEN
    RAISE EXCEPTION 'products_public options mismatch: %', v_options;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.products'::regclass) THEN
    RAISE EXCEPTION 'products RLS is still disabled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_code_key'
  ) THEN
    RAISE EXCEPTION 'coupons_code_key is missing';
  END IF;
END $$;

SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.products'::regclass)
    AS products_rls,
  (SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products'
      AND column_name = 'createdAt') AS created_at_type,
  (SELECT COUNT(*) FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND contype = 'u') AS coupon_unique_constraints,
  (SELECT array_to_string(reloptions, ', ') FROM pg_class
    WHERE oid = 'public.products_public'::regclass) AS view_options,
  (SELECT COUNT(*) FROM public.products) AS product_count,
  (SELECT COUNT(*) FROM public.coupons) AS coupon_count,
  (SELECT COUNT(*) FROM public.users) AS user_count,
  (SELECT COUNT(*) FROM public.orders) AS order_count;

COMMIT;

-- ─── ROLLBACK SECTION (manual, Staging only, do not run on Production) ─────
-- BEGIN;
-- ALTER TABLE public.products DISABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.products DROP COLUMN IF EXISTS "createdAt";
-- ALTER TABLE public.coupons DROP CONSTRAINT IF EXISTS coupons_code_key;
-- DROP VIEW IF EXISTS public.products_public;
-- CREATE VIEW public.products_public
--   WITH (security_barrier = true, security_invoker = false) AS
--  SELECT id, name, category, price, "salePrice", description, stock,
--         "variantStock", sku, label, colors, sizes, images, image,
--         "sizeGuide", "sizeRanges", rating, reviews
--    FROM public.products
--   WHERE active IS TRUE;
-- GRANT SELECT ON public.products_public TO anon, authenticated;
-- GRANT ALL ON public.products_public TO service_role;
-- REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
--   ON public.products_public FROM anon, authenticated;
-- COMMIT;
