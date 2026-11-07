-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · PHASE 2 · ATOMIC ORDER EDIT
--
-- Lets the owner correct a live order (customer details, phone, address, items
-- and coupon) without breaking the stock or coupon invariants:
--
--   * the order row is locked FIRST (`SELECT ... FOR UPDATE`), exactly like
--     atomic_set_order_status / atomic_delete_order;
--   * the caller passes the revision it read (`timestamps.rev`). Two admins
--     editing the same order therefore cannot lose an update: the second call
--     gets `rev_conflict` instead of overwriting the first;
--   * items may only change while the order is Pending or Confirmed. Customer
--     details stay editable in every status, as agreed with the owner;
--   * stock is reconciled by NET DIFFERENCE, not restore-then-deduct. An
--     unchanged line needs no availability, a larger quantity only needs the
--     extra units, and a smaller quantity restores the difference. This avoids
--     rejecting a same-quantity edit when the variant pool is already reserved;
--   * the deduction pass is strict and runs BEFORE the restore pass, so a
--     rejected increase writes nothing. Any later failure (coupon validation,
--     order update) rolls the whole function back through one nested block;
--   * a changed/kept coupon is re-validated against the NEW subtotal and its
--     usage counter moves exactly once (old -1, new +1) in the same
--     transaction. Keeping the same coupon does not touch its counter, so the
--     unit this order already consumed is never double-counted;
--   * a missing product/variant on the OLD lines is tolerated and reported in
--     `warnings` (partial restore), while a missing product/variant on the NEW
--     lines is a hard failure — the edited order must be sellable.
--
-- Lock order stays `orders` → `products` → `coupons`, identical to the
-- lifecycle functions, so cancel/delete/edit cannot deadlock each other.
--
-- Apply ONLY in the Supabase SQL Editor after owner approval, AFTER
-- atomic_order_lifecycle.sql (it uses zshm_order_items/zshm_order_lines/
-- zshm_adjust_coupon_usage/atomic_adjust_stock) and AFTER the matching
-- api/admin/orders.js changes are reviewed.
--
-- Idempotent: CREATE OR REPLACE + idempotent grants.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.atomic_edit_order(
  p_id text,
  p_expected_rev integer,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_items jsonb;
  v_old_lines jsonb;
  v_new_lines jsonb;
  v_restore jsonb := '[]'::jsonb;
  v_deduct jsonb := '[]'::jsonb;
  v_stock jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_old_rev integer;
  v_new_rev integer;
  v_items_changed boolean;
  v_old_code text;
  v_new_code text;
  v_code_changed boolean;
  v_subtotal numeric;
  v_discount numeric;
  v_total numeric;
  v_coupon public.coupons%ROWTYPE;
  v_coupon_found boolean := false;
  v_coupon_value numeric;
  v_min_order numeric;
  v_max_discount numeric;
  v_calc_discount numeric;
  v_today text;
  v_coupon_result jsonb;
  v_timestamps jsonb;
  v_key RECORD;
  v_skipped integer := 0;
  -- Business failures that happen AFTER a stock write (coupon validation) need
  -- a real rollback. We raise a private SQLSTATE and catch it outside the write
  -- block, so the function can still return a structured `{ok:false}` reason.
  v_fail_reason text;
  v_fail_data jsonb := '{}'::jsonb;
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_expected_rev IS NULL OR p_expected_rev < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  -- 1. Lock the order row. Everything below runs under this lock.
  SELECT * INTO v_order FROM public.orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 2. Optimistic concurrency on the revision stored in timestamps.
  v_old_rev := CASE
    WHEN v_order.timestamps IS NOT NULL
     AND jsonb_typeof(v_order.timestamps) = 'object'
     AND COALESCE(v_order.timestamps ->> 'rev', '') ~ '^[0-9]{1,9}$'
    THEN (v_order.timestamps ->> 'rev')::integer
    ELSE 0
  END;
  IF v_old_rev <> p_expected_rev THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rev_conflict', 'rev', v_old_rev);
  END IF;

  -- 3. Item edits are only allowed in the two pre-fulfilment statuses.
  v_items_changed := (p_patch ? 'items');
  IF v_items_changed AND v_order.status NOT IN ('Pending', 'Confirmed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'items_locked',
                              'status', v_order.status);
  END IF;

  v_subtotal := COALESCE(NULLIF(p_patch ->> 'subtotal', '')::numeric, v_order.subtotal, 0);
  v_discount := COALESCE(NULLIF(p_patch ->> 'discount', '')::numeric, v_order.discount, 0);
  v_total := COALESCE(NULLIF(p_patch ->> 'total', '')::numeric, v_order.total, 0);
  IF v_subtotal < 0 OR v_discount < 0 OR v_total < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  v_old_code := upper(NULLIF(btrim(COALESCE(v_order."discountCode", '')), ''));
  IF p_patch ? 'discountCode' THEN
    v_new_code := upper(NULLIF(btrim(COALESCE(p_patch ->> 'discountCode', '')), ''));
  ELSE
    v_new_code := v_old_code;
  END IF;
  v_code_changed := COALESCE(v_new_code, '') IS DISTINCT FROM COALESCE(v_old_code, '');

  -- 4. Build the NET stock difference. Lines are grouped by product + size +
  --    colour (never by a concatenated key, because a colour can contain '-').
  IF v_items_changed THEN
    v_items := public.zshm_order_items(p_patch -> 'items');
    IF jsonb_typeof(v_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_items) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
    END IF;

    v_new_lines := public.zshm_order_lines(v_items);
    IF jsonb_array_length(v_new_lines) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
    END IF;
    v_old_lines := public.zshm_order_lines(public.zshm_order_items(v_order.items));
    v_skipped := public.zshm_order_skipped_lines(public.zshm_order_items(v_order.items));
    IF v_skipped > 0 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'legacy_items_skipped', 'count', v_skipped));
    END IF;

    FOR v_key IN
      WITH old_lines AS (
        SELECT (it ->> 'productId')::bigint AS pid,
               COALESCE(it ->> 'size', '')  AS size,
               COALESCE(it ->> 'color', '') AS color,
               SUM((it ->> 'qty')::integer)::integer AS qty
          FROM jsonb_array_elements(v_old_lines) AS it
         GROUP BY 1, 2, 3
      ), new_lines AS (
        SELECT (it ->> 'productId')::bigint AS pid,
               COALESCE(it ->> 'size', '')  AS size,
               COALESCE(it ->> 'color', '') AS color,
               SUM((it ->> 'qty')::integer)::integer AS qty
          FROM jsonb_array_elements(v_new_lines) AS it
         GROUP BY 1, 2, 3
      )
      SELECT COALESCE(o.pid, n.pid)     AS pid,
             COALESCE(o.size, n.size)   AS size,
             COALESCE(o.color, n.color) AS color,
             COALESCE(o.qty, 0)         AS old_qty,
             COALESCE(n.qty, 0)         AS new_qty
        FROM old_lines o
        FULL OUTER JOIN new_lines n
          ON o.pid = n.pid AND o.size = n.size AND o.color = n.color
    LOOP
      IF v_key.old_qty > v_key.new_qty THEN
        v_restore := v_restore || jsonb_build_array(jsonb_build_object(
          'productId', v_key.pid,
          'qty', v_key.old_qty - v_key.new_qty,
          'size', v_key.size,
          'color', v_key.color
        ));
      ELSIF v_key.new_qty > v_key.old_qty THEN
        v_deduct := v_deduct || jsonb_build_array(jsonb_build_object(
          'productId', v_key.pid,
          'qty', v_key.new_qty - v_key.old_qty,
          'size', v_key.size,
          'color', v_key.color
        ));
      END IF;
    END LOOP;
  END IF;

  -- 5. Writes. Deduct first (strict, fails before writing), restore second
  --    (tolerant, reports missing products/variants), then coupon + order.
  BEGIN
    IF jsonb_array_length(v_deduct) > 0 THEN
      v_stock := public.atomic_adjust_stock(v_deduct, -1);
      IF COALESCE((v_stock ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_fail_reason := COALESCE(v_stock ->> 'reason', 'stock_failed');
        v_fail_data := v_stock;
        RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
      END IF;
    END IF;

    IF jsonb_array_length(v_restore) > 0 THEN
      v_stock := public.atomic_adjust_stock(v_restore, 1);
      IF COALESCE((v_stock ->> 'ok')::boolean, false) IS NOT TRUE THEN
        v_fail_reason := COALESCE(v_stock ->> 'reason', 'stock_failed');
        v_fail_data := v_stock;
        RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
      END IF;
      v_warnings := v_warnings || COALESCE(v_stock -> 'warnings', '[]'::jsonb);
    END IF;

    -- Coupon is re-validated against the NEW subtotal. We only enter this block
    -- when the items or the code changed, so a customer-only edit never
    -- re-validates a coupon that was valid when the order was placed.
    IF v_items_changed OR v_code_changed THEN
      IF v_new_code IS NOT NULL THEN
        SELECT * INTO v_coupon
          FROM public.coupons
         WHERE code = v_new_code
         FOR UPDATE;
        v_coupon_found := FOUND;

        IF NOT v_coupon_found THEN
          v_fail_reason := 'coupon_unavailable';
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;

        v_today := to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD');
        IF v_coupon.active IS NOT TRUE
           OR v_coupon."startDate" IS NULL
           OR v_coupon."endDate" IS NULL
           OR (v_coupon."startDate")::text > v_today
           OR (v_coupon."endDate")::text < v_today THEN
          v_fail_reason := 'coupon_unavailable';
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;

        -- A NEW code must still have a free usage slot. Keeping the same code
        -- is allowed even when this order consumed the last slot.
        IF v_code_changed
           AND COALESCE(v_coupon."usageCount", 0) >= COALESCE(v_coupon."usageLimit", 0) THEN
          v_fail_reason := 'coupon_unavailable';
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;

        v_coupon_value := CASE
          WHEN v_coupon.value IS NOT NULL AND v_coupon.value::numeric >= 0
          THEN v_coupon.value::numeric
          ELSE v_coupon."discountValue"::numeric
        END;
        IF v_coupon_value IS NULL OR v_coupon_value <= 0 THEN
          v_fail_reason := 'coupon_unavailable';
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;

        v_min_order := GREATEST(COALESCE(v_coupon."minOrderAmount"::numeric, 0), 0);
        IF v_min_order > 0 AND v_subtotal < v_min_order THEN
          v_fail_reason := 'coupon_changed';
          v_fail_data := jsonb_build_object('discount', 0);
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;

        IF v_coupon.type = 'percentage' THEN
          v_calc_discount := round(v_subtotal * v_coupon_value / 100);
        ELSE
          v_calc_discount := v_coupon_value;
        END IF;
        v_max_discount := COALESCE(v_coupon."maxDiscount"::numeric, 0);
        IF v_max_discount > 0 THEN
          v_calc_discount := LEAST(v_calc_discount, v_max_discount);
        END IF;
        v_calc_discount := GREATEST(LEAST(v_calc_discount, v_subtotal), 0);

        IF v_calc_discount <= 0 OR v_calc_discount <> v_discount THEN
          v_fail_reason := 'coupon_changed';
          v_fail_data := jsonb_build_object('discount', v_calc_discount);
          RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
        END IF;
      ELSIF v_discount <> 0 THEN
        -- No code but a discount was requested: never trust a discount the
        -- database did not derive from a coupon row.
        v_fail_reason := 'coupon_changed';
        v_fail_data := jsonb_build_object('discount', 0);
        RAISE EXCEPTION 'zshm_edit_failed' USING ERRCODE = 'Z9001';
      END IF;

      IF v_code_changed THEN
        IF v_old_code IS NOT NULL THEN
          v_coupon_result := public.zshm_adjust_coupon_usage(v_old_code, -1);
          IF (v_coupon_result ->> 'warning') IS NOT NULL THEN
            v_warnings := v_warnings || jsonb_build_array(v_coupon_result);
          END IF;
        END IF;
        IF v_new_code IS NOT NULL THEN
          UPDATE public.coupons
             SET "usageCount" = COALESCE("usageCount", 0) + 1
           WHERE code = v_new_code;
        END IF;
      END IF;
    END IF;

    v_timestamps := CASE
      WHEN v_order.timestamps IS NOT NULL
       AND jsonb_typeof(v_order.timestamps) = 'object'
      THEN v_order.timestamps
      ELSE '{}'::jsonb
    END;
    v_new_rev := v_old_rev + 1;

    UPDATE public.orders
       SET customer = COALESCE(p_patch ->> 'customer', v_order.customer),
           phone = COALESCE(p_patch ->> 'phone', v_order.phone),
           "phoneAlt" = COALESCE(p_patch ->> 'phoneAlt', v_order."phoneAlt"),
           email = COALESCE(p_patch ->> 'email', v_order.email),
           address = COALESCE(p_patch ->> 'address', v_order.address),
           city = COALESCE(p_patch ->> 'city', v_order.city),
           notes = COALESCE(p_patch ->> 'notes', v_order.notes),
           items = CASE WHEN v_items_changed THEN v_items ELSE v_order.items END,
           subtotal = v_subtotal,
           discount = v_discount,
           total = v_total,
           "discountCode" = v_new_code,
           timestamps = v_timestamps || jsonb_build_object(
             'edited', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'rev', v_new_rev
           )
     WHERE id = p_id;
  EXCEPTION WHEN SQLSTATE 'Z9001' THEN
    -- Stock/coupon writes above are rolled back by PostgreSQL; only the
    -- structured reason is kept and returned below.
    NULL;
  END;

  IF v_fail_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_fail_reason) || v_fail_data;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'rev', v_new_rev,
    'warnings', v_warnings
  );
END;
$$;

-- ── PRIVILEGES ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.atomic_edit_order(text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_edit_order(text, integer, jsonb)
  TO service_role;

-- ── POST-APPLY VERIFICATION (read-only; run after applying) ──────────────────
-- SELECT proname, prosecdef, proconfig, proacl
--   FROM pg_proc
--  WHERE proname = 'atomic_edit_order';
-- SELECT has_function_privilege('anon',
--          'public.atomic_edit_order(text,integer,jsonb)', 'EXECUTE') AS anon_can,
--        has_function_privilege('service_role',
--          'public.atomic_edit_order(text,integer,jsonb)', 'EXECUTE') AS svc_can;
-- SELECT id, subtotal, discount, total, "discountCode", status, timestamps
--   FROM public.orders ORDER BY date DESC LIMIT 5;

-- ── ROLLBACK POLICY ──────────────────────────────────────────────────────────
-- Deployed order edits must not be dropped without a reviewed replacement.
-- Reverting only the API (before this migration is applied) needs no SQL change.
-- If the function truly must be removed after review:
--   DROP FUNCTION IF EXISTS public.atomic_edit_order(text, integer, jsonb);
