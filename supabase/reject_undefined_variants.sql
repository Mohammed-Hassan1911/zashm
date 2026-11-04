-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · STAGED MIGRATION 1 OF 2 · REJECT UNDECLARED SIZES/COLOURS AT PURCHASE TIME
-- File: supabase/reject_undefined_variants.sql
-- Status: NOT APPLIED. Nothing in this repository has executed it. It is applied
--         only by the owner, in the Supabase SQL Editor, with explicit approval,
--         and only together with the matching api/orders.js deployment.
--
-- WHAT IT FIXES
--   products.variantStock can keep keys for a size/colour the admin later
--   removed. Real example on Production (read-only check, 2026-11-04):
--     product 1793739505270547  Jacket Boxy
--     colors        ["Black","Burgundy"]        <- White is NOT declared
--     sizes         ["S","M","L","XL"]
--     variantStock  S-Black 7 · M-Black 5 · L-Black 5 · M-Burgundy 1
--                   M-White 4 · L-White 4       <- leftover ("orphan") keys
--   atomic_place_order only checked that a key EXISTS, so "M-White" /
--   "L-White" (8 units of a colour that no longer exists) were still purchasable
--   by POSTing straight to /api/orders — the storefront had simply stopped
--   offering them. This migration makes the database refuse them with
--   reason = 'undefined_variant'.
--
--   It also installs public.zshm_sellable_stock() (§2b) and makes
--   atomic_place_order() write products.stock from the DECLARED combinations only
--   (owner decision 1أ, 2026-11-04), and refuses a variant pool that has no
--   declared size list or no declared colour list as reason =
--   'invalid_product_config' (owner decision 3ب) — see check 0c below: no live
--   product has that shape today.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It never deletes or zeroes a variantStock key. The 8 units above stay in
--     the row untouched until the owner decides (re-declare White, or remove the
--     keys with a reviewed data change).
--   * It never touches an existing order row.
--   * atomic_adjust_stock() is NOT changed here — that is migration 2 of 2
--     (supabase/declared_only_stock_recompute.sql). Cancelling / un-cancelling /
--     deleting an OLD order that legitimately contains an orphan variation keeps
--     working (restore stays tolerant, deduct stays strict). Only NEW purchases
--     are gated.
--   * Products with NO variant pool keep using the global stock counter, and
--     legacy rows keep the all-keys stock fallback — nothing is zeroed.
--
-- Apply order: THIS file first, then supabase/declared_only_stock_recompute.sql.
-- Lock order, idempotency, coupon re-pricing and atomicity are unchanged from
-- atomic_place_order.sql REVISION 8.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 0) PRE-APPLY CHECKS (READ-ONLY — run these first and keep the output) ──────

-- 0a. Which products currently hold variantStock keys outside their declared
--     sizes/colors? Expect at least 1793739505270547 (M-White, L-White).
--     NOTE: keys are matched against the whole tail after the first '-', so a
--     colour containing a hyphen still resolves correctly.
SELECT p.id, p.name, p.colors, p.sizes, k.key AS orphan_key, k.value AS qty
  FROM public.products p
  CROSS JOIN LATERAL jsonb_each_text(p."variantStock") AS k(key, value)
 WHERE p.active IS TRUE
   AND jsonb_typeof(p."variantStock") = 'object'
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.sizes)  = 'array' THEN p.sizes  END), 0) > 0
   AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.colors) = 'array' THEN p.colors END), 0) > 0
   AND NOT (
        split_part(k.key, '-', 1) = ANY (SELECT jsonb_array_elements_text(p.sizes))
     AND right(k.key, length(k.key) - position('-' in k.key))
         = ANY (SELECT jsonb_array_elements_text(p.colors))
   )
 ORDER BY p.id, k.key;

-- 0b. The live definitions — this output IS the rollback copy.
SELECT pg_get_functiondef(oid) AS definition
  FROM pg_proc
 WHERE proname IN ('atomic_place_order', 'zshm_order_signature');

