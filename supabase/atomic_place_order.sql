-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · H-02 · ATOMIC ORDER PLACEMENT + ATOMIC STOCK ADJUSTMENT
-- REVISION 4 — availability pass now AGGREGATES demand per (productId, size,
-- color) before checking, so a cart that splits the same variation across
-- multiple lines can no longer oversell it. Mirrors api/orders.js.
-- REVISION 3 — REVISION 2 function bodies had a real bug found by the first
-- concurrency run: products/orders columns are stored with QUOTED camelCase
-- ("variantStock", "reservedStock", "discountCode", "phoneAlt"), so unquoted
-- plpgsql identifiers folded to lowercase and the bodies never executed.
-- This revision quotes those identifiers. Sections 1-2 & 5 are idempotent, so
-- pasting the full file again is safe (re-RUN approved).
-- Apply ONLY in the Supabase SQL Editor after your approval.
-- Apply ONLY in the Supabase SQL Editor after your approval; and BEFORE the
-- matching api/orders.js / api/admin/orders.js changes are deployed.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PRE-FLIGHT CHECKS (run these first; they are READ-ONLY) ────────────────
-- Expected (verified via PostgREST OpenAPI on 2026-10-09):
--   orders.id text PRIMARY KEY; orders.subtotal/discount/total numeric;
--   orders.items/timestamps jsonb; orders.date text; orders.idempotency_key (new)
--   products.id bigint PK; products.stock integer DEFAULT 0;
--   products.variantStock jsonb (keys "<size>-<color>" → int);
--   products.reservedStock integer DEFAULT 0
-- The two queries below must be run by you (they are blocked by PostgREST here),
-- because triggers/constraints are NOT visible through the REST API:
SELECT tgname, tgrelid::regclass, tgenabled
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgrelid IN ('public.products'::regclass, 'public.orders'::regclass, 'public.coupons'::regclass)
ORDER BY tgrelid::regclass, tgname;

SELECT conname, conrelid::regclass, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('public.products'::regclass, 'public.orders'::regclass, 'public.coupons'::regclass)
ORDER BY conrelid::regclass, conname;

-- ── 1) IDEMPOTENCY COLUMN + PARTIAL UNIQUE INDEX (additive, safe) ─────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_unique
  ON public.orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── 2) INTERNAL HELPER: canonical signature of an order's lines ───────────────
