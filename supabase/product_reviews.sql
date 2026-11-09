-- ─────────────────────────────────────────────────────────────────────────────
-- ZASHM · PRODUCT REVIEWS (customer ratings + comments)
--
-- Run this file ONCE in the Supabase SQL Editor (or with
-- `supabase db query --linked --file supabase/product_reviews.sql`).
--
-- What it adds
--   1. public.product_reviews — one row per customer review. Service-role only:
--      the browser can never read or write the table directly.
--   2. A trigger that keeps the denormalized `products.rating` / `products.reviews`
--      columns in sync with APPROVED reviews, so the storefront can show the
--      aggregate from products_public without an extra request.
--   3. products_public is recreated with the same allow-list columns plus
--      `rating` and `reviews` (no other column is exposed; `reservedStock` is
--      still explicitly rejected).
--
-- Moderation model
--   A submission starts as `pending`. Only the admin API can approve/reject it
--   (api/admin/reviews.js). Pending or rejected rows never affect the aggregate
--   and are never returned to the storefront.
--
-- Safety
--   * Idempotent: CREATE TABLE/INDEX/FUNCTION with IF [NOT] EXISTS, CREATE OR
--     REPLACE for the functions, DROP TRIGGER IF EXISTS first, and a full
--     DROP VIEW + CREATE VIEW inside the transaction for the recreated view.
--   * No existing row is modified by this file. The only UPDATEs happen later,
--     in the trigger, when a review is approved.
--   * No data is deleted. The rollback section is commented out on purpose.
--   * Apply this file AFTER supabase/products_public_view.sql (both phases).
--     The base view now lists rating/reviews in its allow-list, so re-running
--     Phase 1 keeps them; this file stays idempotent and can be re-applied
--     safely (it recreates the same view).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1) TABLE ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_reviews (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "productId"   bigint      NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  phone         text,
  rating        smallint    NOT NULL,
  comment       text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "publishedAt" timestamptz,
  "ipHash"      text,
  CONSTRAINT product_reviews_rating_range
    CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT product_reviews_status_valid
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT product_reviews_name_len
    CHECK (char_length(btrim(name)) BETWEEN 2 AND 40),
  CONSTRAINT product_reviews_comment_len
    CHECK (char_length(btrim(comment)) BETWEEN 2 AND 600),
  CONSTRAINT product_reviews_phone_len
    CHECK (phone IS NULL OR char_length(btrim(phone)) BETWEEN 5 AND 30)
);

-- Idempotent column add for databases that already applied an earlier version
-- of this migration (phone is a later addition).
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS phone text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'product_reviews_phone_len'
  ) THEN
    ALTER TABLE public.product_reviews
      ADD CONSTRAINT product_reviews_phone_len
      CHECK (phone IS NULL OR char_length(btrim(phone)) BETWEEN 5 AND 30);
  END IF;
END $$;

COMMENT ON TABLE public.product_reviews IS
  'Customer reviews. Service-role only; the storefront reads approved rows through /api/reviews.';
COMMENT ON COLUMN public.product_reviews.status IS
  'pending (awaiting moderation) | approved (public) | rejected (hidden)';
COMMENT ON COLUMN public.product_reviews."ipHash" IS
  'Salted hash of the submitter IP, used only for abuse investigation. Never exposed.';
COMMENT ON COLUMN public.product_reviews.phone IS
  'Optional submitter phone, stored for follow-up only. Never exposed publicly (admin-only).';

CREATE INDEX IF NOT EXISTS product_reviews_product_approved_idx
  ON public.product_reviews ("productId", "createdAt" DESC)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS product_reviews_status_created_idx
  ON public.product_reviews (status, "createdAt" DESC);

-- ── 2) LOCKDOWN (no browser access, ever) ───────────────────────────────────
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_reviews TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.product_reviews_id_seq TO service_role;

