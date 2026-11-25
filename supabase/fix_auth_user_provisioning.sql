-- ZASHM · OWNER-RUN PRODUCTION FIX (2026-11-25)
-- Purpose: make auth.users provisioning safe on the live legacy schema.
--  1. Change public.users.role DEFAULT from 'manager' to 'support'.
--  2. Replace handle_new_user() so it explicitly inserts every NOT NULL column,
--     with role='support' and a password hash that can never validate.
-- Scope: one table default + one function definition + PostgREST reload.
--        No existing user, order, product or coupon row is modified.
-- Status: AUTHORED ONLY — not applied from this environment. Owner approved the
--         fix on 2026-11-25 and will run it in the Supabase SQL Editor.
--
-- Paste the whole file and press Run. Stop if the pre-check does not show the
-- legacy function and the 'manager' role default.

-- ══════════════════════════════════════════════════════════════════════════════
-- 0) PRE-CHECK — read only.
-- ══════════════════════════════════════════════════════════════════════════════
SELECT column_name, column_default, is_nullable, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'users'
 ORDER BY ordinal_position;

SELECT pg_get_functiondef('public.handle_new_user'::regproc) AS definition_before;

SELECT p.proacl AS grants_before,
       p.proconfig AS settings_before
  FROM pg_proc p
 WHERE p.proname = 'handle_new_user'
   AND p.pronamespace = 'public'::regnamespace;

-- Expected before the fix: role DEFAULT 'manager'::text; function inserts only
-- (id, email); ACL has no PUBLIC/anon/authenticated EXECUTE; there is no
-- BEFORE INSERT trigger on public.users (confirmed by the owner).

-- ══════════════════════════════════════════════════════════════════════════════
-- 1) FAIL-CLOSED GUARD — aborts before any change if the live object changed.
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_default text;
  v_fn      oid := to_regprocedure('public.handle_new_user()');
  v_src     text;
  v_before_insert int;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'users'
     AND column_name = 'role';

  IF v_default IS DISTINCT FROM '''manager''::text' THEN
    RAISE EXCEPTION 'Expected users.role default manager, found %, refusing to continue', v_default;
  END IF;

  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'Expected public.handle_new_user() is missing';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_fn;
  IF v_src NOT ILIKE '%insert%into%public.users%' AND v_src NOT ILIKE '%insert%into%users%' THEN
    RAISE EXCEPTION 'handle_new_user() no longer matches the reviewed legacy body; refusing to replace it';
  END IF;

  SELECT count(*) INTO v_before_insert
    FROM pg_trigger
   WHERE tgrelid = 'public.users'::regclass
     AND NOT tgisinternal
     AND (tgtype & 6) = 6
     AND (tgenabled = 'O' OR tgenabled = 'D');

  IF v_before_insert > 0 THEN
    RAISE EXCEPTION 'A BEFORE INSERT trigger on public.users appeared; review it before replacing the function';
  END IF;
END
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2) FIX — idempotent. Existing rows keep their current role.
-- ══════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'support';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  -- Phone-only auth users have no e-mail; the staff table requires one.
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  v_name := COALESCE(
    NULLIF(btrim(NEW.raw_user_meta_data ->> 'name'), ''),
    split_part(btrim(NEW.email), '@', 1)
  );

  -- Never overwrite an existing admin/staff row.
  IF EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = NEW.id::text
        OR lower(btrim(u.email)) = lower(btrim(NEW.email))
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.users
    (id, name, email, role, passwordhash, createdate, lastlogin, session_version)
  VALUES
    (NEW.id::text,
     v_name,
     lower(btrim(NEW.email)),
     'support',
     'scrypt$disabled$disabled$disabled$00$00',
     to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     NULL,
     0)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3) VERIFICATION — read only. Expected: single PASS row.
-- ══════════════════════════════════════════════════════════════════════════════
WITH c AS (
  SELECT column_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'users'
     AND column_name = 'role'
),
f AS (
  SELECT p.prosrc, p.prosecdef, p.proconfig, p.proacl
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.handle_new_user()')
),
t AS (
  SELECT count(*) AS auth_triggers,
         count(*) FILTER (
           WHERE tgname = 'on_auth_user_created'
             AND tgenabled = 'O'
             AND NOT tgisinternal
         ) AS legacy_trigger_enabled
    FROM pg_trigger
   WHERE tgrelid = 'auth.users'::regclass
     AND NOT tgisinternal
)
SELECT CASE WHEN (SELECT column_default FROM c) = '''support''::text'
             AND (SELECT count(*) FROM f) = 1
             AND (SELECT bool_and(prosrc ~* '''support''') FROM f)
             AND (SELECT bool_and(prosrc !~* '''manager''') FROM f)
             AND (SELECT bool_and(prosrc !~* '''admin''') FROM f)
             AND (SELECT bool_and(strpos(prosrc, 'scrypt$disabled') > 0) FROM f)
             AND (SELECT bool_and(prosecdef) FROM f)
             AND (SELECT bool_and(proconfig::text LIKE '%search_path=public%pg_temp%') FROM f)
             AND NOT EXISTS (
               SELECT 1
                 FROM f
                 CROSS JOIN LATERAL aclexplode(f.proacl) a
                WHERE a.privilege_type = 'EXECUTE'
                  AND (a.grantee = 0
                       OR a.grantee = to_regrole('anon')
                       OR a.grantee = to_regrole('authenticated'))
             )
             AND (SELECT legacy_trigger_enabled = 1 AND auth_triggers = 1 FROM t)
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       (SELECT column_default FROM c) AS role_default,
       (SELECT proconfig::text FROM f) AS settings,
       (SELECT proacl::text FROM f) AS grants,
       (SELECT legacy_trigger_enabled FROM t) AS legacy_trigger_enabled,
       (SELECT auth_triggers FROM t) AS auth_triggers
;

-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — commented out. Run only with explicit owner approval.
--   ALTER TABLE public.users
--     ALTER COLUMN role SET DEFAULT 'manager';
--
--   CREATE OR REPLACE FUNCTION public.handle_new_user()
--   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
--   SET search_path TO 'public'
--   AS $function$
--   begin
--     insert into public.users (id, email) -- تأكد من أسماء الأعمدة عندك
--     values (new.id, new.email);
--     return new;
--   end;
--   $function$;
--   NOTIFY pgrst, 'reload schema';
-- ══════════════════════════════════════════════════════════════════════════════
