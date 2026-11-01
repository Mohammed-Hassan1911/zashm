-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · GROUP D · STORAGE HARDENING (products bucket)
--
-- Findings this fixes:
--   * the `products` bucket had no file_size_limit and no allowed_mime_types,
--     so anything could be uploaded if a write policy existed;
--   * anon could list objects in the bucket (200 on the storage list API),
--     exposing every uploaded filename.
--
-- Safety rules for policy removal (REVISION 3):
--   * storage.objects is owned by Supabase's storage role. ALTER TABLE,
--     CREATE POLICY and DROP POLICY require ownership (or membership in the
--     owning role). The SQL Editor role often has UPDATE on storage.buckets but
--     NOT those ownership privileges. This file therefore checks ownership
--     before touching storage.objects. It never changes table ownership and
--     never attempts an operation the current role cannot safely perform.
--   * If the role cannot manage storage.objects, products-only policies are
--     reported as MANUAL ACTION REQUIRED for removal in the Supabase Dashboard
--     (Storage > Policies). The file does not bypass RLS or broaden grants.
--   * A policy is dropped ONLY when its expression is provably scoped to the
--     `products` bucket (a simple `bucket_id = 'products'` / single-element ANY).
--   * A blanket policy (`USING (true)` or NULL qual + NULL with_check) applies
--     to EVERY bucket. It is NEVER dropped automatically: it is reported for
--     manual review instead, because this migration cannot know whether another
--     bucket relies on it.
--   * A policy that mentions `products` AND another bucket is never dropped.
--   * Every dropped policy, and every products-only policy that must be removed
--     manually, is copied verbatim (roles + USING + WITH CHECK) into
--     public.zshm_storage_policy_backup before removal. The companion function
--     public.zshm_restore_storage_policies() recreates them from that table.
--
-- Design note: the ONLY writer is /api/admin/upload, which uses the service
-- role. The service role bypasses RLS, so the browser does not need ANY write
-- policy. Public objects stay downloadable through the public object URL even
-- without a SELECT policy, because the bucket is public.
--
-- Apply ONLY in the Supabase SQL Editor after your approval.
-- Idempotent: UPDATE + CREATE TABLE IF NOT EXISTS + ownership-guarded DROP.
-- No table/row of application data is deleted, and no policy is dropped unless
-- the current role owns storage.objects (or has its privileges).
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PRE-FLIGHT (read-only) ────────────────────────────────────────────────
-- Run these first and keep the output. They show every bucket and every policy
-- that could be affected.
-- SELECT id, public, file_size_limit, allowed_mime_types
--   FROM storage.buckets ORDER BY id;
-- SELECT policyname, cmd, permissive, roles, qual, with_check
--   FROM pg_policies
--  WHERE schemaname = 'storage' AND tablename = 'objects'
--  ORDER BY policyname;
-- SELECT c.relowner::regrole AS owner,
--        c.relrowsecurity AS rls_enabled,
--        pg_has_role(c.relowner, 'USAGE') AS can_manage_objects
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'storage' AND c.relname = 'objects';

-- ── 1) BUCKET LIMITS ─────────────────────────────────────────────────────────
-- 5 MB matches the server cap (3 MB decoded + base64 overhead) with headroom.
UPDATE storage.buckets
   SET public = true,
       file_size_limit = 5242880,
       allowed_mime_types = ARRAY[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'
       ]
 WHERE id = 'products';

-- ── 2) ROW LEVEL SECURITY ON storage.objects (ownership-safe) ────────────────
-- Supabase enables RLS on storage.objects by default. ALTER TABLE requires
-- table ownership, which the SQL Editor role may not have. Only run it when RLS
-- is actually disabled AND the current role has owner privileges; if RLS is
-- disabled and the role cannot enable it, stop rather than continuing with RLS
-- off. Table ownership is never changed here.
DO $$
DECLARE
  v_can_manage boolean;
  v_rls_enabled boolean;
BEGIN
  SELECT pg_has_role(c.relowner, 'USAGE'),
         c.relrowsecurity
    INTO v_can_manage, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'storage'
     AND c.relname = 'objects';

  IF COALESCE(v_rls_enabled, false) THEN
    RAISE NOTICE 'storage.objects RLS is already enabled; no ALTER TABLE needed';
  ELSIF COALESCE(v_can_manage, false) THEN
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'storage.objects RLS enabled';
  ELSE
    RAISE EXCEPTION 'storage.objects RLS is disabled and role % cannot enable it. Enable RLS in Supabase Dashboard > Storage before rerunning this file.', current_user;
  END IF;
