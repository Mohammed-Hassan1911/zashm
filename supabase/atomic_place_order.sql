-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · H-02 · ATOMIC ORDER PLACEMENT + ATOMIC STOCK ADJUSTMENT
-- REVISION 8 — reservedStock is no longer subtracted from availability. No
-- process writes or expires that column, so subtracting it permanently hid
-- sellable stock. The column is retained but is not part of availability.
-- atomic_adjust_stock() now supports PARTIAL RESTORE: when p_delta = +1, a
-- product (or variant) that no longer exists is skipped and reported as a
-- warning, so the remaining lines are still restored. Deduction (p_delta = -1)
-- stays strict and returns missing_product / missing_variant.
-- REVISION 7 — non-variant aggregation + strict payload parsing. Demand for a
-- product WITHOUT variants is now summed across ALL of its cart lines (any
-- size/color) and compared once with global stock; products WITH variants are
-- still checked per variant. JSON type checks are separate statements, so a
-- non-array payload can never reach jsonb_array_length() (no raw SQL error).
-- The coupon-usage helper now lives in atomic_order_lifecycle.sql, so its grants
-- were removed from this file (this file is applied first and must not
-- reference a function that does not exist yet).
-- REVISION 6 — idempotency race hardening. The unique_violation handler now
-- compares the stored cart signature before answering duplicate=true, so a
-- racing request that reuses a key with a DIFFERENT cart is told
-- `idempotency_conflict` (never a false duplicate). Coupon usageCount is only
-- written AFTER the order INSERT succeeds, so a duplicate key or an INSERT
-- failure can no longer consume a coupon. See scripts/test-sql-concurrency.mjs.
-- REVISION 5 — coupon pricing is now RECOMPUTED inside this function from the
-- locked coupon row (active/date/usage/minOrderAmount/maxDiscount plus the
-- value↔discountValue alias) and compared with p_order->>'discount'; a mismatch
-- returns `coupon_changed` and rolls back. Also rejects `inactive_product`
-- (SEC-11). Mirrors api/_lib.js computeCouponDiscount() exactly.
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
--   products.reservedStock integer DEFAULT 0 (retained, but NOT used for
--     availability — verified all-zero in production on 2026-11-01)
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
  v_items jsonb;
  v_line RECORD;
  v_prod products%ROWTYPE;
  v_id bigint;
  v_available integer;
  v_var jsonb;
  v_has_variants boolean;
  v_total_qty integer;
  v_existing text;
  v_existing_items jsonb;
  v_sig text;
  v_coupon public.coupons%ROWTYPE;
  v_coupon_value numeric;
  v_subtotal numeric;
  v_discount numeric;
  v_min_order numeric;
  v_max_discount numeric;
  v_today text;
