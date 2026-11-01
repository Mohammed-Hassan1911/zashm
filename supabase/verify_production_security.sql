-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · READ-ONLY PRODUCTION SECURITY VERIFICATION
--
-- Run this file in the Supabase SQL Editor (or psql) and compare the output
-- with the expected column in docs/production-remediation-handoff.md §5.
-- It changes NOTHING: every statement is a SELECT. It contains no secrets and
-- no customer data (no rows from users, orders or coupons are selected).
--
-- Safe to run more than once, before or after a deployment.
-- ══════════════════════════════════════════════════════════════════════════════

SELECT c.relname,
       pg_get_userbyid(c.relowner) AS owner,
       c.relkind,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('products', 'products_public')
 ORDER BY c.relname;

SELECT pg_get_viewdef('public.products_public'::regclass, true) AS view_definition;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'products_public'
 ORDER BY ordinal_position;

SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name IN ('products', 'products_public')
   AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
 ORDER BY table_name, grantee, privilege_type;

SELECT grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name = 'products'
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
 ORDER BY grantee, column_name, privilege_type;

SELECT has_table_privilege('public', 'public.products', 'SELECT') AS public_can_read_products,
       has_table_privilege('anon', 'public.products', 'SELECT') AS anon_can_read_products,
       has_table_privilege('authenticated', 'public.products', 'SELECT') AS auth_can_read_products,
       has_any_column_privilege('anon', 'public.products', 'SELECT') AS anon_has_column_read,
       has_any_column_privilege('authenticated', 'public.products', 'SELECT') AS auth_has_column_read,
       has_table_privilege('anon', 'public.products_public', 'SELECT') AS anon_can_read_view,
       has_table_privilege('service_role', 'public.products', 'SELECT') AS service_can_read_products;

SELECT n.nspname AS schema,
       c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       count(p.policyname) AS policy_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p
         ON p.schemaname = n.nspname AND p.tablename = c.relname
 WHERE n.nspname = 'public'
   AND c.relname IN ('products', 'products_public', 'orders', 'users', 'coupons')
 GROUP BY n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
 ORDER BY c.relname;

SELECT count(*) FILTER (WHERE active IS TRUE) AS active_products,
       count(*) FILTER (WHERE active IS FALSE) AS inactive_products,
       count(*) FILTER (WHERE active IS NULL) AS null_active_products,
       count(*) AS total_products
  FROM public.products;

SELECT name, set_at, note
  FROM public.zshm_deploy_flags
 ORDER BY name;

SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'users'
   AND column_name = 'session_version';

SELECT id, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
 WHERE id = 'products';

SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'storage'
   AND tablename = 'objects'
   AND (coalesce(qual, '') LIKE '%products%' OR coalesce(with_check, '') LIKE '%products%')
 ORDER BY policyname;

SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       p.proconfig AS settings
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'atomic_place_order', 'atomic_transition_order',
     'zshm_protect_last_admin', 'atomic_claim_coupon'
   )
 ORDER BY p.proname;

SELECT schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
 WHERE schemaname = 'public'
   AND relname IN ('products', 'orders')
 ORDER BY relname, indexrelname;
