-- ══════════════════════════════════════════════════════════════════════════════
-- ZASHM · SESSION REVOCATION
-- Adds a monotonically increasing session_version to public.users. The value is
-- embedded in every signed session token at login; api/_lib.js's requirePerm
-- re-reads it on every privileged call and rejects the token when it differs.
-- api/admin/users.js bumps it whenever a user's role or password changes, so
-- existing tokens are revoked immediately instead of surviving the 8h TTL.
--
-- Backward compatible: until you run this, both sides default to 0 and the
-- check is a no-op. Apply ONLY in the Supabase SQL Editor after your approval.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;

-- ── Verification (run after applying) ────────────────────────────────────────
-- SELECT id, email, role, session_version FROM public.users ORDER BY id;
