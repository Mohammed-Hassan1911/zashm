-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · P0-1 · COUPONS ARE SERVER-ONLY
--
-- Goal: `public.coupons` must never be readable or writable with the anon or
-- authenticated Supabase key. The storefront validates a code through
-- POST /api/coupons/validate; the admin console lists/manages coupons through
-- /api/admin/coupons. Both server routes use the service-role key.
--
-- HOW TO USE THIS FILE
--   1. Run only SECTION 0 (read-only). Save/print its output.
--   2. Review every policy and every grant shown in SECTION 0.
--   3. Run SECTION 1 only after that review. It is wrapped in a transaction and
--      aborts if service_role does not have BYPASSRLS.
--   4. Run SECTION 2 to prove the result.
--
-- DO NOT run SECTION 1 against production until the code from this change set is
-- deployed and the admin console has been checked against /api/admin/coupons.
-- DO NOT re-open `coupons` to anon/authenticated to make an old bundle work.
-- ══════════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 0 · PRE-CHECK (READ-ONLY — safe to run)
-- ══════════════════════════════════════════════════════════════════════════════

-- 0.1 Table ownership, RLS state and raw ACL.
SELECT
  n.nspname                         AS schema_name,
  c.relname                         AS table_name,
  c.relowner::regrole               AS owner,
  c.relrowsecurity                  AS rls_enabled,
  c.relforcerowsecurity             AS force_rls,
  c.relacl                          AS raw_acl
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'coupons';

-- 0.2 Current policies. Review names, commands and roles before dropping them.
SELECT
  policyname,
  permissive,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'coupons'
ORDER BY policyname;

-- 0.3 Effective table privileges for the roles PostgREST can use.
--     true means the role can perform the action (directly, via PUBLIC, or via
--     an inherited role). Expected before the fix: anon/authenticated may be true.
SELECT
  r.rolname AS role_name,
  has_table_privilege(r.rolname, 'public.coupons', 'SELECT')     AS can_select,
  has_table_privilege(r.rolname, 'public.coupons', 'INSERT')     AS can_insert,
  has_table_privilege(r.rolname, 'public.coupons', 'UPDATE')     AS can_update,
  has_table_privilege(r.rolname, 'public.coupons', 'DELETE')     AS can_delete,
  has_table_privilege(r.rolname, 'public.coupons', 'TRUNCATE')   AS can_truncate,
  has_table_privilege(r.rolname, 'public.coupons', 'REFERENCES') AS can_references,
  has_table_privilege(r.rolname, 'public.coupons', 'TRIGGER')    AS can_trigger
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
ORDER BY r.rolname;

-- 0.4 Raw grants, including PUBLIC (grantee oid = 0). This is the only reliable
--     way to see a grant made to PUBLIC rather than to a named role.
SELECT
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
  a.privilege_type,
  a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE c.oid = 'public.coupons'::regclass
ORDER BY grantee, a.privilege_type;

-- 0.5 Column-level grants. REVOKE ALL ON TABLE does not remove these by itself.
SELECT grantee, column_name, privilege_type, is_grantable
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'coupons'
ORDER BY grantee, column_name, privilege_type;

-- 0.6 Role attributes. service_role must have BYPASSRLS for the no-policy model
--     to keep working. If this returns false, STOP: review before running §1.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY rolname;

-- 0.7 Columns, constraints and indexes. This also catches the known
--     security_hardening.sql index issue (it references start_date/end_date,
--     while the application uses "startDate"/"endDate").
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'coupons'
ORDER BY ordinal_position;

SELECT conname, contype, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.coupons'::regclass
ORDER BY conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'coupons'
ORDER BY indexname;

-- 0.8 Duplicate codes would make .maybeSingle() fail with a 500 in both
--     api/orders.js and api/coupons/validate.js. Expected: 0 rows.
SELECT code, count(*) AS rows
FROM public.coupons
GROUP BY code
HAVING count(*) > 1;

-- 0.9 Sequences used by the table (if any).
SELECT pg_get_serial_sequence('public.coupons', 'id') AS id_sequence;

-- 0.10 Other objects that could bypass table RLS/grants. Review any row here.
SELECT schemaname, viewname, definition
FROM pg_views
WHERE schemaname = 'public'
  AND definition ILIKE '%coupons%';

SELECT schemaname, matviewname, definition
FROM pg_matviews
WHERE schemaname = 'public'
  AND definition ILIKE '%coupons%';

SELECT
  p.proname,
  p.prosecdef AS security_definer,
  p.proacl,
  left(p.prosrc, 300) AS body_preview
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosrc ILIKE '%coupons%'
ORDER BY p.proname;

-- 0.11 RPCs used by the order flow must be executable by service_role only.
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'atomic_place_order',
    'zshm_adjust_coupon_usage',
    'atomic_adjust_stock',
    'zshm_order_signature'
  )
ORDER BY p.proname;