-- ── 3) AGGREGATE SYNC ───────────────────────────────────────────────────────
-- Recomputes the two denormalized columns from APPROVED rows only. Rounding to
-- one decimal keeps the card display stable (4.7, not 4.6666667).
CREATE OR REPLACE FUNCTION public.zshm_refresh_product_rating(p_product_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.products p
     SET rating  = COALESCE(agg.avg_rating, 0),
         reviews = COALESCE(agg.review_count, 0)
    FROM (
      SELECT round(avg(r.rating)::numeric, 1) AS avg_rating,
             count(*)::int                    AS review_count
        FROM public.product_reviews r
       WHERE r."productId" = p_product_id
         AND r.status = 'approved'
    ) agg
   WHERE p.id = p_product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.zshm_refresh_product_rating(bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zshm_refresh_product_rating(bigint)
  TO service_role;

CREATE OR REPLACE FUNCTION public.zshm_product_review_sync_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'approved' THEN
      PERFORM public.zshm_refresh_product_rating(OLD."productId");
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'approved' THEN
      PERFORM public.zshm_refresh_product_rating(NEW."productId");
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only a transition into or out of `approved` can change the average.
  IF OLD.status = 'approved' OR NEW.status = 'approved' THEN
    IF NEW."productId" IS DISTINCT FROM OLD."productId" THEN
      PERFORM public.zshm_refresh_product_rating(OLD."productId");
      PERFORM public.zshm_refresh_product_rating(NEW."productId");
    ELSE
      PERFORM public.zshm_refresh_product_rating(NEW."productId");
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.zshm_product_review_sync_rating()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zshm_product_review_sync ON public.product_reviews;
CREATE TRIGGER zshm_product_review_sync
  AFTER INSERT OR UPDATE OF status, "productId" OR DELETE
  ON public.product_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.zshm_product_review_sync_rating();

-- ── 4) products_public: same allow-list + rating/reviews ────────────────────
-- Recreated exactly like Phase 1 (security_invoker = false, security_barrier =
-- true) so the existing grants and behaviour do not change. A full DROP +
-- CREATE is used instead of CREATE OR REPLACE because the physical column order
-- of `products` differs between environments; CREATE OR REPLACE refuses to
-- reorder columns. The drop and re-create run in this one transaction, so the
-- view is never visible in a half-built state.
DROP VIEW IF EXISTS public.products_public;
CREATE VIEW public.products_public
WITH (security_invoker = false, security_barrier = true) AS
SELECT
  id,
  name,
  price,
  "salePrice",
  category,
  stock,
  image,
  description,
  label,
  sku,
  images,
  colors,
  sizes,
  "variantStock",
  "sizeGuide",
  rating,
  reviews
FROM public.products
WHERE active IS TRUE;

-- Keep the owner able to read the base table even after the Phase 3 revoke.
DO $$
BEGIN
  EXECUTE 'ALTER VIEW public.products_public OWNER TO postgres';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not change view owner; keeping the current owner';
END $$;

REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.products_public TO anon, authenticated;

-- Fail closed if the sanitized view ever exposes the unused reservation column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products_public'
       AND lower(column_name) = 'reservedstock'
  ) THEN
    RAISE EXCEPTION 'products_public exposes reservedStock';
  END IF;
END $$;

-- PostgREST caches the schema; reload so the new columns are visible at once.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── POST-APPLY VERIFICATION (read-only; run after applying) ──────────────────
-- SELECT to_regclass('public.product_reviews') IS NOT NULL AS table_exists;
-- SELECT has_table_privilege('anon', 'public.product_reviews', 'SELECT') AS anon_can,
--        has_table_privilege('service_role', 'public.product_reviews', 'SELECT') AS svc_can;
-- SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.product_reviews'::regclass
--   AND NOT tgisinternal;
-- SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'products_public'
--   ORDER BY ordinal_position;
-- SELECT count(*) FILTER (WHERE status = 'approved') AS approved,
--        count(*) FILTER (WHERE status = 'pending')  AS pending
--   FROM public.product_reviews;

-- ── ROLLBACK (review before running; deletes customer reviews) ──────────────
-- BEGIN;
--   DROP TRIGGER IF EXISTS zshm_product_review_sync ON public.product_reviews;
--   DROP FUNCTION IF EXISTS public.zshm_product_review_sync_rating();
--   DROP FUNCTION IF EXISTS public.zshm_refresh_product_rating(bigint);
--   -- Restore products_public without rating/reviews:
--   CREATE OR REPLACE VIEW public.products_public
--   WITH (security_invoker = false, security_barrier = true) AS
--   SELECT id, name, price, "salePrice", category, stock, image, description,
--          label, sku, images, colors, sizes, "variantStock", "sizeGuide"
--     FROM public.products WHERE active IS TRUE;
--   REVOKE ALL ON public.products_public FROM PUBLIC, anon, authenticated;
--   GRANT SELECT ON public.products_public TO anon, authenticated;
--   DROP TABLE IF EXISTS public.product_reviews;
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
