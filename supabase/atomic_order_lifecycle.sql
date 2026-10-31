-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · PHASE A · ATOMIC ORDER LIFECYCLE (status change + deletion)
--
-- Closes SEC-04 (cancel race) and SEC-05 (delete before restore) by moving the
-- ENTIRE lifecycle operation into ONE PostgreSQL function = ONE transaction:
--
--   * the order row is locked FIRST (`SELECT ... FOR UPDATE`), so two
--     concurrent cancels of the same order are serialized: the loser observes
--     the new status and cannot restore stock / coupon a second time;
--   * stock and coupon usage are adjusted in the SAME transaction, so a later
--     failure rolls the whole thing back (no "order cancelled but stock not
--     restored" and no "row deleted but stock not restored");
--   * the expected status is passed in by the caller and re-checked under the
--     lock (optimistic concurrency) → `status_changed` instead of a lost update;
--   * a deletion restores stock/coupon ONLY when the row was not already
--     cancelled (a cancelled order was already restored at cancel time);
--   * products are locked in ascending id (delegated to atomic_adjust_stock),
--     so the lock order stays `orders` → `products` = deadlock-free.
--
-- Apply ONLY in the Supabase SQL Editor after your approval, and BEFORE the
-- matching api/admin/orders.js changes are deployed.
-- Idempotent: CREATE OR REPLACE + idempotent grants.
--
-- LEGACY / NON-STANDARD ORDER DATA (REVISION 2):
-- Old orders may store `items` as a double-encoded JSON string, as a JSON
-- object instead of an array, with non-object entries, with missing/invalid
-- productId or qty, or with quantities <= 0. Both functions now parse through
-- public.zshm_order_items() / zshm_order_lines() and:
--   * never raise on malformed legacy JSON — they treat it as an empty cart;
--   * ignore only the invalid lines and process every valid line;
--   * report the number of skipped lines in the `warnings` array.
--
-- ⚠ PRODUCT-DELETION WARNING (read before deleting orders):
-- Deleting an order restores stock. If a product row was permanently deleted,
-- atomic_adjust_stock() reports `missing_product` and (by design) writes NO
-- stock at all, because it validates every product before mutating any. The
-- order is still deleted (so the console is never blocked forever) but:
--   * stockRestored = false;
--   * warnings contains the missing product;
--   * stock for the OTHER, still-existing lines is NOT restored.
-- This is permanent inventory loss for those lines. The API returns the
-- warnings so the operator can reconcile manually. Prefer cancelling orders
-- before deleting products when historical restores may be needed.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) LEGACY-SAFE ITEM PARSERS (internal helpers) ───────────────────────────
-- Return a JSON array for any legacy representation:
--   jsonb array  → unchanged
--   JSON string  → parsed once (double-encoded rows), invalid JSON → []
--   object/null  → []
CREATE OR REPLACE FUNCTION public.zshm_order_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parsed jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) IN ('null', 'object') THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_typeof(p_items) = 'array' THEN
    RETURN p_items;
  END IF;
  IF jsonb_typeof(p_items) = 'string' THEN
    BEGIN
      v_parsed := (p_items #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      -- Legacy row with a broken JSON string: keep the order usable.
      RETURN '[]'::jsonb;
    END;
    IF jsonb_typeof(v_parsed) = 'array' THEN
      RETURN v_parsed;
    END IF;
  END IF;
  RETURN '[]'::jsonb;
END;
$$;

-- Normalised lines that are safe to pass to atomic_adjust_stock(). Invalid
-- legacy lines are skipped (counted by zshm_order_skipped_lines below).
CREATE OR REPLACE FUNCTION public.zshm_order_lines(p_items jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'productId', (it ->> 'productId')::bigint,
           'qty',       (it ->> 'qty')::int,
           'size',      COALESCE(it ->> 'size', ''),
           'color',     COALESCE(it ->> 'color', '')
         )), '[]'::jsonb)
    FROM jsonb_array_elements(public.zshm_order_items(p_items)) AS it
   WHERE jsonb_typeof(it) = 'object'
     AND CASE
           WHEN (it ->> 'productId') ~ '^[1-9][0-9]{0,17}$'
            AND (it ->> 'qty') ~ '^[0-9]{1,9}$'
           THEN (it ->> 'qty')::int > 0
           ELSE false
         END;
$$;

