-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · GROUP E · SEC-27 · PUBLIC PRODUCT VIEW (explicit column allow-list)
--
-- Finding: the storefront reads the `products` table directly with the anon
-- key (`select('*')`), so every column — including the internal inventory
-- reservation counter `reservedStock` — was exposed to any visitor. The anon
-- key ships in the browser bundle by design, so this is public data.
--
-- REVISION 3 hardening:
--   * The view itself returns ONLY rows where `active IS TRUE`. Inactive or
--     NULL-active products never reach the public API, regardless of frontend
--     filtering.
--   * The view is built from an EXPLICIT public-column allow-list. New columns
--     added to `products` are NOT exposed automatically; they are reported.
--     (`reservedStock` is not just "excluded", it is absent from the allow-list.)
--   * Only genuinely public display/availability columns are exposed. `active`
--     is used as a filter and not selected; `tags`, `rating` and `reviews` are
--     not read by the storefront and are no longer exposed.
--   * Privileges are revoked from PUBLIC as well as anon/authenticated, and the
--     post-apply check proves all three cannot SELECT the base table, including
--     through column-level grants.
--   * The staged rollout is enforced, not just documented. Phase 3 (revoking
--     the base table) is skipped until the operator records that the frontend
--     reading `products_public` is live. This prevents breaking the old bundle.
--
-- Design note: the view intentionally runs with the OWNER's privileges
-- (security_invoker = false). `security_invoker = true` would require granting
-- SELECT on the base table to anon, which would re-expose `reservedStock`
-- through PostgREST and defeat the whole point. Writes never use the anon key:
-- admin endpoints use the service role (which bypasses these grants) and order
-- placement runs through the RPC called with the service role.
--
-- Supabase's database linter reports `products_public` as "SECURITY DEFINER".
-- That warning is ACCEPTED for this view: the rollout closes the base table to
-- browser roles in Phase 3, so an invoker-rights view cannot work without
-- re-granting base-table access. The mitigations are the explicit column
-- allow-list, `security_barrier = true`, a trusted owner, and the Phase 3
-- post-checks below (no table-level AND no column-level grant survives for
-- PUBLIC/anon/authenticated). Do not silence the linter by granting base-table
-- access; see docs/security-production-checklist.md §7.
--
-- Apply ONLY in the Supabase SQL Editor after your approval. No table or row is
-- deleted; only a view is (re)created and grants are changed.
--
-- ROLLOUT ORDER (enforced):
--   Phase 1: run this file once. It creates the view and grants SELECT on it;
--            Phase 3 is skipped because the flag below is absent. The old
--            storefront keeps reading `products` during this phase.
--   Phase 2: deploy the frontend that reads `products_public`.
--   Phase 3: record the deployment flag, then run this file again:
--              INSERT INTO public.zshm_deploy_flags (name, note)
--              VALUES ('products_public_frontend_live', 'new bundle deployed')
--              ON CONFLICT (name) DO NOTHING;
--            The same file then revokes the base table and verifies it.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PRE-FLIGHT (read-only) ────────────────────────────────────────────────
-- Confirm the columns and the CURRENT privileges, including PUBLIC:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'products'
--  ORDER BY ordinal_position;
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'products';
-- SELECT has_table_privilege('public', 'public.products', 'SELECT') AS public_can,
--        has_table_privilege('anon', 'public.products', 'SELECT') AS anon_can,
--        has_table_privilege('authenticated', 'public.products', 'SELECT') AS auth_can;
-- SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'products'
--  ORDER BY policyname;
--
-- IMPORTANT: an owner-rights view does not inherit RLS row filters from
-- `products`. The view therefore applies the public visibility predicate itself
-- (`WHERE active IS TRUE`). If the table currently has any ADDITIONAL RLS row
-- predicate beyond active-state, copy that predicate into the view before
-- Phase 3. Grants, not the view, are what stop browser roles from reading the
-- base table.

-- Phase flag store (internal; no browser access).
CREATE TABLE IF NOT EXISTS public.zshm_deploy_flags (
  name   text PRIMARY KEY,
  set_at timestamptz NOT NULL DEFAULT now(),
  note   text
);
ALTER TABLE public.zshm_deploy_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zshm_deploy_flags FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 1 — CREATE THE VIEW + GRANT SELECT ON THE VIEW
-- ══════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW IF EXISTS public.products_public;

