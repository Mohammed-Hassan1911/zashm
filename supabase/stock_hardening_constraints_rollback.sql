-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · ROLLBACK FOR supabase/stock_hardening_constraints.sql
--
-- Executable as-is: run this file to undo the four CHECK constraints, the NOT
-- NULL flags and the helper function added by the hardening migration.
--
-- It changes no data. Orphan variantStock keys, stock counters and reservedStock
-- values are left exactly as they are.
--
-- Order matters: the CHECK constraint products_variant_stock_shape depends on
-- public.zshm_valid_variant_stock(jsonb), so every constraint is dropped before
-- the function. DROP ... IF EXISTS keeps a partial rollback re-runnable.
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_temp;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_variant_stock_shape,
  DROP CONSTRAINT IF EXISTS products_reserved_nonnegative,
  DROP CONSTRAINT IF EXISTS products_stock_nonnegative,
  DROP CONSTRAINT IF EXISTS products_active_boolean;

ALTER TABLE public.products
  ALTER COLUMN active DROP NOT NULL,
  ALTER COLUMN stock DROP NOT NULL,
  ALTER COLUMN "reservedStock" DROP NOT NULL;

DROP FUNCTION IF EXISTS public.zshm_valid_variant_stock(jsonb);

-- Post-verify: expect zero rows (no constraint left) and the function gone.
SELECT c.conname
  FROM pg_constraint c
 WHERE c.conrelid = 'public.products'::regclass
   AND c.conname IN (
     'products_active_boolean',
     'products_stock_nonnegative',
     'products_reserved_nonnegative',
     'products_variant_stock_shape'
   );

SELECT to_regprocedure('public.zshm_valid_variant_stock(jsonb)') AS helper_function;

COMMIT;