-- Number of raw entries that zshm_order_lines() cannot use.
CREATE OR REPLACE FUNCTION public.zshm_order_skipped_lines(p_items jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::integer
    FROM jsonb_array_elements(public.zshm_order_items(p_items)) AS it
   WHERE NOT (
     jsonb_typeof(it) = 'object'
     AND CASE
           WHEN (it ->> 'productId') ~ '^[1-9][0-9]{0,17}$'
            AND (it ->> 'qty') ~ '^[0-9]{1,9}$'
           THEN (it ->> 'qty')::int > 0
           ELSE false
         END
   );
$$;

-- ── COUPON USAGE: STRICT ATOMIC ADJUSTMENT ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.zshm_adjust_coupon_usage(
  p_code text,
  p_delta integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_code IS NULL OR btrim(p_code) = '' THEN
    RAISE EXCEPTION 'Coupon code is required';
  END IF;

  IF p_delta IS NULL OR p_delta NOT IN (-1, 1) THEN
    RAISE EXCEPTION 'Invalid coupon usage adjustment';
  END IF;

  UPDATE public.coupons
     SET "usageCount" = GREATEST(
       COALESCE("usageCount", 0) + p_delta,
       0
     )
   WHERE code = btrim(p_code);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'Coupon not found during usage adjustment: %', p_code;
  END IF;

  RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$$;

-- ── 1) ATOMIC STATUS CHANGE ───────────────────────────────────────────────────
-- p_expected_status: the status the caller read before deciding. The function
-- re-checks it under the row lock. Passing NULL/'' skips the check (used only by
-- trusted internal callers).
CREATE OR REPLACE FUNCTION public.atomic_set_order_status(
  p_id text,
  p_expected_status text,
  p_new_status text,
  p_timestamps jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_items jsonb;
  v_lines jsonb;
  v_stock jsonb;
  v_going boolean;
  v_coming boolean;
  v_code text;
  v_skipped integer := 0;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_new_status IS NULL
     OR p_new_status NOT IN ('Pending','Confirmed','Processing','Shipped','Delivered','Cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status');
  END IF;

  -- 1. Lock the order row. Everything below runs under this lock.
  SELECT * INTO v_order FROM public.orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 2. Optimistic concurrency: the caller's expected status must still hold.
  IF p_expected_status IS NOT NULL AND btrim(p_expected_status) <> ''
     AND v_order.status IS DISTINCT FROM p_expected_status THEN
    -- Idempotent retry: the transition already happened.
    IF v_order.status = p_new_status THEN
      RETURN jsonb_build_object('ok', true, 'changed', false,
                                'status', v_order.status, 'idempotent', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'status_changed',
                              'status', v_order.status);
  END IF;

  -- Already in the target status → nothing to reconcile.
  IF v_order.status IS NOT DISTINCT FROM p_new_status THEN
    RETURN jsonb_build_object('ok', true, 'changed', false,
                              'status', v_order.status, 'idempotent', true);
  END IF;

  v_going  := lower(p_new_status) = 'cancelled'
              AND lower(COALESCE(v_order.status, '')) <> 'cancelled';
  v_coming := lower(COALESCE(v_order.status, '')) = 'cancelled'
              AND lower(p_new_status) <> 'cancelled';

  -- 3. Stock + coupon reconciliation, only across the cancelled boundary.
  IF v_going OR v_coming THEN
    -- Legacy-safe parse: double-encoded strings and non-array rows are tolerated.
    v_items := public.zshm_order_items(v_order.items);
    v_lines := public.zshm_order_lines(v_items);
    v_skipped := public.zshm_order_skipped_lines(v_items);
    IF v_skipped > 0 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'legacy_items_skipped', 'count', v_skipped));
    END IF;

    IF jsonb_array_length(v_lines) > 0 THEN
      v_stock := public.atomic_adjust_stock(v_lines, CASE WHEN v_going THEN 1 ELSE -1 END);
      IF COALESCE((v_stock ->> 'ok')::boolean, false) IS NOT TRUE THEN
        -- atomic_adjust_stock validates/locks every product BEFORE writing, so
        -- returning here leaves the transaction with no partial stock change.
        RETURN v_stock || jsonb_build_object('warnings', v_warnings);
      END IF;
    END IF;

    v_code := NULLIF(btrim(COALESCE(v_order."discountCode", '')), '');
    IF v_code IS NOT NULL THEN
      PERFORM public.zshm_adjust_coupon_usage(v_code, CASE WHEN v_going THEN -1 ELSE 1 END);
    END IF;
  END IF;

  -- 4. Status write (same transaction as the stock/coupon writes above).
  UPDATE public.orders
     SET status = p_new_status,
         timestamps = COALESCE(p_timestamps, timestamps)
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'changed', true,
                            'from', v_order.status, 'to', p_new_status,
                            'warnings', v_warnings);
END;
$$;

