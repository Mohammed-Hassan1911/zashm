-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · P0-2 · USERS + ORDERS ARE SERVER-ONLY
--
-- Goal: `public.users` and `public.orders` must never be readable or writable
-- with the anon or authenticated Supabase key. The browser uses:
--   * /api/auth/*                 (login, logout, session, profile)
--   * /api/orders                 (guest checkout, tracking)
--   * /api/admin/users            (admin account management)
--   * /api/admin/orders           (admin dashboard)
-- Every one of those routes uses the service-role key. The current frontend
-- bundle contains no direct `from('users')` / `from('orders')` read.
--
-- WHY BOTH GRANTS AND RLS:
--   * RLS with no permissive policy denies every non-bypass role, even if a
--     table privilege still exists.
--   * Revoking the privileges as well means a future accidental permissive
--     policy cannot silently re-open the table.
--   * service_role has BYPASSRLS in Supabase; the transaction aborts if that is
--     not true and service_role is not the owner, so checkout/admin can never
--     be locked out silently.
--
-- HOW TO USE THIS FILE
--   1. Run only SECTION 0 (read-only). Save/print its output.
--   2. Review every policy and every grant shown in SECTION 0.
--   3. Run SECTION 1 only after that review. It is wrapped in a transaction and
--      aborts if service_role does not have BYPASSRLS (and is not the owner).
--   4. Run SECTION 2 to prove the result.
--
-- Apply AFTER the currently deployed API (which already uses service_role for
-- both tables). Apply BEFORE optional Auth signup hardening.
-- Idempotent: safe to run more than once.
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
  AND c.relname IN ('users', 'orders')
ORDER BY c.relname;

-- 0.2 Current policies. Review names, commands and roles before dropping them.
SELECT
  tablename,
  policyname,
  permissive,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('users', 'orders')
ORDER BY tablename, policyname;

-- 0.3 Effective table privileges for the roles PostgREST can use.
--     Expected before the fix: anon/authenticated may be true.
--     Expected after the fix:  anon/authenticated false; service_role true.
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
FROM (VALUES ('users'), ('orders')) AS t(table_name)
CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
ORDER BY t.table_name, r.rolname;

-- 0.4 Raw grants, including PUBLIC (grantee oid = 0).
SELECT
  c.relname AS table_name,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
  a.privilege_type,
  a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE c.oid IN ('public.users'::regclass, 'public.orders'::regclass)
ORDER BY c.relname, grantee, a.privilege_type;

-- 0.5 Column-level grants. REVOKE ALL ON TABLE does not remove these by itself.
SELECT table_name, grantee, column_name, privilege_type, is_grantable
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name IN ('users', 'orders')
ORDER BY table_name, grantee, column_name, privilege_type;

-- 0.6 Role attributes. service_role must have BYPASSRLS for the no-policy model
--     to keep working. If this returns false, STOP: review before running §1.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY rolname;

-- 0.7 Counts only (no customer data). Admins must remain >= 1.
SELECT count(*) FILTER (WHERE role = 'admin') AS admins,
       count(*) FILTER (WHERE role <> 'admin') AS non_admins,
       count(*) AS total_users
FROM public.users;

SELECT count(*) AS total_orders,
       count(*) FILTER (WHERE lower(COALESCE(status, '')) = 'cancelled') AS cancelled_orders
FROM public.orders;

-- 0.8 Objects that could bypass table RLS/grants. Review every row here.
SELECT schemaname, viewname, definition
FROM pg_views
WHERE schemaname = 'public'
  AND (definition ILIKE '%public.users%' OR definition ILIKE '%public.orders%'
       OR definition ILIKE '% users %' OR definition ILIKE '% orders %');

SELECT schemaname, matviewname, definition
FROM pg_matviews
WHERE schemaname = 'public'
  AND (definition ILIKE '%public.users%' OR definition ILIKE '%public.orders%'
       OR definition ILIKE '% users %' OR definition ILIKE '% orders %');

-- 0.9 Foreign keys that reference users/orders. A RESTRICT/CASCADE from another
--     table still works for service_role; this is informational.
SELECT conname, conrelid::regclass AS from_table, confrelid::regclass AS to_table,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE confrelid IN ('public.users'::regclass, 'public.orders'::regclass)
ORDER BY from_table, conname;


-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · CHANGE (RUN ONLY AFTER REVIEWING SECTION 0)
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Fail closed: if service_role cannot bypass RLS and does not own BOTH tables,
-- enabling RLS with no policy would break checkout/admin. Abort instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'service_role' AND rolbypassrls = true
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.users'::regclass
       AND relowner = 'service_role'::regrole
  ) THEN
    RAISE EXCEPTION
      'service_role cannot bypass RLS and does not own public.users; stop and review';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname = 'service_role' AND rolbypassrls = true
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.orders'::regclass
       AND relowner = 'service_role'::regrole
  ) THEN
    RAISE EXCEPTION
      'service_role cannot bypass RLS and does not own public.orders; stop and review';
  END IF;
END $$;

DO $$
DECLARE
  t text;
  p record;
  col record;
  seq text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'orders'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop every policy that can apply to a browser role.
    FOR p IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = t
        AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, t);
    END LOOP;

    -- Revoke table-level privileges from PUBLIC and both browser roles.
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);

    -- Column-level grants survive a table-level REVOKE; remove them explicitly.
    FOR col IN
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t
    LOOP
      EXECUTE format(
        'REVOKE SELECT (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        col.column_name, t);
      EXECUTE format(
        'REVOKE INSERT (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        col.column_name, t);
      EXECUTE format(
        'REVOKE UPDATE (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        col.column_name, t);
      EXECUTE format(
        'REVOKE REFERENCES (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        col.column_name, t);
    END LOOP;

    -- service_role is the only API role that reads/writes these tables:
    --   users  -> login/logout, admin account management, session_version
    --   orders -> checkout INSERT, admin list/update/delete, lifecycle RPCs
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);

    -- Grant sequence privileges only if an id column is backed by a sequence.
    seq := pg_get_serial_sequence(format('public.%I', t), 'id');
    IF seq IS NOT NULL THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
    END IF;
  END LOOP;
END $$;

-- Refresh PostgREST's schema cache after the privilege change.
NOTIFY pgrst, 'reload schema';

COMMIT;


-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · POST-CHECK (READ-ONLY)
-- ══════════════════════════════════════════════════════════════════════════════

-- 2.1 RLS is enabled on both tables.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
WHERE c.oid IN ('public.users'::regclass, 'public.orders'::regclass)
ORDER BY c.relname;

-- 2.2 No policy may target PUBLIC, anon or authenticated. Expected: 0 rows.
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('users', 'orders')
  AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
ORDER BY tablename, policyname;

-- 2.3 Expected: anon/authenticated false for every action; service_role true
--     for SELECT/INSERT/UPDATE/DELETE.
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
FROM (VALUES ('users'), ('orders')) AS t(table_name)
CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
ORDER BY t.table_name, r.rolname;

-- 2.4 No column-level privileges for browser roles. Expected: 0 rows.
SELECT table_name, grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name IN ('users', 'orders')
  AND grantee IN ('PUBLIC', 'anon', 'authenticated')
ORDER BY table_name, grantee, column_name, privilege_type;

-- 2.5 No raw grant to PUBLIC/anon/authenticated. Expected: 0 rows.
SELECT
  c.relname AS table_name,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
  a.privilege_type
FROM pg_class c
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE c.oid IN ('public.users'::regclass, 'public.orders'::regclass)
  AND a.grantee IN (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)
ORDER BY c.relname, grantee, a.privilege_type;

-- 2.6 service_role must still bypass RLS.
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE rolname = 'service_role';

-- 2.7 End-to-end proof from the browser roles. Run each test in its own
--     transaction and expect "permission denied for table users/orders".
--
-- BEGIN;
--   SET LOCAL ROLE anon;
--   SELECT count(*) FROM public.users;
-- ROLLBACK;
--
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT count(*) FROM public.orders;
-- ROLLBACK;
--
-- Service-role proof (expected to succeed):
-- BEGIN;
--   SET LOCAL ROLE service_role;
--   SELECT count(*) FROM public.users;
--   SELECT count(*) FROM public.orders;
-- ROLLBACK;

-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ══════════════════════════════════════════════════════════════════════════════
-- There is no data change in this file. To restore the previous access model
-- (ONLY if a deployed client genuinely needs it):
--
--   ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT ON public.users TO anon, authenticated;
--   GRANT SELECT ON public.orders TO anon, authenticated;
--
-- Prefer rolling back the client instead: direct browser access to users/orders
-- is the vulnerability this migration closes.