-- Explicit allow-list of columns a storefront visitor may read. Do NOT add
-- inventory/internal columns here. `reservedStock` must never be listed.
--
-- Every exposed column must be needed by the public storefront:
--   * `id`, `name`, `category`, `price`, `salePrice`, `description`, `label`,
--     `colors`, `sizes`, `images`, `image`, `sizeGuide`, `sku` — product display
--     and SEO structured data.
--   * `stock` and `variantStock` — availability and per-variant cart limits.
--     They contain non-negative available quantities only (the same public
--     availability class as `stock`). They never include `reservedStock`, cost,
--     or any internal reservation data. The server remains the final authority
--     at checkout.
--   * `active` is NOT selected: the view already filters active rows, so
--     exposing a constant `true` would be redundant.
--   * `tags`, `rating`, `reviews` are not read by the storefront and are not
--     exposed.
DO $$
DECLARE
  v_allow   text[] := ARRAY[
    'id', 'name', 'category', 'price', 'salePrice', 'description',
    'stock', 'variantStock', 'sku', 'label',
    'colors', 'sizes', 'images', 'image', 'sizeGuide'
  ];
  v_cols    text;
  v_hidden  text;
BEGIN
  IF 'reservedStock' = ANY (v_allow) THEN
    RAISE EXCEPTION 'products_public allow-list must not contain reservedStock';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
       AND column_name = 'active'
  ) THEN
    RAISE EXCEPTION 'public.products.active is required for the products_public filter';
  END IF;

  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products'
     AND column_name = ANY (v_allow);

  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'public.products has none of the allow-listed public columns';
  END IF;

  -- Visibility report: a new column is never exposed silently.
  SELECT string_agg(column_name, ', ' ORDER BY ordinal_position)
    INTO v_hidden
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products'
     AND NOT (column_name = ANY (v_allow));
  IF v_hidden IS NOT NULL THEN
    RAISE NOTICE 'products_public does not expose these columns (review if intentional): %', v_hidden;
  END IF;

  EXECUTE format(
    'CREATE VIEW public.products_public WITH (security_invoker = false, security_barrier = true) '
    'AS SELECT %s FROM public.products WHERE active IS TRUE',
    v_cols
  );
END $$;

-- The view must belong to a role that can read the base table. If this
-- migration is run by `postgres` (the SQL Editor default) that is already true.
-- Keep the existing owner when the role cannot be changed, instead of aborting.
DO $$
BEGIN
  EXECUTE 'ALTER VIEW public.products_public OWNER TO postgres';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not change view owner; keeping the current owner';
END $$;

-- Prove the view contains ONLY allow-listed columns and never reservedStock.
DO $$
DECLARE
  v_allow text[] := ARRAY[
    'id', 'name', 'category', 'price', 'salePrice', 'description',
    'stock', 'variantStock', 'sku', 'label',
    'colors', 'sizes', 'images', 'image', 'sizeGuide'
  ];
  v_bad text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO v_bad
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'products_public'
     AND NOT (column_name = ANY (v_allow));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'products_public exposes non-allow-listed columns: %', v_bad;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products_public'
       AND lower(column_name) = 'reservedstock'
  ) THEN
    RAISE EXCEPTION 'products_public exposes reservedStock';
  END IF;
END $$;

-- Only SELECT on the sanitized view. Revoke PUBLIC explicitly too.
REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.products_public TO anon, authenticated;