-- 0c. OWNER DECISION 3ب PRE-FLIGHT — the inventory that must be reviewed BEFORE
--     this file is applied. These rows have one half of their variant options
--     missing: a stock pool with no declared size/colour lists, or declared lists
--     with no pool. atomic_place_order() refuses both with 'invalid_product_config'
--     and the storefront shows them as not orderable; their stock, keys and
--     quantities are NOT changed by this file. Verified empty on Production on
--     2026-11-04: the products table held 1 row (Jacket Boxy), fully declared,
--     with a variant pool — so no existing product loses the ability to sell.
--     If this query returns anything, STOP and review each product first: filling
--     in the missing half (its sizes/colors, or its stock matrix) makes it
--     sellable again.
SELECT p.id, p.name, p.active, p.stock,
       CASE WHEN jsonb_typeof(p."variantStock") = 'object'
                 AND p."variantStock" <> '{}'::jsonb
            THEN (SELECT count(*) FROM jsonb_each_text(p."variantStock"))
            ELSE 0 END AS variant_keys,
       CASE WHEN jsonb_typeof(p."variantStock") = 'object'
                 AND p."variantStock" <> '{}'::jsonb
            THEN 'pool without declared lists'
            ELSE 'declared lists without a pool' END AS shape,
       p.sizes, p.colors
  FROM public.products p
 WHERE (
         -- half 1: a pool nobody declared options for
         (jsonb_typeof(p."variantStock") = 'object' AND p."variantStock" <> '{}'::jsonb
          AND (p.sizes IS NULL OR jsonb_typeof(p.sizes) <> 'array' OR jsonb_array_length(p.sizes) = 0
               OR p.colors IS NULL OR jsonb_typeof(p.colors) <> 'array' OR jsonb_array_length(p.colors) = 0))
         -- half 2: options declared, but no pool to match them against
      OR (
           (p."variantStock" IS NULL
            OR jsonb_typeof(p."variantStock") <> 'object'
            OR p."variantStock" = '{}'::jsonb)
           AND ((p.sizes  IS NOT NULL AND jsonb_typeof(p.sizes)  = 'array' AND jsonb_array_length(p.sizes)  > 0)
             OR (p.colors IS NOT NULL AND jsonb_typeof(p.colors) = 'array' AND jsonb_array_length(p.colors) > 0))
         )
       )
 ORDER BY p.id;

-- 0d. Stock that will be REWRITTEN by the declared-only recompute. This is a
--     read-only preview: "sellable_stock" is what products.stock becomes the
--     first time that product is ordered (or restored by migration 2), and
--     "orphan_units" is the stock that stops counting. Nothing is written here.
--     The expression mirrors zshm_sellable_stock() (§2b below) for products that
--     declare both lists; a product without lists is inventoried by 0c instead.
WITH declared AS (
  SELECT p.id, p.name, p.stock, p.sizes, p.colors, p."variantStock"
    FROM public.products p
   WHERE jsonb_typeof(p."variantStock") = 'object'
     AND p."variantStock" <> '{}'::jsonb
     AND jsonb_typeof(p.sizes)  = 'array' AND jsonb_array_length(p.sizes)  > 0
     AND jsonb_typeof(p.colors) = 'array' AND jsonb_array_length(p.colors) > 0
)
SELECT d.id, d.name, d.stock AS stored_stock,
       s.sellable_stock,
       COALESCE(d.stock, 0) - s.sellable_stock AS orphan_units
  FROM declared d
  JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(
             CASE WHEN (d."variantStock" ->> (sz.value || '-' || co.value)) ~ '^-?[0-9]+$'
                  THEN (d."variantStock" ->> (sz.value || '-' || co.value))::integer
                  ELSE 0 END, 0))::integer, 0) AS sellable_stock
      FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(d.sizes))  AS sz(value)
     CROSS JOIN (SELECT DISTINCT value FROM jsonb_array_elements_text(d.colors)) AS co(value)
  ) s ON TRUE
 ORDER BY (COALESCE(d.stock, 0) - s.sellable_stock) DESC;

-- 0e. Order lines that reference a variation this migration starts refusing.
--     They are NOT modified; the count only tells you how much history exists.
-- SELECT count(*) AS historical_undefined_lines
--   FROM public.orders o
--   JOIN jsonb_array_elements(
--          CASE WHEN jsonb_typeof(o.items) = 'string'
--               THEN (o.items #>> '{}')::jsonb ELSE o.items END) AS it ON TRUE
--   JOIN public.products p ON p.id = (it ->> 'productId')::bigint
--  WHERE o.status NOT IN ('Delivered', 'Cancelled')
--    AND p.active IS TRUE;

-- ── 1) BACKUP ──────────────────────────────────────────────────────────────────
-- Section 0b output is the function rollback copy. Snapshot the affected product
-- rows (values only, no DDL) before applying, e.g. from the SQL editor:
--   SELECT id, name, colors, sizes, "variantStock", stock
--     FROM public.products
--    WHERE id = 1793739505270547;
-- Copy the result into your release ticket. This migration writes no product
-- data, but a reviewed before-image is required by docs/production-remediation-handoff.md.

-- ── 2) HELPERS + ATOMIC PLACE ──────────────────────────────────────────────────
-- All three bodies are verbatim copies of sections 2, 2b and 3 of
-- supabase/atomic_place_order.sql (REVISION 10). They MUST stay byte-identical —
-- scripts/test-undefined-variant.mjs compares them on every npm test run.
-- All are CREATE OR REPLACE, so re-running this whole file is safe.


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