BEGIN
  -- Defense-in-depth payload checks (the API validates first). Every type test
  -- is its own statement: PostgreSQL does not promise AND/OR short-circuiting,
  -- so jsonb_array_length() must never be evaluated for a non-array.
  IF p_order IS NULL OR jsonb_typeof(p_order) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  v_items := p_order -> 'items';
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_items) AS it
     WHERE jsonb_typeof(it) <> 'object'
        OR COALESCE(it ->> 'productId', '') !~ '^[1-9][0-9]{0,17}$'
        OR COALESCE(it ->> 'qty', '') !~ '^[1-9][0-9]{0,8}$'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_line');
  END IF;
  -- Required scalars are validated before any cast, so a malformed string can
  -- never raise `invalid input syntax for type numeric` from this function.
  IF NULLIF(btrim(COALESCE(p_order ->> 'id', '')), '') IS NULL
     OR COALESCE(p_order ->> 'subtotal', '') !~ '^[0-9]+([.][0-9]+)?$'
     OR COALESCE(p_order ->> 'discount', '') !~ '^[0-9]+([.][0-9]+)?$'
     OR COALESCE(p_order ->> 'total', '') !~ '^[0-9]+([.][0-9]+)?$' THEN
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
  -- Demand is AGGREGATED before checking: variants are compared per
  -- (product, size, color); products WITHOUT variants share one global stock
  -- value, so ALL of their lines are summed per product and checked once.
  -- Mirrors the aggregate check in api/orders.js.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint AS id
    FROM jsonb_array_elements(v_items) AS it
    ORDER BY 1
  LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_id;

    -- SEC-11: a product deactivated in the console must not be sellable, even
    -- if it is still sitting in a shopper's saved cart. api/orders.js rejects
    -- it first; this is the authoritative check.
    IF v_prod.active IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'inactive_product',
                                'productId', v_id);
    END IF;

    -- A non-empty object is the ONLY source of truth for variant demand: a
    -- missing key means 0. Only products without variants fall back to global
    -- stock (legacy NULL → 99, mirroring Number(undefined) in the API).
    -- Columns are quoted-camelCase → the identifiers MUST be quoted.
    v_has_variants := v_prod."variantStock" IS NOT NULL
      AND jsonb_typeof(v_prod."variantStock") = 'object'
      AND v_prod."variantStock" <> '{}'::jsonb;

    -- Products that declare sizes/colors but have no variant pool are not
    -- sellable: reject instead of falling back to a global counter.
    IF ((v_prod.sizes IS NOT NULL AND jsonb_typeof(v_prod.sizes) = 'array' AND jsonb_array_length(v_prod.sizes) > 0)
        OR (v_prod.colors IS NOT NULL AND jsonb_typeof(v_prod.colors) = 'array' AND jsonb_array_length(v_prod.colors) > 0))
       AND NOT v_has_variants THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_product_config',
                                'productId', v_id);
    END IF;

    IF v_has_variants THEN
      FOR v_line IN
        SELECT
          COALESCE(it ->> 'size', '') || '-' || COALESCE(it ->> 'color', '') AS vkey,
          COALESCE(it ->> 'size', '')  AS size,
          COALESCE(it ->> 'color', '') AS color,
          SUM((it ->> 'qty')::int)::integer AS qty
        FROM jsonb_array_elements(v_items) AS it
        WHERE (it ->> 'productId')::bigint = v_id
        GROUP BY 1, 2, 3
        ORDER BY 1
      LOOP
        -- DECISION (2026-11-01): reservedStock is NOT subtracted. It has no
        -- writer and no expiry, so it would hide sellable stock forever. The
        -- column is kept for compatibility; availability is the variant pool.
        v_available := COALESCE(
          CASE WHEN (v_prod."variantStock" ->> v_line.vkey) ~ '^-?[0-9]+$'
               THEN (v_prod."variantStock" ->> v_line.vkey)::int
               ELSE 0 END,
          0);

        IF v_line.qty > v_available THEN
          RETURN jsonb_build_object(
            'ok', false, 'reason', 'unavailable',
            'productId', v_id,
            'name', v_prod.name,
            'size', v_line.size,
            'color', v_line.color,
            'available', GREATEST(v_available, 0),
            'requested', v_line.qty
          );
        END IF;

        INSERT INTO _zshm_stock_delta (id, vkey, qty)
        VALUES (v_id, v_line.vkey, v_line.qty);
      END LOOP;

    ELSE
      -- Products without variants: every line competes for the same stock.
      SELECT COALESCE(SUM((it ->> 'qty')::int), 0)::integer INTO v_total_qty
        FROM jsonb_array_elements(v_items) AS it
       WHERE (it ->> 'productId')::bigint = v_id;

      -- Same DECISION as the variant branch above: reservedStock is excluded.
      v_available := COALESCE(v_prod.stock, 0);

      IF v_total_qty > v_available THEN
        RETURN jsonb_build_object(
          'ok', false, 'reason', 'unavailable',
          'productId', v_id,
          'name', v_prod.name,
          'available', GREATEST(v_available, 0),
          'requested', v_total_qty
        );
      END IF;

      INSERT INTO _zshm_stock_delta (id, vkey, qty)
      VALUES (v_id, '', v_total_qty);
    END IF;
  END LOOP;

  -- Coupon consumption is atomic with the order. The coupon row is locked and
  -- EVERY pricing rule is recomputed here from the locked row — active state,
  -- Cairo date window, usage limit, minimum order, percentage cap and the
  -- value/discountValue alias. The discount the API put in p_order->>'discount'
  -- must equal the recomputed amount; otherwise `coupon_changed` rolls the
  -- whole transaction back. A client (or a racing admin edit) can therefore
  -- never grant a discount the database did not approve.
  IF NULLIF(btrim(COALESCE(p_order ->> 'discountCode', '')), '') IS NOT NULL THEN
    SELECT * INTO v_coupon
      FROM public.coupons
     WHERE code = btrim(p_order ->> 'discountCode')
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_unavailable');
    END IF;

    v_today := to_char(now() AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD');
    IF v_coupon.active IS NOT TRUE
       OR v_coupon."startDate" IS NULL
       OR v_coupon."endDate" IS NULL
       OR (v_coupon."startDate")::text > v_today
       OR (v_coupon."endDate")::text < v_today
       OR COALESCE(v_coupon."usageCount", 0) >= COALESCE(v_coupon."usageLimit", 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_unavailable');
    END IF;

    -- Canonical value is `value`; `discountValue` is the legacy alias.
v_coupon_value := CASE
  WHEN v_coupon.value IS NOT NULL
   AND v_coupon.value::numeric >= 0
  THEN v_coupon.value::numeric
  ELSE v_coupon."discountValue"::numeric
END;
    IF v_coupon_value IS NULL OR v_coupon_value <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_unavailable');
    END IF;

    v_subtotal := COALESCE((p_order ->> 'subtotal')::numeric, 0);
    v_min_order := GREATEST(COALESCE(v_coupon."minOrderAmount"::numeric, 0), 0);
    IF v_min_order > 0 AND v_subtotal < v_min_order THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_unavailable');
    END IF;

    IF v_coupon.type = 'percentage' THEN
      v_discount := round(v_subtotal * v_coupon_value / 100);
    ELSE
      v_discount := v_coupon_value;
    END IF;

    v_max_discount := COALESCE(v_coupon."maxDiscount"::numeric, 0);
    IF v_max_discount > 0 THEN
      v_discount := LEAST(v_discount, v_max_discount);
    END IF;
    v_discount := GREATEST(LEAST(v_discount, v_subtotal), 0);

    IF v_discount <= 0
       OR v_discount <> COALESCE((p_order ->> 'discount')::numeric, -1) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'coupon_changed',
                                'discount', v_discount);
    END IF;
    -- NOTE: usageCount is NOT incremented here. It is incremented after the
    -- order INSERT succeeds (below). If this transaction loses the idempotency
    -- race or the INSERT fails, the coupon must remain untouched.
  ELSIF COALESCE((p_order ->> 'discount')::numeric, 0) <> 0 THEN
    -- No code, but a discount was requested: never trust a price the database
    -- did not derive from a coupon row.
    RETURN jsonb_build_object('ok', false, 'reason', 'coupon_changed',
                              'discount', 0);
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
    -- A concurrent request won the INSERT. Re-read the winning row and compare
    -- the canonical cart signature. Reusing a key with a DIFFERENT cart must be
    -- `idempotency_conflict`, never a false duplicate=true. This is the only
    -- path where two requests with the same key can both pass the earlier
    -- checks (they locked different products), so it must be authoritative.
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
    RETURN jsonb_build_object('ok', false, 'reason', 'order_id_collision');
  END;

  -- Coupon consumption happens ONLY after the order row exists. This is what
  -- makes the insert, stock decrement and usageCount atomic as a group while a
  -- failed/duplicate INSERT leaves usageCount untouched.
  IF v_coupon.code IS NOT NULL THEN
    UPDATE public.coupons
       SET "usageCount" = COALESCE("usageCount", 0) + 1
     WHERE code = v_coupon.code;
  END IF;

  -- Decrement pass — atomic with the INSERT above (same transaction).
  FOR v_id IN SELECT DISTINCT id FROM _zshm_stock_delta ORDER BY id LOOP
    SELECT * INTO v_prod FROM public.products WHERE id = v_id;

    v_has_variants := v_prod."variantStock" IS NOT NULL
      AND jsonb_typeof(v_prod."variantStock") = 'object'
      AND v_prod."variantStock" <> '{}'::jsonb;

    IF v_has_variants THEN
      v_var := v_prod."variantStock";

      -- All lines for the same variant were aggregated by the availability
      -- pass, so each key is decremented exactly once.
      FOR v_line IN
        SELECT vkey, SUM(qty)::integer AS qty
          FROM _zshm_stock_delta
         WHERE id = v_id AND vkey <> ''
         GROUP BY vkey
      LOOP
        IF v_var ? v_line.vkey THEN
          v_var := jsonb_set(
            v_var,
            ARRAY[v_line.vkey],
            to_jsonb(GREATEST(COALESCE(
              CASE WHEN (v_var ->> v_line.vkey) ~ '^-?[0-9]+$'
                   THEN (v_var ->> v_line.vkey)::int
                   ELSE 0 END,
              0) - v_line.qty, 0))
          );
        END IF;
      END LOOP;

      -- Invariant: global stock always equals the sum of variant stock.
      UPDATE public.products
         SET "variantStock" = v_var,
             stock = (
               SELECT COALESCE(SUM(value::integer), 0)::integer
                 FROM jsonb_each_text(v_var)
             )
       WHERE id = v_id;

    ELSE
      -- No variantStock object: only the global counter moves, and the payload
      -- below never turns a legacy NULL into '{}'.
      SELECT COALESCE(SUM(qty), 0)::integer INTO v_total_qty
        FROM _zshm_stock_delta WHERE id = v_id;

      UPDATE public.products
         SET stock = GREATEST(COALESCE(v_prod.stock, 0) - v_total_qty, 0)
       WHERE id = v_id;
    END IF;
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
--   +1 (restore): missing products/variants are skipped and returned in
--      `warnings`; every existing line is still restored (`restored` > 0).
--   -1 (deduct):  missing products/variants are a hard error; nothing is written.
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
  v_prod public.products%ROWTYPE;
  v_id bigint;
  v_var jsonb;
  v_total_qty integer;
  v_has_variants boolean;
  v_available integer;
  v_touched boolean;
  v_restored integer := 0;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  -- Validate the payload. Type, length and line checks are separate statements
  -- so a non-array can never reach jsonb_array_length() or a cast.
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF p_delta IS NULL OR p_delta NOT IN (-1, 1) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_payload');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS it
     WHERE jsonb_typeof(it) <> 'object'
        OR COALESCE(it ->> 'productId', '') !~ '^[1-9][0-9]{0,17}$'
        OR COALESCE(it ->> 'qty', '') !~ '^[1-9][0-9]{0,8}$'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_line');
  END IF;

  -- Lock all products in deterministic order. A product that no longer exists
  -- is a HARD error when deducting (p_delta = -1): an order must never silently
  -- lose stock. On restore (p_delta = +1) it is skipped and reported, so the
  -- remaining, still-existing lines can be restored. This is the partial-restore
  -- contract used by cancellation and order deletion.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    ORDER BY 1
  LOOP
    PERFORM 1
    FROM public.products
    WHERE id = v_id
    FOR UPDATE;

    IF NOT FOUND THEN
      IF p_delta = 1 THEN
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
          'code', 'missing_product',
          'reason', 'missing_product',
          'productId', v_id
        ));
      ELSE
        RETURN jsonb_build_object(
          'ok', false,
          'reason', 'missing_product',
          'productId', v_id
        );
      END IF;
    END IF;
  END LOOP;

  -- Preflight: validate ALL requested stock changes before updating ANY row.
  -- Only products that still exist are examined; the missing ones were handled
  -- above (restore: warning, deduct: returned). This keeps the "validate
  -- everything, then write" guarantee for every row that will be touched.
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    WHERE EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (it ->> 'productId')::bigint
    )
    ORDER BY 1
  LOOP
    SELECT * INTO v_prod
    FROM public.products
    WHERE id = v_id;

    v_has_variants :=
      v_prod."variantStock" IS NOT NULL
      AND jsonb_typeof(v_prod."variantStock") = 'object'
      AND v_prod."variantStock" <> '{}'::jsonb;

    IF v_has_variants THEN
      FOR v_line IN
        SELECT
          COALESCE(it ->> 'size', '') || '-' ||
          COALESCE(it ->> 'color', '') AS vkey,
          SUM((it ->> 'qty')::integer)::integer AS qty
        FROM jsonb_array_elements(p_lines) AS it
        WHERE (it ->> 'productId')::bigint = v_id
        GROUP BY 1
        ORDER BY 1
      LOOP
        IF v_line.vkey IN ('', '-')
           OR NOT (v_prod."variantStock" ? v_line.vkey) THEN
          -- Restoring a variant that no longer exists must not resurrect it or
          -- block the whole restore; report it and skip that line. Deduction
          -- stays strict: selling a vanished variant is a real error.
          IF p_delta = 1 THEN
            v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
              'code', 'missing_variant',
              'reason', 'missing_variant',
              'productId', v_id,
              'variant', v_line.vkey
            ));
            CONTINUE;
          END IF;
          RETURN jsonb_build_object(
            'ok', false,
            'reason', 'missing_variant',
            'productId', v_id,
            'variant', v_line.vkey
          );
        END IF;

        -- A negative delta means stock is being deducted.
        IF p_delta = -1 THEN
          v_available :=
            COALESCE((v_prod."variantStock" ->> v_line.vkey)::integer, 0);
          IF v_line.qty > v_available THEN
            RETURN jsonb_build_object(
              'ok', false,
              'reason', 'unavailable',
              'productId', v_id,
              'variant', v_line.vkey,
              'available', v_available,
              'requested', v_line.qty
            );
          END IF;
        END IF;
      END LOOP;

    ELSE
      -- Products without variants: ALL lines compete for the same global
      -- stock, so aggregate them before comparing exactly once.
      SELECT COALESCE(SUM((it ->> 'qty')::integer), 0)::integer
        INTO v_total_qty
        FROM jsonb_array_elements(p_lines) AS it
       WHERE (it ->> 'productId')::bigint = v_id;

      IF p_delta = -1 THEN
        v_available := COALESCE(v_prod.stock, 0);
        IF v_total_qty > v_available THEN
          RETURN jsonb_build_object(
            'ok', false,
            'reason', 'unavailable',
            'productId', v_id,
            'available', v_available,
            'requested', v_total_qty
          );
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- All lines passed validation. Apply the changes, skipping the missing
  -- products/variants that were reported above (restore only).
  FOR v_id IN
    SELECT DISTINCT (it ->> 'productId')::bigint
    FROM jsonb_array_elements(p_lines) AS it
    WHERE EXISTS (
      SELECT 1 FROM public.products p
       WHERE p.id = (it ->> 'productId')::bigint
    )
    ORDER BY 1
  LOOP
    SELECT * INTO v_prod
    FROM public.products
    WHERE id = v_id;

    v_var := v_prod."variantStock";
    v_has_variants :=
      v_var IS NOT NULL
      AND jsonb_typeof(v_var) = 'object'
      AND v_var <> '{}'::jsonb;

    SELECT COALESCE(SUM((it ->> 'qty')::integer), 0)::integer
    INTO v_total_qty
    FROM jsonb_array_elements(p_lines) AS it
    WHERE (it ->> 'productId')::bigint = v_id;

    v_touched := false;
    IF v_has_variants THEN
      FOR v_line IN
        SELECT
          COALESCE(it ->> 'size', '') || '-' ||
          COALESCE(it ->> 'color', '') AS vkey,
          SUM((it ->> 'qty')::integer)::integer AS qty
        FROM jsonb_array_elements(p_lines) AS it
        WHERE (it ->> 'productId')::bigint = v_id
        GROUP BY 1
        ORDER BY 1
      LOOP
        -- Missing variant on a restore: already reported by the preflight.
        IF v_line.vkey IN ('', '-')
           OR NOT (v_var ? v_line.vkey) THEN
          CONTINUE;
        END IF;
        v_var := jsonb_set(
          v_var,
          ARRAY[v_line.vkey],
          to_jsonb(
            COALESCE((v_var ->> v_line.vkey)::integer, 0)
            + (p_delta * v_line.qty)
          )
        );
        v_touched := true;
        v_restored := v_restored + 1;
      END LOOP;

      -- Invariant: global stock always equals the sum of variant stock. Only
      -- write when at least one existing variant was actually adjusted.
      IF v_touched THEN
        UPDATE public.products
        SET
          "variantStock" = v_var,
          stock = (
            SELECT COALESCE(SUM(value::integer), 0)::integer
            FROM jsonb_each_text(v_var)
          )
        WHERE id = v_id;
      END IF;

    ELSE
      UPDATE public.products
      SET stock = GREATEST(COALESCE(stock, 0) + (p_delta * v_total_qty), 0)
      WHERE id = v_id;
      v_restored := v_restored + 1;
    END IF;
  END LOOP;

  -- `restored` = number of product groups actually adjusted. Callers use
  -- restored > 0 to decide stockRestored; warnings explain what was skipped.
  RETURN jsonb_build_object('ok', true,
                            'restored', v_restored,
                            'warnings', v_warnings);
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
GRANT EXECUTE ON FUNCTION public.atomic_place_order(jsonb, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_adjust_stock(jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_signature(jsonb)         TO service_role;

-- ── 6) POST-APPLY VERIFICATION (run after applying) ───────────────────────────
-- SELECT proname, provolatile FROM pg_proc
-- WHERE proname IN ('atomic_place_order', 'atomic_adjust_stock', 'zshm_order_signature');
-- SELECT has_function_privilege('anon', 'public.atomic_place_order(jsonb, text)', 'EXECUTE') AS anon_can,
--        has_function_privilege('service_role', 'public.atomic_place_order(jsonb, text)', 'EXECUTE') AS svc_can;
-- SELECT indexdef FROM pg_indexes
-- WHERE tablename = 'orders' AND indexname = 'orders_idempotency_key_unique';
-- ── 7) ROLLBACK POLICY ───────────────────────────────────────────────────────
-- Never drop idempotency_key or its unique index.
-- Never drop deployed functions without a reviewed replacement.
-- Restore previous function definitions only when a reviewed rollback
-- procedure is available.