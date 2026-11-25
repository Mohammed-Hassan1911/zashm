-- ZASHM · OWNER-RUN PRODUCTION FIX (2026-11-25)
-- Purpose: remove the default PUBLIC EXECUTE grant from the pure variant-stock
--          validation helper. Keep postgres and service_role EXECUTE.
-- Scope:   one GRANT change + PostgREST schema-cache reload. No table data is
--          read or written. Owner approved this fix on 2026-11-25.
-- Status:  AUTHORED ONLY — not applied from this environment. Run in the
--          Supabase SQL Editor and send back the final verdict row.
--
--          Paste the whole file and press Run. Stop if the pre-check does not
--          show one function with PUBLIC EXECUTE and service_role EXECUTE.

-- ══════════════════════════════════════════════════════════════════════════════
-- 0) PRE-CHECK — read only. Expected: signature exists,
--    public_execute_before = true, service_execute_before = true.
-- ══════════════════════════════════════════════════════════════════════════════
SELECT p.oid::regprocedure AS signature,
       p.proacl AS acl_before,
       (p.proacl IS NULL OR EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0
       )) AS public_execute_before,
       EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.privilege_type = 'EXECUTE'
            AND a.grantee = to_regrole('service_role')
       ) AS service_execute_before
  FROM pg_proc p
 WHERE p.proname = 'zshm_valid_variant_stock'
   AND p.pronamespace = 'public'::regnamespace;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1) FAIL-CLOSED GUARD — aborts before any change if the expected target or
--    service_role grant is missing.
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  fn oid := to_regprocedure('public.zshm_valid_variant_stock(jsonb)');
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION 'Expected public.zshm_valid_variant_stock(jsonb) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = fn
       AND a.privilege_type = 'EXECUTE'
       AND a.grantee = to_regrole('service_role')
  ) THEN
    RAISE EXCEPTION 'service_role has no EXECUTE on zshm_valid_variant_stock; refusing to continue';
  END IF;
END
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2) FIX — idempotent. Removes only the blanket PUBLIC grant. Do not grant
--    EXECUTE to anon/authenticated; they never write products directly.
-- ══════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION public.zshm_valid_variant_stock(jsonb) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════════
-- 3) VERIFICATION — read only. Expected: verdict = PASS, one function found,
--    zero blanket EXECUTE grants, service_role_execute = 1, search_path pinned.
-- ══════════════════════════════════════════════════════════════════════════════
WITH fn AS (
  SELECT p.oid,
         p.proacl,
         p.proconfig,
         CASE WHEN p.proacl IS NULL THEN 1
              ELSE (SELECT count(*) FROM aclexplode(p.proacl) a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0)
         END AS public_execute,
         (SELECT count(*) FROM aclexplode(p.proacl) a
           WHERE a.privilege_type = 'EXECUTE'
             AND a.grantee = to_regrole('anon')) AS anon_execute,
         (SELECT count(*) FROM aclexplode(p.proacl) a
           WHERE a.privilege_type = 'EXECUTE'
             AND a.grantee = to_regrole('authenticated')) AS authenticated_execute,
         (SELECT count(*) FROM aclexplode(p.proacl) a
           WHERE a.privilege_type = 'EXECUTE'
             AND a.grantee = to_regrole('service_role')) AS service_execute
    FROM pg_proc p
   WHERE p.proname = 'zshm_valid_variant_stock'
     AND p.pronamespace = 'public'::regnamespace
)
SELECT CASE WHEN count(*) = 1
             AND max(public_execute) = 0
             AND max(anon_execute) = 0
             AND max(authenticated_execute) = 0
             AND max(service_execute) = 1
             AND bool_and(proconfig::text LIKE '%search_path=public%pg_temp%')
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       count(*) AS functions_found,
       max(public_execute) AS public_execute,
       max(anon_execute) AS anon_execute,
       max(authenticated_execute) AS authenticated_execute,
       max(service_execute) AS service_execute,
       max(proconfig::text) AS settings,
       max(proacl::text) AS acl_after
  FROM fn;

-- ══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK — commented out. Run only with explicit owner approval.
--   GRANT EXECUTE ON FUNCTION public.zshm_valid_variant_stock(jsonb) TO PUBLIC;
--   NOTIFY pgrst, 'reload schema';
-- ══════════════════════════════════════════════════════════════════════════════
