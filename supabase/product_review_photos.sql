-- ─────────────────────────────────────────────────────────────────────────────
-- ZASHM · REVIEW PHOTOS (one optional photo per customer review)
--
-- Run this file ONCE in the Supabase SQL Editor (or with
-- `supabase db query --linked --file supabase/product_review_photos.sql`).
-- It is the only step that needs database access: the code that uploads,
-- serves and deletes the photos ships with the deploy.
--
-- What it adds
--   1. public.product_reviews."photoPath" — the SHORT object path of an optional
--      customer photo (e.g. reviews/1794698667338998/9f2c….jpg). The image
--      bytes live in the existing public `products` bucket, so the table stays
--      tiny: a few dozen characters per review instead of megabytes.
--   2. A fail-closed CHECK on that column: NULL, or 10–300 characters, never
--      absolute, never containing `..`. A malformed path can therefore never
--      escape the bucket folder it was written to.
--
-- What it does NOT do
--   * No new bucket, no storage policy: the browser never talks to Storage.
--     api/reviews.js writes with the service-role key, and the public API only
--     returns a URL for APPROVED reviews.
--   * No row is modified or deleted. Existing reviews simply keep a NULL path
--     and render exactly as they do today.
--
-- Apply order: AFTER supabase/product_reviews.sql (the table must exist).
-- Idempotent: ADD COLUMN IF NOT EXISTS + a guarded constraint, so re-running
-- this file is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1) COLUMN ───────────────────────────────────────────────────────────────
ALTER TABLE public.product_reviews
  ADD COLUMN IF NOT EXISTS "photoPath" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'product_reviews_photo_path_len'
  ) THEN
    ALTER TABLE public.product_reviews
      ADD CONSTRAINT product_reviews_photo_path_len
      CHECK (
        "photoPath" IS NULL
        OR (
          char_length("photoPath") BETWEEN 10 AND 300
          AND left("photoPath", 1) <> '/'
          AND position('..' IN "photoPath") = 0
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.product_reviews."photoPath" IS
  'Optional review photo: object path inside the products bucket (reviews/<productId>/...). The image bytes never live in this table.';

-- ── 2) PRIVILEGES ───────────────────────────────────────────────────────────
-- The table-level grants already cover the new column; this is a no-op reminder
-- that the browser roles must never gain access to the review table.
REVOKE ALL ON public.product_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_reviews TO service_role;

-- PostgREST caches the schema; reload so `photoPath` is queryable at once.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── POST-APPLY VERIFICATION (read-only; run after applying) ──────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name = 'product_reviews'
--    AND column_name = 'photoPath';
--
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.product_reviews'::regclass
--    AND conname = 'product_reviews_photo_path_len';
--
-- SELECT count(*) AS reviews,
--        count("photoPath") AS with_photo
--   FROM public.product_reviews;

-- ── ROLLBACK (review before running) ────────────────────────────────────────
-- Dropping the column only forgets the paths; the image files stay in the
-- `products` bucket under reviews/<productId>/ and can be deleted from the
-- Supabase Storage browser if you want the space back.
-- BEGIN;
--   ALTER TABLE public.product_reviews
--     DROP CONSTRAINT IF EXISTS product_reviews_photo_path_len;
--   ALTER TABLE public.product_reviews
--     DROP COLUMN IF EXISTS "photoPath";
--   NOTIFY pgrst, 'reload schema';
-- COMMIT;
