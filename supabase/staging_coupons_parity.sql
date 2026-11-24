-- ─── STAGING-ONLY COUPON PARITY — FINAL REVIEWED VERSION ─────────────────────
-- Target (verified OUTSIDE SQL before execution):
--   Supabase ref  sfenutmgfawuhmvwkmhv  (project "zashm-staging-20261124",
--   region eu-central-1). Production is ptegprcbtfylqhbnbkih and must never
--   be linked for this file.
--
-- Purpose: make public.coupons on Staging match Production exactly:
--   PRIMARY KEY (id), UNIQUE (code), and identical column defaults.
--
-- SCOPE:  STAGING ONLY. No Production write. No DNS / Vercel / main / cutover.
--         This migration performs NO DML: no coupon, product, order, user or
--         review row is inserted, updated or deleted. Only columns, defaults
--         and constraints change. A restorable data-only dump of Staging's
--         public schema must exist before this file is run.
--
-- Safety: single transaction; every check raises before COMMIT, so any
-- unexpected state rolls the whole change back automatically.
-- Verified locally on a throwaway PostgreSQL 17 cluster (first run, safe
-- refusal on rerun, rollback, forward-after-rollback, and bad-id guard).

BEGIN;
SET LOCAL search_path = public, pg_temp;

-- [0] Fail closed unless this is the known Staging project --------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = '9900000000001') THEN
    RAISE EXCEPTION
      'REFUSING: staging fixture product 9900000000001 is absent — not Staging';
  END IF;
END $$;

-- [1] Preflight the exact objects being replaced ------------------------------
-- Proves the current PK really is PRIMARY KEY(code), and that the column types
-- are the ones we intend to keep (id bigint, code text).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_pkey'
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (code)'
  ) THEN
    RAISE EXCEPTION
      'REFUSING: coupons_pkey is not PRIMARY KEY (code) — stop and review';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'REFUSING: coupons.id is not bigint';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'code' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'REFUSING: coupons.code is not text';
  END IF;
END $$;

-- [2] Prove the existing id values can become the primary key -----------------
DO $$
DECLARE
  v_total    bigint;
  v_nonnull  bigint;
  v_distinct bigint;
BEGIN
  SELECT COUNT(*), COUNT(id), COUNT(DISTINCT id)
    INTO v_total, v_nonnull, v_distinct
    FROM public.coupons;

  IF v_total <> v_nonnull OR v_total <> v_distinct THEN
    RAISE EXCEPTION
      'coupons.id cannot be a PK: total=%, nonnull=%, distinct=%',
      v_total, v_nonnull, v_distinct;
  END IF;

  IF EXISTS (SELECT 1 FROM public.coupons GROUP BY code HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'duplicate coupon codes found; refusing to continue';
  END IF;
END $$;

-- [3] Refuse if ANY foreign key in ANY PostgreSQL schema touches coupons -----
-- No connamespace filter: this covers public, auth, storage, extensions and
-- every other schema in the database, in both directions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE contype = 'f'
      AND (confrelid = 'public.coupons'::regclass
           OR conrelid = 'public.coupons'::regclass)
  ) THEN
    RAISE EXCEPTION
      'a foreign key involving coupons exists in some schema; stop and review';
  END IF;
END $$;

-- [4] Add the two columns that exist in Production but not in Staging --------
-- Reject an existing column with a different definition instead of guessing.
DO $$
DECLARE
  v_type    text;
  v_default text;
BEGIN
  SELECT data_type, column_default
    INTO v_type, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'coupons'
     AND column_name = 'createdAt';

  IF NOT FOUND THEN
    ALTER TABLE public.coupons ADD COLUMN "createdAt" timestamptz DEFAULT now();
  ELSIF v_type IS DISTINCT FROM 'timestamp with time zone'
     OR v_default IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'unexpected coupons.createdAt definition: % / %', v_type, v_default;
  END IF;

  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'coupons'
     AND column_name = 'description';

  IF NOT FOUND THEN
    ALTER TABLE public.coupons ADD COLUMN description text;
  ELSIF v_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'unexpected coupons.description type: %', v_type;
  END IF;