-- Used to guarantee that reusing an idempotency key with DIFFERENT items is
-- rejected (key reuse is only honoured for the exact same cart).
CREATE OR REPLACE FUNCTION public.zshm_order_signature(p_items jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(string_agg(x, '|' ORDER BY x), '')
  FROM (
    SELECT (it ->> 'productId')::text || ':' ||
           (it ->> 'qty')::text || ':' ||
           COALESCE(it ->> 'size', '') || ':' ||
           COALESCE(it ->> 'color', '') AS x
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(p_items) = 'string'
          THEN (p_items #>> '{}')::jsonb   -- legacy double-encoded rows
        ELSE COALESCE(p_items, '[]'::jsonb)
      END
    ) AS it
  ) AS t;
$$;

-- ── 3) ATOMIC ORDER PLACEMENT ─────────────────────────────────────────────────
-- One PostgreSQL transaction (a single function call) = the ONLY writer that
-- decrements stock for new orders. Guarantees:
--   * Row locking in ascending id order  → no deadlocks; concurrent orders for
--     the last unit are serialized and the loser reads the CURRENT (already
--     decremented) value, so the variant / product can never be oversold.
--   * Availability is validated against the committed value while the row lock
--     is held (no JS-only check anywhere).
--   * Order INSERT + stock decrement are atomic: either every line ships and
--     the order row exists, or nothing changed (no partial stock, no orphan
--     orders, no hand-rolled JS rollback).
--   * Same idempotency_key ⇒ same order, checked BOTH before and after locking
--     (after locking is authoritative, so a re-try that raced the original
--     request resolves to "duplicate" instead of a stock error).
--   * A reused key with DIFFERENT items ⇒ rejected (idempotency_conflict).
-- All money fields (subtotal/discount/total) are computed by api/orders.js from
-- DB prices/coupon/shipping — the client cannot call this function
-- (REVOKEd below) and never sends a trusted price.
CREATE OR REPLACE FUNCTION public.atomic_place_order(
  p_order jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_items jsonb := COALESCE(p_order -> 'items', '[]'::jsonb);
  v_line RECORD;
  v_prod products%ROWTYPE;
  v_id bigint;
  v_available integer;
  v_var jsonb;
  v_total_qty integer;
  v_existing text;
  v_existing_items jsonb;
  v_sig text;
BEGIN
  -- Defense-in-depth payload checks (the API validates first).
  IF jsonb_typeof(p_order) <> 'object'
     OR jsonb_typeof(v_items) <> 'array'
     OR jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_idempotency_key IS NOT NULL
     AND (length(p_idempotency_key) NOT BETWEEN 8 AND 64
          OR p_idempotency_key !~ '^[A-Za-z0-9._-]+$') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_idempotency_key');
  END IF;

  CREATE TEMP TABLE _zshm_stock_delta (
    id bigint NOT NULL,
    vkey text NOT NULL DEFAULT '',
    qty integer NOT NULL
  ) ON COMMIT DROP;

  -- Fast idempotency path (no locks needed): the first request already committed.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, items INTO v_existing, v_existing_items
      FROM public.orders WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_sig := public.zshm_order_signature(COALESCE(v_existing_items, '[]'::jsonb));
      IF v_sig = public.zshm_order_signature(v_items) THEN
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'orderId', v_existing);
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict',
                                'orderId', v_existing);
    END IF;
  END IF;

  -- Lock every product row, ascending id (deterministic → deadlock-free) and
  -- fail fast on a product that disappeared.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint AS id
    FROM jsonb_array_elements(v_items) AS it
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.products WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'missing_product',
                                'productId', v_id);
    END IF;
  END LOOP;

  -- Authoritative idempotency re-check: a concurrent request with the SAME key
  -- that raced us and already committed is now visible (locks are serialized).
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := NULL;
    v_existing_items := NULL;
    SELECT id, items INTO v_existing, v_existing_items
      FROM public.orders WHERE idempotency_key = p_idempotency_key LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_sig := public.zshm_order_signature(COALESCE(v_existing_items, '[]'::jsonb));
      IF v_sig = public.zshm_order_signature(v_items) THEN
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'orderId', v_existing);
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict',
                                'orderId', v_existing);
    END IF;
  END IF;

  -- Availability pass — rows are locked, values are CURRENT/committed.
  -- Demand is AGGREGATED per (productId, size, color) first: a cart that splits
  -- the same variation across several lines must not collectively oversell it.
  -- Mirrors the aggregate check in api/orders.js.
  FOR v_line IN
    SELECT
      (it ->> 'productId')::bigint                                AS id,
      SUM((it ->> 'qty')::int)                                    AS qty,
      COALESCE(it ->> 'size', '') || '-' || COALESCE(it ->> 'color', '') AS vkey,
      COALESCE(it ->> 'size', '')  AS size,
      COALESCE(it ->> 'color', '') AS color
    FROM jsonb_array_elements(v_items) AS it
    GROUP BY (it ->> 'productId')::bigint,
             COALESCE(it ->> 'size', '') || '-' || COALESCE(it ->> 'color', ''),
             COALESCE(it ->> 'size', ''),
             COALESCE(it ->> 'color', '')
    ORDER BY (it ->> 'productId')::bigint
  LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_line.id;

    -- Mirror api/orders.js exactly: when the product HAS variants (non-empty
    -- variantStock object), availability comes ONLY from the variant key — a
    -- missing key means 0. Only fall back to global stock for products with no
    -- variants, else 99. COALESCE(null-cast, 0) mirrors Number(undefined)=0.
    -- Columns are stored quoted-camelCase → MUST quote the identifiers.
    IF v_prod."variantStock" IS NOT NULL
       AND jsonb_typeof(v_prod."variantStock") = 'object'
       AND v_prod."variantStock" <> '{}'::jsonb THEN
      v_available := COALESCE((v_prod."variantStock" ->> v_line.vkey)::int, 0);
    ELSIF v_prod.stock IS NOT NULL THEN
      v_available := v_prod.stock;
    ELSE
      v_available := 99;
    END IF;
    v_available := v_available - COALESCE(v_prod."reservedStock", 0);

    IF v_line.qty > v_available THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'unavailable',
        'productId', v_line.id,
        'name',     v_prod.name,
        'size',     v_line.size,
        'color',    v_line.color,
        'available', GREATEST(v_available, 0));
    END IF;

    INSERT INTO _zshm_stock_delta (id, vkey, qty)
    VALUES (v_line.id, v_line.vkey, v_line.qty);
  END LOOP;

  -- Coupon consumption is atomic with the order. api/orders.js has already
  -- validated the coupon (active + date window) and computed the discount; here
  -- the coupon row is locked and incremented ONLY if still active and below its
  -- usage limit. If it is exhausted, the whole transaction rolls back so the
  -- discount cannot be applied for free (no overshoot, no lost updates).
  IF NULLIF(p_order ->> 'discountCode', '') IS NOT NULL THEN
    UPDATE public.coupons
       SET "usageCount" = COALESCE("usageCount", 0) + 1
     WHERE code = p_order ->> 'discountCode'
       AND active = true
       AND COALESCE("usageCount", 0) < COALESCE("usageLimit", 0);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_unavailable');
    END IF;
  END IF;

  -- INSERT the order FIRST: a duplicate idempotency key (or a bizarre orderId
  -- collision) surfaces here, BEFORE any stock write — so the loser rolls back
  -- with stock untouched.
  BEGIN
    INSERT INTO public.orders (
      id, subtotal, discount, total, "discountCode", status, date,
      customer, phone, "phoneAlt", email, address, city, notes,
      items, timestamps, tracking_url, idempotency_key
    ) VALUES (
      p_order ->> 'id',
      (p_order ->> 'subtotal')::numeric,
      (p_order ->> 'discount')::numeric,
      (p_order ->> 'total')::numeric,
      NULLIF(p_order ->> 'discountCode', ''),
      p_order ->> 'status',
      p_order ->> 'date',
      p_order ->> 'customer',
      p_order ->> 'phone',
      p_order ->> 'phoneAlt',
      p_order ->> 'email',
      p_order ->> 'address',
      p_order ->> 'city',
      p_order ->> 'notes',
      p_order -> 'items',
      p_order -> 'timestamps',
      p_order ->> 'tracking_url',
      p_idempotency_key
    );
  EXCEPTION WHEN unique_violation THEN
    IF p_idempotency_key IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.orders WHERE idempotency_key = p_idempotency_key) THEN
      SELECT id INTO v_existing
        FROM public.orders WHERE idempotency_key = p_idempotency_key LIMIT 1;
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'orderId', v_existing);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'order_id_collision');
  END;

  -- Decrement pass — atomic with the INSERT above (same transaction).
  FOR v_id IN SELECT DISTINCT id FROM _zshm_stock_delta ORDER BY id LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_id;
    v_var := v_prod."variantStock";
    IF v_var IS NULL THEN v_var := '{}'::jsonb; END IF;

    SELECT COALESCE(SUM(qty), 0)::integer INTO v_total_qty
      FROM _zshm_stock_delta WHERE id = v_id;

    -- Per-variant decrement (all variants of this product within one order).
    FOR v_line IN
      SELECT vkey, qty FROM _zshm_stock_delta
      WHERE id = v_id AND vkey <> '' AND vkey <> '-'
    LOOP
      IF v_var ? v_line.vkey THEN
        v_var := jsonb_set(
          v_var,
          ARRAY[v_line.vkey],
          to_jsonb(GREATEST(COALESCE((v_var ->> v_line.vkey)::int, 0) - v_line.qty, 0))
        );
      END IF;
    END LOOP;

    UPDATE public.products
       SET stock        = GREATEST(COALESCE(products.stock, 0) - v_total_qty, 0),
           "variantStock" = v_var
     WHERE id = v_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'orderId', p_order ->> 'id');
