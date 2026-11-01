-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · READ-ONLY PRODUCTION SECURITY VERIFICATION
--
-- Run this file in the Supabase SQL Editor (or psql) and compare the output
-- with the expected values in docs/production-remediation-handoff.md §5.
-- It changes NOTHING: every statement is a SELECT. It contains no secrets and
-- no customer data (users/orders/coupons are only counted or inspected through
-- catalog metadata).
--
-- Safe to run more than once, before or after a deployment.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1) Table ownership / RLS state ───────────────────────────────────────────
SELECT c.relname,
       pg_get_userbyid(c.relowner) AS owner,
       c.relkind,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('products', 'products_public', 'users', 'orders', 'coupons')
 ORDER BY c.relname;

-- ── 2) products_public definition and columns ────────────────────────────────
SELECT pg_get_viewdef('public.products_public'::regclass, true) AS view_definition;

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'products_public'
 ORDER BY ordinal_position;

-- ── 3) products / products_public grants ─────────────────────────────────────
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

-- ── 4) RLS state + policy counts for every sensitive table ───────────────────
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

SELECT tablename, policyname, permissive, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('users', 'orders', 'coupons')
 ORDER BY tablename, policyname;

-- ── 5) users / orders / coupons grants (expected: anon/auth false) ───────────
SELECT
  t.table_name,
  r.rolname AS role_name,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'SELECT')     AS can_select,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'INSERT')     AS can_insert,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'UPDATE')     AS can_update,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'DELETE')     AS can_delete,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'TRUNCATE')   AS can_truncate,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'REFERENCES') AS can_references,
  has_table_privilege(r.rolname, format('public.%I', t.table_name), 'TRIGGER')    AS can_trigger
FROM (VALUES ('users'), ('orders'), ('coupons')) AS t(table_name)
CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
ORDER BY t.table_name, r.rolname;

SELECT table_name, grantee, column_name, privilege_type
  FROM information_schema.column_privileges
 WHERE table_schema = 'public'
   AND table_name IN ('users', 'orders', 'coupons')
   AND grantee IN ('PUBLIC', 'anon', 'authenticated')
 ORDER BY table_name, grantee, column_name, privilege_type;

-- ── 6) Data shape (counts only — no customer PII) ────────────────────────────
SELECT count(*) FILTER (WHERE active IS TRUE) AS active_products,
       count(*) FILTER (WHERE active IS FALSE) AS inactive_products,
       count(*) FILTER (WHERE active IS NULL) AS null_active_products,
       count(*) AS total_products
  FROM public.products;

SELECT count(*) FILTER (WHERE "reservedStock" IS NOT NULL AND "reservedStock" <> 0) AS nonzero_reserved_stock,
       count(*) AS total_products
  FROM public.products;

SELECT count(*) FILTER (WHERE role = 'admin') AS admins,
       count(*) FILTER (WHERE role <> 'admin') AS non_admins,
       count(*) AS total_users
  FROM public.users;

SELECT count(*) AS total_orders,
       count(*) FILTER (WHERE lower(COALESCE(status, '')) = 'cancelled') AS cancelled_orders
  FROM public.orders;

SELECT count(*) AS total_coupons,
       count(*) FILTER (WHERE active IS TRUE) AS active_coupons
  FROM public.coupons;

-- ── 7) Deploy flags ──────────────────────────────────────────────────────────
SELECT name, set_at, note
  FROM public.zshm_deploy_flags
 ORDER BY name;

-- ── 8) Session revocation column ─────────────────────────────────────────────
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'users'
   AND column_name = 'session_version';

-- ── 9) Storage bucket + product-scoped policies ──────────────────────────────
SELECT id, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
 WHERE id = 'products';

SELECT policyname, cmd, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'storage'
   AND tablename = 'objects'
   AND (coalesce(qual, '') LIKE '%products%' OR coalesce(with_check, '') LIKE '%products%')
 ORDER BY policyname;

-- ── 10) Functions (exact deployed names) ─────────────────────────────────────
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       p.proconfig AS settings
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'atomic_place_order',
     'atomic_adjust_stock',
     'atomic_set_order_status',
     'atomic_delete_order',
     'zshm_adjust_coupon_usage',
     'zshm_order_signature',
     'zshm_order_items',
     'zshm_order_lines',
     'zshm_order_skipped_lines',
     'zshm_protect_last_admin',
     'zshm_guard_coupon_delete'
   )
 ORDER BY p.proname;

-- ── 11) Triggers that enforce invariants ─────────────────────────────────────
SELECT tgname, tgrelid::regclass AS table_name, tgenabled
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname IN ('zshm_protect_last_admin', 'zshm_guard_coupon_delete')
 ORDER BY tgname;

-- ── 12) Index usage ──────────────────────────────────────────────────────────
SELECT schemaname, relname AS table_name, indexrelname AS index_name,
       idx_scan, idx_tup_read, idx_tup_fetch
  FROM pg_stat_user_indexes
 WHERE schemaname = 'public'
   AND relname IN ('products', 'orders')
 ORDER BY relname, indexrelname;
