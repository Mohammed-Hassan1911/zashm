-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · REMOVE LEGACY ALLOW-ALL POLICY ON public.products
--
-- Purpose: drop the old `public_read_products` SELECT policy (USING true for
-- anon/authenticated). It is inert after products_public_view.sql Phase 3
-- because browser roles have no table or column SELECT privilege on the base
-- table, but leaving it is a latent exposure if a future grant is restored.
--
-- Apply order: AFTER products_public_view.sql Phase 1 → frontend deploy →
-- Phase 3. No customer/order/product data is touched.
-- Idempotent: DROP POLICY IF EXISTS + a fail-closed prerequisite guard.
-- Rollback: see the commented statement at the end; only use it if Phase 3 is
-- deliberately being reverted.
-- ══════════════════════════════════════════════════════════════════════════════

SET search_path = public, pg_temp;

-- Fail closed: if browser roles can still read the base table, the exposure is
-- broader than this policy. Run products_public_view.sql Phase 3 first.
DO $cleanup$
BEGIN
  IF has_table_privilege('anon', 'public.products', 'SELECT')
     OR has_table_privilege('authenticated', 'public.products', 'SELECT')
     OR has_any_column_privilege('anon', 'public.products', 'SELECT')
     OR has_any_column_privilege('authenticated', 'public.products', 'SELECT') THEN
    RAISE EXCEPTION 'refusing to drop public_read_products: browser roles can still read public.products; apply Phase 3 first';
  END IF;
END
$cleanup$;

DROP POLICY IF EXISTS public_read_products ON public.products;

DO $cleanup$
BEGIN
  RAISE NOTICE 'legacy public_read_products policy removed';
END
$cleanup$;

-- ── Verification (read-only; expect 0 rows and all f) ────────────────────────
SELECT count(*) AS legacy_policy_rows
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename = 'products'
   AND policyname = 'public_read_products';

SELECT has_table_privilege('anon', 'public.products', 'SELECT') AS anon_products_select,
       has_table_privilege('authenticated', 'public.products', 'SELECT') AS auth_products_select,
       has_table_privilege('anon', 'public.products_public', 'SELECT') AS anon_view_select,
       has_table_privilege('service_role', 'public.products', 'SELECT') AS svc_products_select;

-- ── Rollback (do NOT run during normal operation) ───────────────────────────
-- CREATE POLICY public_read_products ON public.products
--   FOR SELECT TO anon, authenticated USING (true);
