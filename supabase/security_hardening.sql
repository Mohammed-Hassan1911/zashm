-- ─────────────────────────────────────────────────────────────────────────────
-- ZASHM · DATABASE SECURITY HARDENING (run once in Supabase SQL Editor)
--
-- The JavaScript/API layer now talks to the database with the SERVICE ROLE key
-- (server-side only). The anon key is only used for PUBLIC reads
-- (products_public after supabase/products_public_view.sql).
-- Coupons are server-only now: the storefront validates a code through
-- POST /api/coupons/validate, and the console lists them through the
-- authenticated /api/admin/coupons. Rows that must never be readable by the
-- anon key: users(passwordhash), orders(PII), coupons(codes/usage). The exact
-- coupons REVOKE/RLS statements and their pre/post checks live in
-- supabase/coupons_lockdown.sql. Confirm below — do not reopen RLS on any of
-- these tables.
--
-- REVISION 2 — auth.users trigger safety:
--   * all existing triggers on auth.users are inspected before anything is
--     created (the read-only query in §2 prints them);
--   * if ANY existing trigger already provisions public.users (by function
--     name or by an INSERT INTO public.users in its source), this migration
--     REFUSES to add a second one and asks for manual review;
--   * an existing trigger is never dropped or replaced here;
--   * the duplicate last-admin function that used to live in this file has
--     been removed; supabase/admin_protection.sql is the single owner.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) VERIFY CURRENT RLS STATE ─────────────────────────────────────────────────
-- Expected output: products_public is the only storefront-readable relation;
-- coupons, users and orders have no anon/authenticated read policy. The second
-- query below shows whether RLS is enabled for each table (pg_policies has no
-- is_enabled column).
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT
  relname AS tablename,
  relrowsecurity AS rls_enabled,
  relforcerowsecurity AS force_rls
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('products', 'products_public', 'coupons', 'orders', 'users')
ORDER BY relname;

-- 2) INSPECT ALL TRIGGERS ON auth.users BEFORE CREATING ANYTHING ─────────────
-- READ-ONLY. Run this first and keep the output. It lists every non-internal
-- trigger, its function and its full definition. Do not skip this step: an old
-- Supabase template trigger (`on_auth_user_created` → `public.handle_new_user`)
-- may already do exactly the job below.
SELECT
  t.tgname                              AS trigger_name,
  t.tgenabled                           AS enabled,
  fn.nspname || '.' || p.proname         AS function_name,
  pg_get_triggerdef(t.oid)              AS trigger_definition
FROM pg_trigger t
JOIN pg_class c     ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p      ON p.oid = t.tgfoid
JOIN pg_namespace fn ON fn.oid = p.pronamespace
WHERE n.nspname = 'auth'
  AND c.relname = 'users'
  AND NOT t.tgisinternal
ORDER BY t.tgname;

-- To document what an old function actually does before deciding to replace it:
--   SELECT pg_get_functiondef('public.handle_new_user'::regproc);
-- NEVER drop/replace the trigger based on this file alone. If the function is
-- the vanilla Supabase `handle_new_user`, review it, record its behaviour, and
-- only then choose ONE of:
--   a) leave it in place (this migration will not add a duplicate), or
--   b) explicitly point the existing trigger at the secure function:
--        ALTER TRIGGER on_auth_user_created ON auth.users
--          EXECUTE FUNCTION public.handle_new_user_secure();
--      (Keep the old function definition until you have confirmed it is unused.)