CREATE OR REPLACE FUNCTION public.zshm_sellable_stock(
  p_variant_stock jsonb,
  p_sizes jsonb,
  p_colors jsonb
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    -- No usable variant pool: nothing to sum.
    WHEN p_variant_stock IS NULL
         OR jsonb_typeof(p_variant_stock) <> 'object'
         OR p_variant_stock = '{}'::jsonb
      THEN 0

    -- Both option lists declared → the declared combinations are the stock.
    WHEN p_sizes IS NOT NULL
         AND jsonb_typeof(p_sizes) = 'array'
         AND jsonb_array_length(p_sizes) > 0
         AND p_colors IS NOT NULL
         AND jsonb_typeof(p_colors) = 'array'
         AND jsonb_array_length(p_colors) > 0
      THEN COALESCE((
        SELECT SUM(GREATEST(
                 CASE WHEN (p_variant_stock ->> (sz.value || '-' || co.value)) ~ '^-?[0-9]+$'
                      THEN (p_variant_stock ->> (sz.value || '-' || co.value))::integer
                      ELSE 0 END,
                 0))::integer
          -- DISTINCT: a legacy row with the same size/colour listed twice must
          -- not count the same combination twice. Exact duplicates only; do NOT
          -- case-fold or trim here, because that could merge two different
          -- variantStock keys ("S-Black" vs "s-Black") into one.
          FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(p_sizes))  AS sz(value)
         CROSS JOIN (SELECT DISTINCT value FROM jsonb_array_elements_text(p_colors)) AS co(value)
      ), 0)

    -- Legacy fallback: keep summing every key (never zero a legacy product).
    ELSE COALESCE((
      SELECT SUM(GREATEST(
               CASE WHEN kv.value ~ '^-?[0-9]+$' THEN kv.value::integer ELSE 0 END,
               0))::integer
        FROM jsonb_each_text(p_variant_stock) AS kv(key, value)
    ), 0)
  END;
$$;

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
  v_size_list text[];
  v_color_list text[];
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

    -- REVISION 10 (3ب): the mirror image. A variant pool with no declared size
    -- list or no declared colour list has nothing to match a line against, so it
    -- is the same invalid configuration and is refused rather than sold by raw
    -- key lookup. The owner approved this only after a read-only inventory
    -- (check 0c of supabase/reject_undefined_variants.sql, 2026-11-04) returned no
    -- product in this shape. Nothing is written here: keys and quantities stay.
    IF v_has_variants
       AND (v_prod.sizes IS NULL OR jsonb_typeof(v_prod.sizes) <> 'array'
            OR jsonb_array_length(v_prod.sizes) = 0
            OR v_prod.colors IS NULL OR jsonb_typeof(v_prod.colors) <> 'array'
            OR jsonb_array_length(v_prod.colors) = 0) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_product_config',
                                'productId', v_id);
    END IF;

    -- Declared options, as a text array. `x = ANY(NULL)` is NULL → the guard below
    -- is skipped, which now only happens for products that were refused above.
    v_size_list := NULL;
    v_color_list := NULL;
    IF v_prod.sizes IS NOT NULL AND jsonb_typeof(v_prod.sizes) = 'array' THEN
      SELECT array_agg(opt) INTO v_size_list
        FROM jsonb_array_elements_text(v_prod.sizes) AS opt;
    END IF;
    IF v_prod.colors IS NOT NULL AND jsonb_typeof(v_prod.colors) = 'array' THEN
      SELECT array_agg(opt) INTO v_color_list
        FROM jsonb_array_elements_text(v_prod.colors) AS opt;
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
        -- REVISION 9: a leftover variantStock key does not authorise a sale. The
        -- line's size AND colour must still be declared on the product. The key
        -- and its quantity are left exactly as they are — cleaning them up is an
        -- owner decision, never a side effect of placing an order.
        IF NOT (v_line.size = ANY (v_size_list))
           OR NOT (v_line.color = ANY (v_color_list)) THEN
          RETURN jsonb_build_object(
            'ok', false, 'reason', 'undefined_variant',
            'productId', v_id,
            'name', v_prod.name,
            'size', v_line.size,
            'color', v_line.color,
            'variant', v_line.vkey
          );
        END IF;

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

      -- Invariant: global stock equals the SELLABLE variant stock — the declared
      -- size × colour keys only (§2b). Orphaned keys keep their quantities but
      -- can no longer re-enter products.stock through a purchase.
      UPDATE public.products
         SET "variantStock" = v_var,
             stock = public.zshm_sellable_stock(v_var, v_prod.sizes, v_prod.colors)
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

