-- ─── ZASHM READ-ONLY PRODUCTION/STAGING SCHEMA SNAPSHOT ─────────────────────
-- Purpose: capture a deterministic schema/functions/security snapshot from
--          Supabase Production and Staging for comparison.
--
-- SAFETY:  This file contains ONLY read-only SELECTs. It runs inside
--          `BEGIN READ ONLY` and ends with `ROLLBACK`. It does not create,
--          alter, drop, insert, update, delete, grant, revoke, rotate, or
--          touch customer/order/coupon/product data.
--
-- Usage:   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/schema_snapshot_readonly.sql
--          Run once with a read-only Production connection and once with the
--          Staging connection, saving each stdout to a separate file, then
--          compare with `diff -u staging.txt production.txt`.
--
-- Note:    Supabase may not expose a direct Postgres connection from this
--          environment. Execution is owner-approved and access-gated; this
--          file is prepared only and has NOT been run against Production.

BEGIN READ ONLY;

SET LOCAL search_path = public, pg_temp;

\echo '== identity =='
SELECT current_database() AS database,
       current_user      AS connected_as,
       version()         AS server_version;

\echo '== expected functions =='
WITH expected(name) AS (
  VALUES
    ('atomic_place_order'), ('atomic_adjust_stock'), ('atomic_delete_order'),
    ('atomic_set_order_status'), ('atomic_edit_order'),
    ('zshm_order_signature'), ('zshm_sellable_stock'), ('zshm_order_items'),
    ('zshm_order_lines'), ('zshm_order_skipped_lines'), ('zshm_valid_variant_stock'),
    ('zshm_adjust_coupon_usage'), ('zshm_guard_coupon_delete'),
    ('zshm_protect_last_admin'), ('zshm_rate_limit'),
    ('zshm_storage_policy_scope_is_products'), ('zshm_restore_storage_policies'),
    ('zshm_refresh_product_rating'), ('zshm_product_review_sync_rating'),
    ('handle_new_user_secure')
)
SELECT e.name,
       (p.oid IS NOT NULL) AS present,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
       CASE p.prosecdef WHEN true THEN 'security definer' ELSE 'security invoker' END AS security,
       pg_get_function_result(p.oid) AS returns
FROM expected e
LEFT JOIN pg_proc p
  ON p.pronamespace = 'public'::regnamespace
 AND p.proname = e.name
ORDER BY e.name;

\echo '== expected tables / views / RLS =='
WITH expected(relname, relkind) AS (
  VALUES
    ('products', 'r'), ('products_public', 'v'), ('users', 'r'),
    ('orders', 'r'), ('coupons', 'r'), ('product_reviews', 'r'),
    ('zshm_rate_limits', 'r'), ('zshm_deploy_flags', 'r'),
    ('zshm_storage_policy_backup', 'r')
)
SELECT e.relname,
       e.relkind AS expected_kind,
       c.relkind AS actual_kind,
       (c.oid IS NOT NULL) AS present,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       CASE c.relkind
         WHEN 'r' THEN 'table'
         WHEN 'v' THEN 'view'
         WHEN 'm' THEN 'materialized view'
         ELSE COALESCE(c.relkind::text, '')
       END AS kind
FROM expected e
LEFT JOIN pg_class c
  ON c.relnamespace = 'public'::regnamespace
 AND c.relname = e.relname
ORDER BY e.relname;

\echo '== expected columns =='
WITH expected(tablename, columnname) AS (
  VALUES
    ('products', 'id'), ('products', 'active'), ('products', 'stock'),
    ('products', 'variantStock'), ('products', 'reservedStock'),
    ('products', 'sizes'), ('products', 'colors'), ('products', 'createdAt'),
    ('orders', 'id'), ('orders', 'items'), ('orders', 'status'),
    ('orders', 'total'), ('orders', 'date'), ('orders', 'timestamps'),
    ('orders', 'idempotency_key'),
    ('coupons', 'code'), ('coupons', 'usageCount'), ('coupons', 'active'),
    ('coupons', 'startDate'), ('coupons', 'endDate'), ('coupons', 'usageLimit'),
    ('coupons', 'minOrderAmount'), ('coupons', 'maxDiscount'),
    ('users', 'id'), ('users', 'email'), ('users', 'role'), ('users', 'session_version'),
    ('product_reviews', 'id'), ('product_reviews', 'productId'),
    ('product_reviews', 'rating'), ('product_reviews', 'status'),
    ('product_reviews', 'publishedAt')
)
SELECT e.tablename,
       e.columnname,
       (a.attnum IS NOT NULL AND NOT a.attisdropped) AS present,
       COALESCE(pg_catalog.format_type(a.atttypid, a.atttypmod), '') AS data_type
FROM expected e
LEFT JOIN pg_class c
  ON c.relnamespace = 'public'::regnamespace AND c.relname = e.tablename
LEFT JOIN pg_attribute a
  ON a.attrelid = c.oid AND a.attname = e.columnname
ORDER BY e.tablename, e.columnname;

\echo '== products_public definition =='
SELECT c.relname,
       COALESCE(pg_get_viewdef(c.oid, true), '') AS definition,
       COALESCE(array_to_string(c.reloptions, ', '), '') AS options
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname = 'products_public';

\echo '== RLS policies on protected tables =='
SELECT c.relname AS table_name,
       pol.polname AS policy_name,
       CASE pol.polcmd WHEN 'r' THEN 'select' WHEN 'a' THEN 'insert'
                       WHEN 'w' THEN 'update' WHEN 'd' THEN 'delete'
                       ELSE 'all' END AS command,
       COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') AS using_expr,
       COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS check_expr
FROM pg_class c
JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('products', 'users', 'orders', 'coupons', 'product_reviews',
                    'zshm_rate_limits', 'zshm_deploy_flags')
ORDER BY c.relname, pol.polname;

\echo '== grants on protected relations =='
SELECT c.relname AS table_name,
       grantee.rolname AS grantee,
       STRING_AGG(acl.privilege_type, ',' ORDER BY acl.privilege_type) AS privileges
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) acl
JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('products', 'products_public', 'users', 'orders', 'coupons', 'product_reviews')
  AND grantee.rolname IN ('anon', 'authenticated', 'service_role', 'postgres')
GROUP BY c.relname, grantee.rolname
ORDER BY c.relname, grantee.rolname;

\echo '== order/coupon constraints =='
SELECT conrelid::regclass AS table_name,
       conname AS constraint_name,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND conrelid IN ('public.orders'::regclass, 'public.coupons'::regclass, 'public.products'::regclass)
ORDER BY 1, 2;

\echo '== coupon columns and defaults =='
SELECT column_name,
       data_type,
       is_nullable,
       COALESCE(column_default, '<none>') AS column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'coupons'
ORDER BY column_name;

\echo '== data-shape warnings (read-only) =='
SELECT
  (SELECT COUNT(*) FROM public.products WHERE COALESCE("reservedStock", 0) <> 0) AS nonzero_reserved_stock,
  (SELECT COUNT(*) FROM public.products WHERE COALESCE("reservedStock", 0) < 0) AS negative_reserved_stock,
  (SELECT COUNT(*) FROM public.users) AS admin_user_count,
  (SELECT COUNT(*) FROM public.orders) AS order_count,
  (SELECT COUNT(*) FROM public.coupons) AS coupon_count,
  (SELECT COUNT(*) FROM public.products) AS product_count;

ROLLBACK;