-- 3) HARDENED handle_new_user FUNCTION ────────────────────────────────────────
-- Safe replacement body. This does not touch any existing trigger by itself.
CREATE OR REPLACE FUNCTION public.handle_new_user_secure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Only insert a row if there is no existing admin-staff account with that e-mail.
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE email = NEW.email
  ) THEN
    INSERT INTO public.users (name, email, role)
    VALUES (
      COALESCE(NEW.raw_user_meta_data ->> 'name', split_part(NEW.email, '@', 1)),
      NEW.email,
      'support'
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user_secure() FROM PUBLIC, anon, authenticated;

-- 4) CONDITIONAL TRIGGER INSTALLATION (no duplicates, no replacements) ────────
DO $$
DECLARE
  r                    record;
  v_secure_exists      boolean := false;
  v_name_taken         boolean := false;
  v_provisioning       text[]  := ARRAY[]::text[];
  v_other              text[]  := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT t.tgname,
           fn.nspname || '.' || p.proname AS function_name,
           p.proname                     AS function_short_name,
           COALESCE(p.prosrc, '')        AS function_source
      FROM pg_trigger t
      JOIN pg_class c     ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p      ON p.oid = t.tgfoid
      JOIN pg_namespace fn ON fn.oid = p.pronamespace
     WHERE n.nspname = 'auth'
       AND c.relname = 'users'
       AND NOT t.tgisinternal
     ORDER BY t.tgname
  LOOP
    IF r.tgname = 'on_auth_user_created_secure' THEN
      v_name_taken := true;
      IF r.function_short_name = 'handle_new_user_secure' THEN
        v_secure_exists := true;
      END IF;
    ELSIF r.function_short_name = 'handle_new_user_secure'
          OR r.function_source ~* 'insert\s+into\s+(public\.)?users'
          OR r.function_short_name ~* '^handle_new_user' THEN
      -- A pre-existing trigger already provisions public.users. It may be the
      -- vanilla Supabase handler or a custom one; either way we must not add a
      -- second AFTER INSERT trigger doing the same work.
      v_provisioning := v_provisioning || (r.tgname || ' → ' || r.function_name);
    ELSE
      -- Unrelated trigger (audit, metadata, …): documented and left untouched.
      v_other := v_other || (r.tgname || ' → ' || r.function_name);
    END IF;
  END LOOP;

  IF cardinality(v_other) > 0 THEN
    RAISE NOTICE 'auth.users triggers left untouched (unrelated to user provisioning): %',
      array_to_string(v_other, ', ');
  END IF;

  IF v_secure_exists THEN
    RAISE NOTICE 'on_auth_user_created_secure already wired to handle_new_user_secure; nothing to do';
    RETURN;
  END IF;

  IF v_name_taken THEN
    RAISE NOTICE 'A trigger named on_auth_user_created_secure already exists with a different function; refusing to replace it. Review it manually.';
    RETURN;
  END IF;

  IF cardinality(v_provisioning) > 0 THEN
    RAISE NOTICE 'Existing auth.users provisioning trigger(s) found: %',
      array_to_string(v_provisioning, ', ');
    RAISE NOTICE 'Refusing to create on_auth_user_created_secure (would duplicate user provisioning). Review the old function with pg_get_functiondef() and choose the remediation documented in §2.';
    RETURN;
  END IF;

  EXECUTE 'CREATE TRIGGER on_auth_user_created_secure
             AFTER INSERT ON auth.users
             FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_secure()';
  RAISE NOTICE 'Created on_auth_user_created_secure (no existing provisioning trigger found)';
END $$;

-- 5) REVOKE EXECUTE ON EVERYTHING PUBLICLY UNLESS NEEDED ──────────────────────
-- Only the public product view keeps PUBLIC read access; coupons/users/orders do not. Functions are not
-- exposed. This revokes blanket PUBLIC execute introduced by some dashboard setups.
-- (The function-level revoke is repeated here so an existing deployment that
-- already had handle_new_user_secure is hardened too.)
REVOKE ALL ON FUNCTION public.handle_new_user_secure() FROM PUBLIC, anon, authenticated;

-- 6) PERFORMANCE / INTEGRITY INDEXES (safe, additive) ─────────────────────────
CREATE INDEX IF NOT EXISTS coupons_code_idx ON public.coupons (code);
-- NOTE: coupons uses quoted camelCase columns ("startDate"/"endDate"). The old
-- start_date/end_date form fails on the real table. If an index with this name
-- already exists on the wrong columns, verify it with pg_indexes and recreate it
-- after review (IF NOT EXISTS will not replace an existing index).
CREATE INDEX IF NOT EXISTS coupons_active_dates_idx ON public.coupons (active, "startDate", "endDate");
CREATE INDEX IF NOT EXISTS orders_date_idx ON public.orders (date DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON public.orders (status);
CREATE INDEX IF NOT EXISTS products_category_idx ON public.products (category);

-- 7) LAST-ADMIN PROTECTION IS OWNED BY supabase/admin_protection.sql ─────────
-- This file used to create a second, UNUSED prevent_last_admin_demotion()
-- function here. That duplicate has been removed on purpose: two functions
-- guarding the same invariant can drift. The authoritative guard is:
--   trigger zshm_protect_last_admin → function public.zshm_protect_last_admin()
-- It uses pg_advisory_xact_lock() and is covered by
-- scripts/test-sql-concurrency.mjs. Apply admin_protection.sql once; do not
-- re-add the old function.
-- Verification (read-only, after applying admin_protection.sql):
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal;
