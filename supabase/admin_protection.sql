-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · GROUP C · LAST-ADMIN PROTECTION
--
-- The API refuses to demote or delete the only admin (api/admin/users.js), but
-- two concurrent requests could each pass that check. This trigger is the
-- authoritative guard: it serializes admin role changes with a transaction
-- advisory lock, then re-counts the remaining admins.
--
-- Apply ONLY in the Supabase SQL Editor after your approval.
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- Rollback: DROP TRIGGER ...; DROP FUNCTION ...
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.zshm_protect_last_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admins integer;
BEGIN
  -- Serialize every demotion/deletion of an admin. The loser waits here, then
  -- its count below runs after the winner committed.
  IF (TG_OP = 'DELETE' AND OLD.role = 'admin')
     OR (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin') THEN
    PERFORM pg_advisory_xact_lock(hashtext('zshm:last_admin'));

    SELECT count(*) INTO v_admins
      FROM public.users
     WHERE role = 'admin'
       AND id <> OLD.id;

    IF v_admins < 1 THEN
      RAISE EXCEPTION 'last_admin: cannot delete or demote the last admin'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.zshm_protect_last_admin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zshm_protect_last_admin ON public.users;
CREATE TRIGGER zshm_protect_last_admin
  BEFORE UPDATE OR DELETE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.zshm_protect_last_admin();

-- ── Verification (read-only; run after applying) ─────────────────────────────
-- SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'zshm_protect_last_admin';
-- SELECT count(*) AS admins FROM public.users WHERE role = 'admin';  -- must be >= 1

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS zshm_protect_last_admin ON public.users;
-- DROP FUNCTION IF EXISTS public.zshm_protect_last_admin();
