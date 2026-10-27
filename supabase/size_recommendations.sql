-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · SMART SIZE RECOMMENDATIONS
-- Add nullable JSONB column for product-specific size recommendations.
-- Apply in the Supabase SQL Editor after your approval.
-- ══════════════════════════════════════════════════════════════════════════════

-- Add sizeRecommendations column to products (nullable, backward compatible)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS "sizeRecommendations" jsonb;

-- Optional: add index for queries filtering products with recommendations
-- CREATE INDEX IF NOT EXISTS products_size_recommendations_idx 
--   ON public.products USING gin ("sizeRecommendations") 
--   WHERE "sizeRecommendations" IS NOT NULL;

-- Verification (run after applying):
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'products' AND column_name = 'sizeRecommendations';