-- ── 3) PRIVILEGES ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.atomic_place_order(jsonb, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_order_signature(jsonb)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.zshm_sellable_stock(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_place_order(jsonb, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_order_signature(jsonb)         TO service_role;
GRANT EXECUTE ON FUNCTION public.zshm_sellable_stock(jsonb, jsonb, jsonb) TO service_role;

-- ── 4) POST-APPLY VERIFICATION (READ-ONLY) ─────────────────────────────────────
-- SELECT proname FROM pg_proc
--  WHERE proname IN ('atomic_place_order', 'zshm_order_signature', 'zshm_sellable_stock');
--
-- SELECT has_function_privilege('anon', 'public.atomic_place_order(jsonb, text)', 'EXECUTE')          AS anon_can_place,
--        has_function_privilege('anon', 'public.zshm_sellable_stock(jsonb, jsonb, jsonb)', 'EXECUTE') AS anon_can_helper,
--        has_function_privilege('service_role', 'public.atomic_place_order(jsonb, text)', 'EXECUTE')  AS svc_can_place;
--
-- The guard itself, without touching any real row: a declared variation and an
-- orphaned variation are asked in one transaction that is rolled back.
--
-- ⚠ DELIBERATELY COMMENTED OUT — do NOT paste a live BEGIN;…ROLLBACK; back into
--   this file. The Supabase SQL Editor submits the whole script as ONE
--   multi-statement request, so PostgreSQL runs all of it in one implicit
--   transaction; a trailing ROLLBACK then cancels every CREATE FUNCTION above
--   it and the migration silently reports success while creating nothing
--   (observed in Production, 2026-11-04: the 0d table appeared, the helper was
--   NULL). Commenting both statements keeps a whole-file run safe; psql -f
--   (the local test harness) behaves identically either way.
--
-- To run the probe, select ONLY the three lines below, uncomment them, and run
-- the selection — never mix them back into a whole-file run.
--
-- BEGIN;
--   SELECT public.atomic_place_order('{"id":"ZSH-MIGRATION-PROBE-0001","items":[{"productId":1793739505270547,"qty":1,"size":"M","color":"White","price":100}],"total":100}'::jsonb, NULL);
--   ROLLBACK;
-- The probe must return reason = 'undefined_variant' and leave products, orders
-- and coupons unchanged (ROLLBACK guarantees the second half).

-- ── 5) DEPLOYMENT ORDER ────────────────────────────────────────────────────────
--   1. run checks 0a–0e and keep the output,
--   2. apply THIS file — in the SQL Editor run it as: §0 (read-only) → §2
--      (lines with the three CREATE OR REPLACE) → §3 (grants). Running the whole
--      file in one go is safe now that §4 is fully commented; still, verify
--      §4's first query afterwards (it must list all three functions),
--   3. apply supabase/declared_only_stock_recompute.sql (atomic_adjust_stock),
--   4. deploy api/orders.js (same rule, JS side) and the storefront build,
--   5. re-run section 4 verification.
-- The SQL and the API must land together: the API refuses undeclared variations
-- first, and the RPC is the authoritative gate for anything that reaches it.

-- ── 6) ROLLBACK POLICY ─────────────────────────────────────────────────────────
-- Paste the section 0b output back in the SQL editor (CREATE OR REPLACE of the
-- previous definitions) and re-run section 3 grants. No data was changed, so no
-- data restore is needed. Never drop these functions without a reviewed
-- replacement.