END;
$$;

-- ── 4) ATOMIC STOCK ADJUSTMENT ────────────────────────────────────────────────
-- Used by ORDER CANCELLATION / UN-CANCELLATION and ORDER DELETION to restore or
-- re-deduct stock. This is the OTHER writer of products.stock / variantStock;
-- making it row-locked too closes the "cancel racing a concurrent order" hole
-- (previously a JS read-modify-write with no lock could lose a decrement).
--   p_lines: [{ productId, qty, size, color }]   p_delta: +1 restore | -1 deduct
CREATE OR REPLACE FUNCTION public.atomic_adjust_stock(
  p_lines jsonb,
  p_delta integer
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line RECORD;
  v_prod products%ROWTYPE;
  v_id bigint;
  v_var jsonb;
  v_new integer;
BEGIN
  IF jsonb_typeof(p_lines) <> 'array' OR p_lines = '[]'::jsonb
     OR p_delta NOT IN (-1, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;

  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint AS id
    FROM jsonb_array_elements(p_lines) AS it
    ORDER BY 1
  LOOP
    PERFORM 1 FROM public.products WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'missing_product',
                                'productId', v_id);
    END IF;
  END LOOP;

  FOR v_line IN
    SELECT (it ->> 'productId')::bigint AS id,
           (it ->> 'qty')::int AS qty,
           COALESCE(it ->> 'size', '') || '-' || COALESCE(it ->> 'color', '') AS vkey
    FROM jsonb_array_elements(p_lines) AS it
    ORDER BY (it ->> 'productId')::bigint
  LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_line.id;
    v_var := v_prod."variantStock";
    IF v_var IS NULL THEN v_var := '{}'::jsonb; END IF;

    IF v_var ? v_line.vkey THEN
      v_new := GREATEST(COALESCE((v_var ->> v_line.vkey)::int, 0) + p_delta * v_line.qty, 0);
      v_var := jsonb_set(v_var, ARRAY[v_line.vkey], to_jsonb(v_new));
    END IF;

    UPDATE public.products
       SET stock        = GREATEST(COALESCE(products.stock, 0) + p_delta * v_line.qty, 0),
           "variantStock" = v_var
     WHERE id = v_line.id;
  END LOOP;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── 4b) ATOMIC COUPON USAGE ADJUSTMENT ───────────────────────────────────────