-- PostgREST caches the schema; ask it to reload so /rest/v1/products_public
-- becomes available without a project restart.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ══════════════════════════════════════════════════════════════════════════════
-- PHASE 3 — CLOSE THE BASE TABLE (only after the new frontend is live)
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_public boolean;
  v_anon   boolean;
  v_auth   boolean;
  v_col    record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.zshm_deploy_flags
     WHERE name = 'products_public_frontend_live'
  ) THEN
    RAISE NOTICE 'PHASE 3 SKIPPED: set zshm_deploy_flags(products_public_frontend_live) after deploying the new frontend, then re-run.';
    RETURN;
  END IF;

  EXECUTE 'REVOKE ALL ON public.products FROM PUBLIC, anon, authenticated';

  -- Table-level REVOKE does not remove column-level grants. Remove them too,
  -- otherwise an old column grant (for example on "reservedStock") would still
  -- let PostgREST read the base table directly after Phase 3.
  FOR v_col IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%I) ON TABLE public.products FROM PUBLIC, anon, authenticated',
      v_col.column_name
    );
    EXECUTE format(
      'REVOKE INSERT (%I) ON TABLE public.products FROM PUBLIC, anon, authenticated',
      v_col.column_name
    );
    EXECUTE format(
      'REVOKE UPDATE (%I) ON TABLE public.products FROM PUBLIC, anon, authenticated',
      v_col.column_name
    );
    EXECUTE format(
      'REVOKE REFERENCES (%I) ON TABLE public.products FROM PUBLIC, anon, authenticated',
      v_col.column_name
    );
  END LOOP;

  -- Post-apply proof: none of the browser roles can read the base table,
  -- including through a column-level grant.
  v_public := has_table_privilege('public', 'public.products', 'SELECT');
  v_anon   := has_table_privilege('anon', 'public.products', 'SELECT');
  v_auth   := has_table_privilege('authenticated', 'public.products', 'SELECT');
  IF v_public OR v_anon OR v_auth THEN
    RAISE EXCEPTION 'products is still readable (PUBLIC=%, anon=%, authenticated=%)',
      v_public, v_anon, v_auth;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
     WHERE n.nspname = 'public'
       AND c.relname = 'products'
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND (acl.grantee = 0
            OR pg_get_userbyid(acl.grantee) IN ('anon', 'authenticated'))
  ) THEN
    RAISE EXCEPTION 'products still has column-level grants for browser roles';
  END IF;

  -- The view must still be readable after the base-table revoke.
  IF NOT has_table_privilege('anon', 'public.products_public', 'SELECT') THEN
    RAISE EXCEPTION 'products_public is no longer readable by anon';
  END IF;

  PERFORM pg_notify('pgrst', 'reload schema');
  RAISE NOTICE 'PHASE 3 applied: public.products is closed to browser roles';
END $$;

-- ── 4) VERIFICATION (read-only, run after COMMIT) ────────────────────────────
-- Expect: reservedStock absent from the view, present in the table.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'products_public'
--  ORDER BY ordinal_position;
--
-- Expect: PUBLIC/anon/authenticated have NO privilege on products and SELECT
-- on the view only (run after Phase 3), including column-level privileges:
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public'
--    AND table_name IN ('products', 'products_public')
--  ORDER BY table_name, grantee;
-- SELECT grantee, column_name, privilege_type
--   FROM information_schema.column_privileges
--  WHERE table_schema = 'public' AND table_name = 'products'
--    AND grantee IN ('PUBLIC', 'anon', 'authenticated')
--  ORDER BY grantee, column_name, privilege_type;
--   → both queries must return no rows for products after Phase 3.
-- SELECT has_table_privilege('public', 'public.products', 'SELECT') AS public_can,
--        has_table_privilege('anon', 'public.products', 'SELECT') AS anon_can,
--        has_table_privilege('authenticated', 'public.products', 'SELECT') AS auth_can;
--   → all three must be false after Phase 3.
--
-- Manual checks after applying:
--   1. storefront loads products and the store still works;
--   2. `GET /rest/v1/products?select=reservedStock` with the anon key → 401/403;
--   3. `GET /rest/v1/products_public` with the anon key → rows, no reservedStock;
--   4. admin product create/update still works (service role);
--   5. checkout still works (atomic_place_order is called with the service role).

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- BEGIN;
--   GRANT SELECT ON public.products TO anon, authenticated;
--   REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
--   DROP VIEW IF EXISTS public.products_public;
--   DELETE FROM public.zshm_deploy_flags WHERE name = 'products_public_frontend_live';
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- (Also revert src/store.js and src/lib/security.js to `from('products')`.)