-- ── 2) ATOMIC ORDER DELETION ──────────────────────────────────────────────────
-- Deletes the order row and restores stock/coupon usage in the SAME transaction.
-- A Cancelled order already had stock/coupon restored by
-- atomic_set_order_status, so deletion never restores them a second time.
-- A product that no longer exists is reported as a warning (there is nothing to
-- restore) instead of blocking deletion forever; any other failure raises, which
-- rolls the whole transaction back and keeps the order row intact.
--
-- ⚠ Lost-product warning: atomic_adjust_stock() validates ALL products before
-- writing any. If one product row is missing, it returns missing_product and
-- writes nothing, so deletion proceeds with stockRestored=false and the OTHER
-- valid lines are NOT restored. The warning is returned to the admin API. This
-- is irreversible inventory loss for those lines; see §0 header.
CREATE OR REPLACE FUNCTION public.atomic_delete_order(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_items jsonb;
  v_lines jsonb;
  v_stock jsonb;
  v_was_cancelled boolean;
  v_restored boolean := false;
  v_warnings jsonb := '[]'::jsonb;
  v_code text;
  v_skipped integer := 0;
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  v_was_cancelled := lower(COALESCE(v_order.status, '')) = 'cancelled';

  IF NOT v_was_cancelled THEN
    -- Legacy-safe parse: double-encoded strings, non-arrays and invalid lines
    -- are tolerated and counted instead of aborting the delete.
    v_items := public.zshm_order_items(v_order.items);
    v_lines := public.zshm_order_lines(v_items);
    v_skipped := public.zshm_order_skipped_lines(v_items);
    IF v_skipped > 0 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'legacy_items_skipped', 'count', v_skipped));
    END IF;

    IF jsonb_array_length(v_lines) > 0 THEN
      v_stock := public.atomic_adjust_stock(v_lines, 1);
      IF COALESCE((v_stock ->> 'ok')::boolean, false) IS TRUE THEN
        v_restored := true;
      ELSIF (v_stock ->> 'reason') = 'missing_product' THEN
        -- See the ⚠ warning above: NO line is restored in this branch.
        v_warnings := v_warnings || jsonb_build_array(v_stock);
      ELSE
        RAISE EXCEPTION 'atomic_delete_order: stock restore failed: %', v_stock;
      END IF;
    END IF;

    v_code := NULLIF(btrim(COALESCE(v_order."discountCode", '')), '');
    IF v_code IS NOT NULL THEN
      PERFORM public.zshm_adjust_coupon_usage(v_code, -1);
    END IF;
  END IF;

  DELETE FROM public.orders WHERE id = p_id;

  RETURN jsonb_build_object('ok', true, 'deleted', true,
                            'stockRestored', v_restored,
                            'wasCancelled', v_was_cancelled,
                            'warnings', v_warnings);
END;
$$;

-- ── 3) PRIVILEGES ─────────────────────────────────────────────────────────────
-- SECURITY INVOKER (default) + service_role only, exactly like the other
-- zshm_* functions. The browser / a logged-in user can never call them.
REVOKE ALL ON FUNCTION public.atomic_set_order_status(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atomic_delete_order(text)
  FROM PUBLIC, anon, authenticated;
-- Internal legacy parsers: executable only by the service role that calls the
-- two lifecycle functions (SECURITY INVOKER).
REVOKE ALL ON FUNCTION public.zshm_order_items(jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_order_lines(jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_order_skipped_lines(jsonb) FROM PUBLIC, anon, authenticated;
-- Coupon usage helper: defined in THIS file, so its grants belong here (the
-- place-order file is applied first and must not reference it).
REVOKE ALL ON FUNCTION public.zshm_adjust_coupon_usage(text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_set_order_status(text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_delete_order(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_items(jsonb)        TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_lines(jsonb)        TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_skipped_lines(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_adjust_coupon_usage(text, integer)
  TO service_role;

-- ── 4) POST-APPLY VERIFICATION (read-only; run after applying) ───────────────
-- SELECT proname, prosecdef, proconfig, proacl
--   FROM pg_proc
--  WHERE proname IN ('atomic_set_order_status', 'atomic_delete_order');
-- SELECT has_function_privilege('anon',
--          'public.atomic_set_order_status(text,text,text,jsonb)', 'EXECUTE') AS anon_can,
--        has_function_privilege('service_role',
--          'public.atomic_set_order_status(text,text,text,jsonb)', 'EXECUTE') AS svc_can;

-- ── 5) ROLLBACK POLICY ──────────────────────────────────────────────────────
-- Never drop deployed lifecycle functions without a reviewed replacement.
-- Restore previous function definitions only through a reviewed rollback.
-- Never remove shared helper functions used by other production functions.