END $$;

-- ── 3) DURABLE POLICY BACKUP + RESTORE ───────────────────────────────────────
-- The backup table is internal: no browser role can read it.
CREATE TABLE IF NOT EXISTS public.zshm_storage_policy_backup (
  id            bigserial PRIMARY KEY,
  backed_up_at  timestamptz NOT NULL DEFAULT now(),
  policyname    text        NOT NULL,
  cmd           text        NOT NULL,
  permissive    text        NOT NULL DEFAULT 'PERMISSIVE',
  roles         name[]      NOT NULL,
  qual          text,
  with_check    text,
  reason        text,
  restored_at   timestamptz,
  restore_count integer     NOT NULL DEFAULT 0
);

ALTER TABLE public.zshm_storage_policy_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zshm_storage_policy_backup FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.zshm_storage_policy_backup_id_seq FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.zshm_storage_policy_backup IS
  'Verbatim definitions of storage.objects policies removed by storage_hardening.sql or flagged for manual removal. Restore with public.zshm_restore_storage_policies().';

-- Returns true only for expressions that are unambiguously scoped to the
-- products bucket. Complex expressions are treated as NOT scoped (safe default).
CREATE OR REPLACE FUNCTION public.zshm_storage_policy_scope_is_products(p_expr text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT p_expr IS NOT NULL
     AND lower(regexp_replace(btrim(p_expr), '\s+', '', 'g')) IN (
       '(bucket_id=''products''::text)',
       'bucket_id=''products''::text',
       '(bucket_id=any(array[''products''::text]))',
       'bucket_id=any(array[''products''::text])',
       '(bucket_id=''products'')',
       'bucket_id=''products'''
     );
$$;

REVOKE ALL ON FUNCTION public.zshm_storage_policy_scope_is_products(text)
  FROM PUBLIC, anon, authenticated;

-- Recreate dropped policies from the backup. Call it by name after the change
-- has been reviewed, e.g.:
--   SELECT public.zshm_restore_storage_policies();                    -- all
--   SELECT public.zshm_restore_storage_policies(ARRAY['products_read']);
-- SECURITY DEFINER is required because storage.objects is owned by Supabase's
-- storage role. EXECUTE is intentionally NOT granted to browser/service roles.
-- The function also verifies that its owner can manage storage.objects; if not,
-- it raises a clear error and the policies must be recreated in the Dashboard.
CREATE OR REPLACE FUNCTION public.zshm_restore_storage_policies(
  p_policynames text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r             record;
  v_roles       text;
  v_sql         text;
  v_restored    text[] := ARRAY[]::text[];
  v_can_manage  boolean;
BEGIN
  SELECT pg_has_role(c.relowner, 'USAGE')
    INTO v_can_manage
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'storage'
     AND c.relname = 'objects';

  IF NOT COALESCE(v_can_manage, false) THEN
    RAISE EXCEPTION 'zshm_restore_storage_policies: role % cannot manage storage.objects. Recreate the backed-up policies in Supabase Dashboard > Storage > Policies instead.', current_user
      USING HINT = 'Do not change ownership of storage.objects. The backup rows remain available in public.zshm_storage_policy_backup.';
  END IF;

  FOR r IN
    SELECT DISTINCT ON (policyname) *
      FROM public.zshm_storage_policy_backup
     WHERE restored_at IS NULL
       AND (p_policynames IS NULL OR policyname = ANY (p_policynames))
     ORDER BY policyname, backed_up_at DESC, id DESC
  LOOP
    IF r.cmd NOT IN ('SELECT','INSERT','UPDATE','DELETE','ALL') THEN
      RAISE EXCEPTION 'zshm_restore_storage_policies: unsupported cmd %', r.cmd;
    END IF;
    IF r.permissive NOT IN ('PERMISSIVE','RESTRICTIVE') THEN
      RAISE EXCEPTION 'zshm_restore_storage_policies: unsupported permissive %', r.permissive;
    END IF;
    IF r.roles IS NULL OR cardinality(r.roles) = 0 THEN
      RAISE EXCEPTION 'zshm_restore_storage_policies: no roles for policy %', r.policyname;
    END IF;

    SELECT string_agg(
             CASE WHEN role_name = 'public' THEN 'PUBLIC' ELSE quote_ident(role_name) END,
             ', ' ORDER BY role_name
           )
      INTO v_roles
      FROM unnest(r.roles) AS role_name;

    v_sql := format(
      'CREATE POLICY %I ON storage.objects AS %s FOR %s TO %s',
      r.policyname, r.permissive, r.cmd, v_roles
    );
    IF r.qual IS NOT NULL THEN
      v_sql := v_sql || format(' USING (%s)', r.qual);
    END IF;
    IF r.with_check IS NOT NULL THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', r.with_check);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
    EXECUTE v_sql;

    UPDATE public.zshm_storage_policy_backup
       SET restored_at = now(),
           restore_count = restore_count + 1
     WHERE id = r.id;

    v_restored := v_restored || r.policyname;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'restored', cardinality(v_restored),
    'policies', to_jsonb(v_restored)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.zshm_restore_storage_policies(text[])
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4) REMOVE ONLY PROVABLY PRODUCTS-SCOPED BROWSER POLICIES ─────────────────
-- A policy is dropped only if EVERY expression that applies to its command is
-- a simple products-only scope. Blanket/global policies are kept and reported.
-- DROP POLICY requires ownership of storage.objects. If the current role lacks
-- it, the exact products-only policies are reported for manual removal in the
-- Supabase Dashboard instead of forcing an ownership change.
DO $$
DECLARE
  p             record;
  v_can_manage  boolean;
  v_backup_id   bigint;
  v_scope_ok    boolean;
  v_required    boolean;
  v_reason      text;
BEGIN
  SELECT pg_has_role(c.relowner, 'USAGE')
    INTO v_can_manage
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'storage'
     AND c.relname = 'objects';
  v_can_manage := COALESCE(v_can_manage, false);

  IF NOT v_can_manage THEN
    RAISE WARNING 'Role % cannot manage storage.objects (not owner and no owner privileges). DROP POLICY will be skipped; products-only policies will be listed for manual removal.', current_user;
    RAISE WARNING 'MANUAL ACTION REQUIRED: create restrictive SELECT policy zshm_products_no_public_listing for anon, authenticated with USING (bucket_id <> ''products'') in Supabase Dashboard > Storage > Policies.';
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'storage'
         AND tablename = 'objects'
         AND policyname = 'zshm_products_no_public_listing'
    ) THEN
      CREATE POLICY zshm_products_no_public_listing
        ON storage.objects
        AS RESTRICTIVE
        FOR SELECT
        TO anon, authenticated
        USING (bucket_id <> 'products');
      RAISE NOTICE 'Created restrictive policy zshm_products_no_public_listing: browser roles cannot list products objects; public object downloads remain available.';
    END IF;
  END IF;

  FOR p IN
    SELECT policyname, cmd, permissive, roles, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename = 'objects'
       AND cmd IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
     ORDER BY policyname
  LOOP
    v_scope_ok := true;
    v_required := true;
    v_reason   := null;
    v_backup_id := null;

    -- Command-specific applicability of USING / WITH CHECK.
    IF p.cmd = 'SELECT' OR p.cmd = 'DELETE' THEN
      v_required := p.qual IS NOT NULL;
      v_scope_ok := public.zshm_storage_policy_scope_is_products(p.qual);
    ELSIF p.cmd = 'INSERT' THEN
      v_required := p.with_check IS NOT NULL;
      v_scope_ok := public.zshm_storage_policy_scope_is_products(p.with_check);
    ELSIF p.cmd = 'UPDATE' THEN
      v_required := p.qual IS NOT NULL;
      v_scope_ok := public.zshm_storage_policy_scope_is_products(p.qual)
                    AND (p.with_check IS NULL
                         OR public.zshm_storage_policy_scope_is_products(p.with_check));
    ELSE -- ALL
      v_required := p.qual IS NOT NULL;
      v_scope_ok := public.zshm_storage_policy_scope_is_products(p.qual)
                    AND (p.with_check IS NULL
                         OR public.zshm_storage_policy_scope_is_products(p.with_check));
    END IF;

    IF v_required
       AND v_scope_ok
       AND (p.qual IS NULL OR public.zshm_storage_policy_scope_is_products(p.qual))
       AND (p.with_check IS NULL OR public.zshm_storage_policy_scope_is_products(p.with_check)) THEN
      -- Back up BEFORE any removal, including a manual Dashboard removal.
      -- Reuse an identical unrestored backup row so re-runs stay idempotent.
      SELECT b.id
        INTO v_backup_id
        FROM public.zshm_storage_policy_backup b
       WHERE b.policyname = p.policyname
         AND b.cmd = p.cmd
         AND b.permissive = p.permissive
         AND b.roles = p.roles
         AND b.qual IS NOT DISTINCT FROM p.qual
         AND b.with_check IS NOT DISTINCT FROM p.with_check
         AND b.restored_at IS NULL
       ORDER BY b.id DESC
       LIMIT 1;

      IF v_backup_id IS NULL THEN
        INSERT INTO public.zshm_storage_policy_backup
          (policyname, cmd, permissive, roles, qual, with_check, reason)
        VALUES
          (p.policyname, p.cmd, p.permissive, p.roles, p.qual, p.with_check,
           CASE WHEN v_can_manage
                THEN 'products-only scope, browser role'
                ELSE 'manual removal required: role cannot manage storage.objects'
           END)
        RETURNING id INTO v_backup_id;
      END IF;

      IF v_can_manage THEN
        EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', p.policyname);
        RAISE NOTICE 'Dropped products-scoped storage.objects policy % (backed up as id %)',
          p.policyname, v_backup_id;
      ELSE
        RAISE WARNING 'MANUAL ACTION REQUIRED: drop storage.objects policy % (cmd %, roles %) in Supabase Dashboard > Storage > Policies. It is products-only and browser-visible. Re-run this file afterwards.', p.policyname, p.cmd, p.roles;
      END IF;
    ELSE
      v_reason := CASE
        WHEN p.qual IS NULL AND p.with_check IS NULL THEN 'blanket policy applies to every bucket'
        WHEN NOT v_required THEN 'no applicable USING/WITH CHECK expression'
        WHEN NOT v_scope_ok THEN 'expression is not provably products-only'
        ELSE 'expression is not provably products-only'
      END;
      RAISE NOTICE 'KEPT storage.objects policy % (%) — review manually, it may serve another bucket',
        p.policyname, v_reason;
    END IF;
  END LOOP;
