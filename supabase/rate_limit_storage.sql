-- Shared, server-only rate-limit counters for Vercel functions.
--
-- This is an additive migration. It creates no customer/store data and must be
-- applied manually after review; never paste it into Production without owner
-- approval. api/_lib.js uses this RPC when Upstash is not configured.

CREATE TABLE IF NOT EXISTS public.zshm_rate_limits (
  rate_key text PRIMARY KEY CHECK (rate_key ~ '^[a-f0-9]{64}$'),
  hit_count integer NOT NULL CHECK (hit_count > 0),
  reset_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS zshm_rate_limits_reset_at_idx
  ON public.zshm_rate_limits (reset_at);

ALTER TABLE public.zshm_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zshm_rate_limits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zshm_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.zshm_rate_limit(
  p_key text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_action text DEFAULT 'consume'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_count integer := 0;
  v_reset_at timestamptz;
  v_reset_in integer := 0;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-f0-9]{64}$'
     OR p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 1000000
     OR p_window_seconds IS NULL OR p_window_seconds NOT BETWEEN 1 AND 2592000
     OR p_action IS NULL OR p_action NOT IN ('consume', 'peek', 'reset') THEN
    RAISE EXCEPTION 'Invalid rate-limit request' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'reset' THEN
    DELETE FROM public.zshm_rate_limits WHERE rate_key = p_key;
    RETURN jsonb_build_object(
      'allowed', true, 'count', 0,
      'remaining', p_max_attempts, 'resetIn', 0
    );
  END IF;

  IF p_action = 'peek' THEN
    SELECT hit_count, reset_at
      INTO v_count, v_reset_at
      FROM public.zshm_rate_limits
     WHERE rate_key = p_key;

    IF NOT FOUND OR v_reset_at <= v_now THEN
      RETURN jsonb_build_object(
        'allowed', true, 'count', 0,
        'remaining', p_max_attempts, 'resetIn', 0
      );
    END IF;
  ELSE
    INSERT INTO public.zshm_rate_limits AS current (rate_key, hit_count, reset_at)
    VALUES (p_key, 1, v_now + make_interval(secs => p_window_seconds))
    ON CONFLICT (rate_key) DO UPDATE
       SET hit_count = CASE
             WHEN current.reset_at <= v_now THEN 1
             ELSE current.hit_count + 1
           END,
           reset_at = CASE
             WHEN current.reset_at <= v_now
               THEN v_now + make_interval(secs => p_window_seconds)
             ELSE current.reset_at
           END
    RETURNING hit_count, reset_at INTO v_count, v_reset_at;
  END IF;

  v_reset_in := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_reset_at - v_now)))::integer);

  -- Bound table growth from random/expired client keys without running a full
  -- cleanup scan on every request.
  IF p_action = 'consume' AND random() < 0.01 THEN
    DELETE FROM public.zshm_rate_limits
     WHERE rate_key IN (
       SELECT rate_key
         FROM public.zshm_rate_limits
        WHERE reset_at < v_now
        ORDER BY reset_at
        LIMIT 500
     );
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_attempts,
    'count', v_count,
    'remaining', GREATEST(0, p_max_attempts - v_count),
    'resetIn', v_reset_in
  );
END;
$$;

REVOKE ALL ON FUNCTION public.zshm_rate_limit(text, integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zshm_rate_limit(text, integer, integer, text)
  TO service_role;

-- Verification (read-only):
-- SELECT has_table_privilege('anon', 'public.zshm_rate_limits', 'SELECT') AS anon_can_read;
-- SELECT has_function_privilege('anon', 'public.zshm_rate_limit(text,integer,integer,text)', 'EXECUTE') AS anon_can_execute;
-- SELECT has_function_privilege('service_role', 'public.zshm_rate_limit(text,integer,integer,text)', 'EXECUTE') AS service_can_execute;

-- Rollback (only after the API no longer calls this RPC):
-- DROP FUNCTION IF EXISTS public.zshm_rate_limit(text, integer, integer, text);
-- DROP TABLE IF EXISTS public.zshm_rate_limits;