-- Single-statement signed delta (clamped at zero), used by order cancellation /
-- un-cancellation / deletion. Replaces the select-then-update read-modify-write
-- that could lose a concurrent placement increment. Best-effort by design:
-- usageCount is advisory, so callers ignore the result.
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
    RETURN jsonb_build_object('ok', true, 'skipped', true);
  END IF;
  UPDATE public.coupons
     SET "usageCount" = GREATEST(COALESCE("usageCount", 0) + p_delta, 0)
   WHERE code = btrim(p_code);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$$;

-- ── 5) PRIVILEGES: only the service role may execute these ────────────────────
-- Functions are SECURITY INVOKER (default). That is what we want here: the API
-- calls with the service-role key, which ALREADY bypasses RLS and has full
-- access — a SECURITY DEFINER would only add an unnecessary privilege-escalation
-- surface if the grants were ever misconfigured. anon/authenticated are revoked
-- so the function can never be invoked by the browser or a logged-in user.
REVOKE ALL ON FUNCTION public.atomic_place_order(jsonb, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atomic_adjust_stock(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_order_signature(jsonb)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_adjust_coupon_usage(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_place_order(jsonb, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_adjust_stock(jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_signature(jsonb)         TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_adjust_coupon_usage(text, integer) TO service_role;

-- ── 6) POST-APPLY VERIFICATION (run after applying) ───────────────────────────
-- SELECT proname, provolatile FROM pg_proc
-- WHERE proname IN ('atomic_place_order', 'atomic_adjust_stock', 'zshm_order_signature');
-- SELECT has_function_privilege('anon', 'public.atomic_place_order(jsonb, text)', 'EXECUTE') AS anon_can,
--        has_function_privilege('service_role', 'public.atomic_place_order(jsonb, text)', 'EXECUTE') AS svc_can;
-- SELECT indexdef FROM pg_indexes
-- WHERE tablename = 'orders' AND indexname = 'orders_idempotency_key_unique';

-- ── 7) ROLLBACK (if anything regresses; order rows written AFTER apply keep the
--        new column — dropping it is safe and keeps data intact) ───────────────
-- DROP FUNCTION IF EXISTS public.atomic_place_order(jsonb, text);
-- DROP FUNCTION IF EXISTS public.atomic_adjust_stock(jsonb, integer);
-- DROP FUNCTION IF EXISTS public.zshm_order_signature(jsonb);
-- DROP INDEX IF EXISTS orders_idempotency_key_unique;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS idempotency_key;