---
name: Production DevOps
description: Use when preparing a ZASHM release, changing Vercel/Supabase configuration, planning migrations or rollbacks, verifying a deployment, or handling production incidents.
---

# ZASHM Production DevOps

## Mission

Move ZASHM to production without silent breakage. Deployment, migration, and
rollback steps are explicit, ordered, verified, and reversible. Nothing is
deployed or applied without the owner's approval.

## Topology

| Layer | Platform | Notes |
|---|---|---|
| SPA | Vercel static (`build/`) | Vite build, SPA rewrites, security headers |
| API | Vercel serverless `api/` | Node runtime, service-role Supabase |
| Database/Auth/Storage | Supabase project `ptegprcbtfylqhbnbkih` | RLS + grants |
| Analytics | GA4 (optional `VITE_GA_ID`) | disabled when empty |
| Rate limiting | Upstash Redis (optional) | per-instance fallback without it |
| Notifications | Telegram bot | order alerts |

Public URL: `https://za-shm.vercel.app`.

## Environments

- **Local UI:** `npm start` → Vite on `:3000`.
- **Local full stack:** `npm run dev` → `vercel dev` (needs server env vars).
- **Preview:** Vercel preview deployment; same envs as Production/Preview scopes.
- **Production:** `main` branch deployment.

`VITE_*` values are inlined at **build time**. Changing them in Vercel requires a
new deployment. `REACT_APP_*` names remain a legacy fallback in `vite.config.js`.

## Required environment variables

Server-only (never `VITE_`/`REACT_APP_`):

- `SUPABASE_URL` (or `REACT_APP_SUPABASE_URL` as a server fallback)
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET` (long random; rotating invalidates all tracking links)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `ALLOWED_ORIGINS` (defaults to prod + localhost)
- `PUBLIC_BASE_URL` (defaults to `https://za-shm.vercel.app`)
- Optional: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `TRACKING_TOKEN_TTL_HOURS`

Build-time public:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_GA_ID`

Verification: the production bundle must contain **no** service-role value, no
`SESSION_SECRET`, no Telegram/Upstash token. After deploy, logs should not show
`Durable rate limit unavailable…` when Upstash is configured.

## Release checklist

### Before

- [ ] Work is reviewed; `npm test` green (SQL suite required, not skipped).
- [ ] `npm run build` exits 0; record the main bundle hash.
- [ ] `npm audit --omit=dev` reviewed.
- [ ] No secrets in the diff, logs, or build output.
- [ ] Migration order and current production state confirmed (never assume).
- [ ] Read-only production pre-flight (`verify_production_security.sql` where
      SQL access exists; anon probes otherwise).
- [ ] `reservedStock` and row counts match the documented baseline.
- [ ] Rollback plan written (app, SQL, env).

### Deploy order (code + migrations)

Follow `docs/production-remediation-handoff.md` and the file-level gates. In
general: deploy code that is backward compatible with the old schema **first**,
then run the additive SQL, then enable the new read path, then revoke old access
last. Never run a lockdown before the API/frontend that replaces the old direct
access is live.

Staged `products_public` rollout:

1. Run `products_public_view.sql` Phase 1 (view + grants, Phase 3 skipped).
2. Deploy the frontend reading `products_public` + the admin API path.
3. Verify storefront/admin/checkout/tracking in production.
4. Insert `products_public_frontend_live` into `zshm_deploy_flags`.
5. Re-run Phase 3 (revokes base-table access) and verify with the anon key.

### After

- [ ] Smoke: home, shop, product, cart, coupon, checkout, success, track.
- [ ] Admin login, product list/edit, order status/cancel, coupon delete guard.
- [ ] Anon `products_public` works; base tables return 401/403; storage list denied.
- [ ] No 5xx or auth errors in Vercel/Supabase logs for 24h.
- [ ] GA events fire only when configured; no PII.
- [ ] Record deployment SHA, bundle hash, migration versions, and time.

## Rollback rules

- **App:** redeploy the previous Vercel deployment; it must still work against
  the current schema (hence additive-first ordering).
- **View/grants:** `products_public_view.sql` rollback restores base-table grants;
  also revert `src/store.js`/`src/lib/security.js` to `from('products')`.
- **Coupons/users/orders lockdown:** restore documented grants/policies from the
  backup captured in the migration's pre-check output.
- **Functions:** previous `CREATE OR REPLACE` definitions must be saved before
  applying; re-apply them to roll back.
- **Never** "fix" a rollback by weakening RLS or exposing service-role data.

## Incident response

1. Confirm scope (site down, API errors, data exposure, checkout broken).
2. Stop the bleeding with the smallest reversible action (redeploy previous
   build, disable a route, rotate a secret). Do not run ad-hoc SQL.
3. Preserve evidence (logs, request ids, timestamps) without copying PII/secrets.
4. Rotate compromised secrets: `SESSION_SECRET` (invalidates sessions/tracking),
   service role key (Supabase dashboard), Telegram bot token, Upstash token.
5. After recovery, write a short timeline + root cause + preventive test.

## Hard rules

- Do not deploy, push, apply production SQL, or change Vercel/Supabase settings
  without explicit owner approval.
- Do not run destructive SQL; back up before any grant/policy change.
- Do not commit `.env` files or paste secrets into chat/logs.
- Do not create the rollout flag before the new frontend is verified.
- Do not report a deployment as verified without the post-deploy checks.
- If credentials are unavailable (no Vercel token, no Supabase management token),
  stop and report the exact blocker; do not pretend the step succeeded.
