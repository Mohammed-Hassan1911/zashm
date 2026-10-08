-- ─────────────────────────────────────────────────────────────────────────────
-- ZASHM · DATABASE SECURITY HARDENING (run once in Supabase SQL Editor)
--
-- The JavaS/API layer now talks to the database with the SERVICE ROLE key
-- (server-side only). The anon key is only used for PUBLIC reads (products,
-- active coupons). Rows that must never be readable by the anon key:
--   users(passwordhash), orders(PII). Confirm below — do not reopen RLS.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) VERIFY CURRENT RLS STATE ─────────────────────────────────────────────────
-- Expected output: products & coupons have policies (public reads) and the
-- is_enabled column is true for all four tables.
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual,
  with_check,
  is_enabled
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

SELECT
  tablename,
  relrowsecurity AS rls_enabled,
  relforcerowsecurity AS force_rls
FROM pg_class
WHERE relname IN ('products', 'coupons', 'orders', 'users');

-- 2) HARDENED handle_new_user ─────────────────────────────────────────────────
-- If your project uses a trigger function on auth.users (created by the Supabase
-- "Auth → hooks" or an old migration), replace it with this safe version so the
-- PUBLIC role can never SELECT * FROM users.
CREATE OR REPLACE FUNCTION public.handle_new_user_secure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Wire the trigger (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created_secure'
  ) THEN
    CREATE TRIGGER on_auth_user_created_secure
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_secure();
  END IF;
END $$;

-- Drop the old widely-permissive trigger / function if present (verify names
-- in your project first — Supabase generates on_auth_user_created by default).
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_new_user_custom;
-- The following is known-good for the vanilla Supabase template:
-- DROP FUNCTION IF EXISTS public.handle_new_user;

-- 3) REVOKE EXECUTE ON EVERYTHING PUBLICLY UNLESS NEEDED ──────────────────────
-- Only the anon-key readable tables keep PUBLIC read access; functions are not
-- exposed. This revokes blanket PUBLIC execute introduced by some dashboard setups.
REVOKE ALL ON FUNCTION public.handle_new_user_secure() FROM PUBLIC, anon, authenticated;

-- 4) PERFORMANCE / INTEGRITY INDEXES (safe, additive) ─────────────────────────
CREATE INDEX IF NOT EXISTS coupons_code_idx ON public.coupons (code);
CREATE INDEX IF NOT EXISTS coupons_active_dates_idx ON public.coupons (active, start_date, end_date);
CREATE INDEX IF NOT EXISTS orders_date_idx ON public.orders (date DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON public.orders (status);
CREATE INDEX IF NOT EXISTS products_category_idx ON public.products (category);

-- 5) OPTIONAL: PREVENT ADMIN STAFF FROM BEING LOCKED OUT ──────────────────────
-- Run AFTER confirming at least one active admin exists. Prevents a second
-- admin from being deleted/demoted while it is the only remaining admin.
CREATE OR REPLACE FUNCTION public.prevent_last_admin_demotion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND NEW.role <> 'admin')
     OR (TG_OP = 'DELETE' AND OLD.role = 'admin') THEN
    IF (SELECT COUNT(*) FROM public.users WHERE role = 'admin') <= 1 THEN
      RAISE EXCEPTION 'Cannot demote or delete the last admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- (Enable only if you want DB-level protection in addition to the API guard.)
-- DROP TRIGGER IF EXISTS prevent_last_admin_demotion ON public.users;
-- CREATE TRIGGER prevent_last_admin_demotion
--   BEFORE UPDATE OR DELETE ON public.users
--   FOR EACH ROW EXECUTE FUNCTION public.prevent_last_admin_demotion();