END $$;

-- [5] Match every Production default exactly ---------------------------------
ALTER TABLE public.coupons ALTER COLUMN type         SET DEFAULT 'percentage'::text;
ALTER TABLE public.coupons ALTER COLUMN value        SET DEFAULT 0;
ALTER TABLE public.coupons ALTER COLUMN active       SET DEFAULT true;
ALTER TABLE public.coupons ALTER COLUMN "usageLimit" SET DEFAULT 0;

-- [6] Keep code unique: every SQL function and API lookup keys on code --------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_code_key'
  ) THEN
    ALTER TABLE public.coupons ADD CONSTRAINT coupons_code_key UNIQUE (code);
  END IF;
END $$;

-- [7] Swap the primary key from code to id ------------------------------------
ALTER TABLE public.coupons DROP CONSTRAINT coupons_pkey;
ALTER TABLE public.coupons ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);

-- [8] Verification — any mismatch raises and rolls back the whole transaction -
DO $$
BEGIN
  -- Order-independent comparison of every Production default.
  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('type',        '''percentage''::text'),
      ('value',       '0'),
      ('active',      'true'),
      ('usageLimit',  '0'),
      ('usageCount',  '0'),
      ('createdAt',   'now()')
    ) AS expected(column_name, def)
    WHERE COALESCE((
      SELECT c.column_default
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'coupons'
        AND c.column_name = expected.column_name
    ), '<none>') IS DISTINCT FROM expected.def
  ) THEN
    RAISE EXCEPTION 'coupon defaults do not match Production';
  END IF;

  -- No other coupon column may have a default (Production has none).
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'coupons'
      AND column_name NOT IN ('type', 'value', 'active', 'usageLimit', 'usageCount', 'createdAt')
      AND column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'unexpected default on another coupon column';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_pkey'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
  ) THEN
    RAISE EXCEPTION 'coupons primary key is not (id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass
      AND conname = 'coupons_code_key'
      AND pg_get_constraintdef(oid) = 'UNIQUE (code)'
  ) THEN
    RAISE EXCEPTION 'coupons_code_key is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name IN ('id', 'code') AND is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION 'coupon id/code must be NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'description' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'coupons.description is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'createdAt' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'coupons.createdAt is missing or has the wrong type';
  END IF;
END $$;

SELECT
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass AND conname = 'coupons_pkey') AS primary_key,
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conrelid = 'public.coupons'::regclass AND conname = 'coupons_code_key') AS code_unique,
  (SELECT COUNT(*) FROM public.coupons) AS coupon_count,
  (SELECT COUNT(DISTINCT id) FROM public.coupons) AS distinct_ids;

COMMIT;

-- ─── ROLLBACK (manual, Staging only, never Production) ───────────────────────
-- WARNING — DATA LOSS RISK: this rollback DROPS the columns createdAt and
-- description. Any NEW values written into those columns after this migration
-- would be lost. Before rolling back, export them, e.g.
--   COPY (SELECT id, code, "createdAt", description FROM public.coupons)
--     TO '<backup-path>/coupon-new-columns.csv' CSV HEADER;
-- If either column holds non-default data, STOP and escalate instead of
-- running the statements below.
--
-- BEGIN;
-- ALTER TABLE public.coupons DROP CONSTRAINT coupons_pkey;
-- ALTER TABLE public.coupons ADD CONSTRAINT coupons_pkey PRIMARY KEY (code);
-- ALTER TABLE public.coupons ALTER COLUMN id DROP NOT NULL;
-- ALTER TABLE public.coupons ALTER COLUMN type DROP DEFAULT;
-- ALTER TABLE public.coupons ALTER COLUMN value DROP DEFAULT;
-- ALTER TABLE public.coupons ALTER COLUMN active DROP DEFAULT;
-- ALTER TABLE public.coupons ALTER COLUMN "usageLimit" DROP DEFAULT;
-- ALTER TABLE public.coupons DROP COLUMN IF EXISTS "createdAt";
-- ALTER TABLE public.coupons DROP COLUMN IF EXISTS description;
-- COMMIT;