-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · CHANGE (RUN ONLY AFTER REVIEWING SECTION 0)
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Fail closed: if service_role cannot bypass RLS (and is not the table owner),
-- enabling RLS with no policy would break api/orders.js and the admin API.
-- Abort instead of guessing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'service_role'
      AND rolbypassrls = true
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_class
    WHERE oid = 'public.coupons'::regclass
      AND relowner = 'service_role'::regrole
  ) THEN
    RAISE EXCEPTION
      'service_role cannot bypass RLS and does not own public.coupons; stop and review';
  END IF;
END $$;

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

-- Drop policies that can apply to PUBLIC, anon or authenticated. Policies that
-- target only service_role (or other internal roles) are left in place: they
-- cannot expose the table through the anon/authenticated PostgREST roles.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'coupons'
      AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.coupons', p.policyname);
  END LOOP;
END $$;

-- Revoke table-level privileges from PUBLIC and from both browser roles.
REVOKE ALL PRIVILEGES ON TABLE public.coupons
  FROM PUBLIC, anon, authenticated;

-- Revoke any lingering column-level privileges. These survive a table-level
-- REVOKE in PostgreSQL, so handle them explicitly.
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'coupons'
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%I) ON TABLE public.coupons FROM PUBLIC, anon, authenticated',
      col.column_name
    );
    EXECUTE format(
      'REVOKE INSERT (%I) ON TABLE public.coupons FROM PUBLIC, anon, authenticated',
      col.column_name
    );
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE public.coupons FROM PUBLIC, anon, authenticated',
      col.column_name
    );
    EXECUTE format(
      'REVOKE REFERENCES (%I) ON TABLE public.coupons FROM PUBLIC, anon, authenticated',
      col.column_name
    );
  END LOOP;
END $$;

-- service_role is the only API role that reads/writes this table. Keep all four
-- DML privileges: api/orders.js SELECTs, api/admin/coupons.js SELECT/INSERT/
-- UPDATE/DELETE, and the order RPCs UPDATE the usage counter.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.coupons
  TO service_role;

-- Grant sequence privileges only if the id column is backed by a sequence.
DO $$
DECLARE
  seq text;
BEGIN
  seq := pg_get_serial_sequence('public.coupons', 'id');
  IF seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
  END IF;
END $$;

-- Refresh PostgREST's schema cache after the privilege change.
NOTIFY pgrst, 'reload schema';

COMMIT;


-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · POST-CHECK (READ-ONLY)
-- ══════════════════════════════════════════════════════════════════════════════

-- 2.1 RLS is enabled. force_rls is expected to stay false so the table owner
--     (postgres/supabase_admin) can still perform maintenance.
SELECT
  c.relrowsecurity      AS rls_enabled,
  c.relforcerowsecurity AS force_rls
FROM pg_class c
WHERE c.oid = 'public.coupons'::regclass;

-- 2.2 No policy may target PUBLIC, anon or authenticated. Expected: 0 rows.
SELECT policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'coupons'
  AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
ORDER BY policyname;

-- 2.3 Expected: anon/authenticated false for every column; service_role true
--     for SELECT/INSERT/UPDATE/DELETE.
SELECT
  r.rolname AS role_name,
  has_table_privilege(r.rolname, 'public.coupons', 'SELECT')     AS can_select,
  has_table_privilege(r.rolname, 'public.coupons', 'INSERT')     AS can_insert,
  has_table_privilege(r.rolname, 'public.coupons', 'UPDATE')     AS can_update,
  has_table_privilege(r.rolname, 'public.coupons', 'DELETE')     AS can_delete,
  has_table_privilege(r.rolname, 'public.coupons', 'TRUNCATE')   AS can_truncate,
  has_table_privilege(r.rolname, 'public.coupons', 'REFERENCES') AS can_references,
  has_table_privilege(r.rolname, 'public.coupons', 'TRIGGER')    AS can_trigger
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
ORDER BY r.rolname;

-- 2.4 No column-level SELECT/INSERT/UPDATE/REFERENCES for browser roles.
SELECT grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'coupons'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY grantee, column_name, privilege_type;

-- 2.5 No raw grant to PUBLIC/anon/authenticated. Expected: 0 rows.
SELECT
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
  a.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE c.oid = 'public.coupons'::regclass
  AND a.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
ORDER BY grantee, a.privilege_type;

-- 2.6 service_role must still bypass RLS.
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE rolname = 'service_role';

-- 2.7 Function privileges must remain false/false/true.
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'atomic_place_order',
    'zshm_adjust_coupon_usage',
    'atomic_adjust_stock',
    'zshm_order_signature'
  )
ORDER BY p.proname;

-- 2.8 End-to-end proof from the browser role. Run each test in its own
--     transaction and expect "permission denied for table coupons".
--     (The exact error text depends on the PostgreSQL version.)
--
-- BEGIN;
--   SET LOCAL ROLE anon;
--   SELECT count(*) FROM public.coupons;
-- ROLLBACK;
--
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT count(*) FROM public.coupons;
-- ROLLBACK;
--
-- Service-role proof (expected to succeed):
-- BEGIN;
--   SET LOCAL ROLE service_role;
--   SELECT count(*) FROM public.coupons;
-- ROLLBACK;