END $$;

-- ── 5) VERIFICATION (read-only, run after applying) ──────────────────────────
-- Expect file_size_limit = 5242880 and the MIME allow-list:
--   SELECT id, public, file_size_limit, allowed_mime_types
--     FROM storage.buckets WHERE id = 'products';
--
-- If the role could manage storage.objects, expect only policies that are NOT
-- provably products-only (blanket/other):
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--    WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname;
--
-- If the output contains "MANUAL ACTION REQUIRED", remove those exact policies
-- in Supabase Dashboard > Storage > Policies, then re-run this file. Do NOT
-- change storage.objects ownership and do NOT disable RLS.
--
-- Every policy backed up here (dropped by this script or flagged for manual
-- Dashboard removal) is restorable verbatim:
--   SELECT id, policyname, cmd, roles, qual, with_check, restored_at, reason
--     FROM public.zshm_storage_policy_backup ORDER BY id;
--   SELECT public.zshm_restore_storage_policies(ARRAY['products_read']);
-- (Restore also requires a role that can manage storage.objects.)
--
-- Manual checks after applying:
--   1. anon list  → must be 401/403/empty, not a list of filenames;
--   2. existing product images still load via /storage/v1/object/public/products/...;
--   3. admin upload from the console still succeeds (service role bypasses RLS).
--   4. anon listing of storage.objects for bucket_id='products' returns no rows.

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Recreate the exact policies backed up by this file (recommended):
--   SELECT public.zshm_restore_storage_policies();
-- Keep public.zshm_storage_policy_backup as the audit trail; do not delete it.
-- Bucket limits can be reset with:
--   UPDATE storage.buckets
--      SET file_size_limit = NULL, allowed_mime_types = NULL
--    WHERE id = 'products';
--   DROP POLICY IF EXISTS zshm_products_no_public_listing ON storage.objects;
