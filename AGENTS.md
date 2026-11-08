# AGENTS.md — ZASHM Engineering Guide

ZASHM is a luxury-fashion e-commerce store for Egypt: a React 18 + Vite SPA on
Vercel, a Vercel serverless API, and Supabase (Postgres/Auth/Storage). This file
is the shared contract for every agent working in this repository. Read it before
planning or editing.

> Hard rule: **never commit, push, deploy, apply production SQL, rotate secrets, or
> change Vercel/Supabase settings without explicit owner approval.**

---

## 1. Architecture

```
Browser (anon Supabase key, public bundle)
  │
  ├── public reads ──► Supabase `products_public` view
  │
  └── fetch ─────────► Vercel serverless `/api/*` (service-role key)
                         │
                         ├── Supabase Postgres (RLS + grants)
                         └── Supabase Storage (`products` bucket)
```

| Layer | Location | Notes |
|---|---|---|
| SPA shell | `src/App.js` | page switch, lazy pages, modals, floating actions |
| State | `src/store.js` | Zustand, persisted cart/wishlist, API orchestration |
| Routing | `src/lib/routes.js` | custom state router, no react-router |
| API client | `src/lib/api.js` | `apiFetch`, `ApiError`, CSRF, 401 handling |
| Auth UI | `src/lib/auth.js` | cookie session, admin permissions |
| Serverless | `api/` | CommonJS Vercel handlers, shared `api/_lib.js` |
| Database | `supabase/*.sql` | RPCs, RLS/grants, views, staged migrations |
| Tests | `scripts/test-*.mjs` | dependency-free Node + real PostgreSQL harness |
| Docs | `docs/` | handoff, security checklist, audit |

Key routes: `/`, `/shop`, `/product/:id`, `/cart`, `/checkout`, `/wishlist`,
`/track`, `/admin`. Private routes are `noindex` at the edge and in the SPA.
`vercel.json` holds rewrites, security headers, and CSP.

### Data model essentials

- `public.products` — catalog + `variantStock` keyed `"<size>-<color>"` +
  legacy `reservedStock` (unused). Browser cannot read the base table.
- `public.products_public` — explicit allow-list view, `WHERE active IS TRUE`.
- `public.users` — admin/staff accounts (`admin`, `manager`, `support`).
- `public.orders` — `ZSH-…` ids, JSON items/timestamps, lifecycle statuses.
- `public.coupons` — percentage/fixed, usage/date/min/max constraints.

---

## 2. Non-negotiable invariants

1. **Money is server-authoritative.** `api/orders.js` recomputes prices, discount,
   shipping, and totals from the database/coupon row. Never trust client totals.
2. **`reservedStock` is unused.** It is not in `products_public` and is never
   subtracted from availability. Do not add a writer/lifecycle without approval.
3. **Availability** = `max(0, stock)` for products without variants, or
   `variantStock["<size>-<color>"]` for products with variants. Never negative.
4. **Atomic lifecycle.** Order placement, status change, and deletion happen in
   one SQL function each. Lock order is `orders` → `products` (ascending id).
   Cancel/delete are idempotent; deduct is strict, restore is partial/tolerant.
5. **Coupons** increment usage only after a successful insert, in the same
   transaction. A coupon used by a non-cancelled order cannot be deleted.
6. **Browser isolation.** `users`, `orders`, and `coupons` are service-role only;
   base `products` is revoked after the staged `products_public` rollout.
7. **Auth.** HttpOnly cookie session + double-submit CSRF + Origin allow-list.
   `requirePerm` re-reads the DB role and `session_version` on every call.
8. **No secrets in the browser.** Only `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, and optional `VITE_GA_ID`. Never prefix service-role,
   `SESSION_SECRET`, Telegram, or Upstash values with `VITE_`/`REACT_APP_`.
9. **Floating actions stay accessible.** WhatsApp is visible at all times except
   while an editable field is focused on a phone (`≤767px`), when both actions
   hide so they clear the on-screen keyboard; they return on blur. Scroll-to-top
   appears after scrolling down and hides near the top. Both are fixed,
   `z-index: 30000`, use safe-area offsets, and stay above header, mobile nav,
   drawers, modals, and toasts. Never add any other obstruction or
   keyboard-hiding logic.
10. **Unknown routes are real 404s.** Do not silently redirect to `/`.

---

## 3. Coding conventions

- Match the surrounding code. The codebase uses single quotes, 2-space indent,
  function components, hooks, inline styles + one global `src/index.css`.
- Components live in `src/components/{shop,ui,admin}`; pages in `src/pages/`.
- Use `useStore` for shared state and subscribe with selectors in new code
  (`useStore((s) => s.cart)`); preserve existing call sites unless refactoring.
- Persisted values must use guarded parsing (`safeParseArray`) and safe defaults.
- Every async view: loading, empty, error, success. Every mutation: pending
  disabled state + user-visible success/failure.
- `apiFetch` throws `ApiError`; show `err.message`, branch on `err.status` only
  when behaviour differs. Never leave a promise unhandled.
- API handlers: `applyCors` → `OPTIONS` → method guard → rate limit →
  `requirePerm` → `readBody` → validation → service-role query → `json()`.
- SQL: idempotent, `SET search_path = public, pg_temp`, fail-closed guards,
  verification queries, rollback section, no destructive statements.
- Tests: plain `.mjs`, local `eq`/`ok`, sections `[n]`, final `N passed, M failed`,
  `process.exit(1)` on failure. Add regression coverage for every fix.
- Do not add dependencies, frameworks, or a second router/state library casually.
- Do not reformat unrelated lines; keep diffs reviewable.
- Copy is bilingual (English + Arabic) where the existing pattern is bilingual.

---

## 4. Commands

```bash
npm start                 # Vite UI only, http://localhost:3000 (PORT=… to change)
npm run dev               # same Vite server (dev command for `vercel dev`)
vercel dev                # full /api stack proxy (runs `npm run start`; --listen PORT)
npm test                  # all Node + SQL tests
npm run build             # production build → build/
node scripts/test-<x>.mjs # focused suite
npm audit --omit=dev      # dependency audit
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run build` with
`ZSHM_REQUIRE_SQL_TESTS=1`; a skipped SQL suite is a failure. Never report a
skipped suite as passing.

---

## 5. Skills (load with the `skill` tool by exact ID)

| Skill | Use when |
|---|---|
| `frontend-expert` | React/Vite UI, routing, Zustand, forms, responsiveness |
| `ui-ux-design` | Visual/UX/a11y review, brand system, floating actions |
| `supabase-database` | Schema, RLS/grants, views, RPCs, migrations |
| `backend-api` | `/api/*`, auth/session, validation, rate limiting, errors |
| `ecommerce-engineering` | Catalog, cart, checkout, coupons, stock, orders |
| `security-auditing` | Threat modelling, authz, exposure, hardening |
| `testing-qa` | Tests, regression coverage, journey verification |
| `seo-performance` | Metadata, JSON-LD, CWV, bundles, images, fonts |
| `production-devops` | Release order, env vars, rollout, rollback, incidents |
| `senior-code-review` | Final review before declaring work complete |

Load only what a task needs; always load `testing-qa` before verification and
`senior-code-review` before the final report.

## 6. Agents (`.opencode/agents/`)

| Agent | Mode | Purpose |
|---|---|---|
| `zashm-lead` | primary | plans work, loads skills, delegates, owns the final report |
| `zashm-frontend` | all | storefront/admin UI implementation |
| `zashm-backend` | all | API + database implementation |
| `zashm-security` | subagent (read-only) | security audit with evidence |
| `zashm-qa` | all | tests and journey verification |
| `zashm-seo` | subagent | SEO + performance measurement/fixes |
| `zashm-devops` | subagent | release readiness; never deploys without approval |
| `zashm-reviewer` | subagent (read-only) | severity-ordered diff review |

Invoke with natural language, e.g. “Use the `zashm-reviewer` subagent to review
my current changes.” Agents with `deny` cannot edit or deploy; they report.

---

## 7. Safety and data rules

- **Protect production data.** Preserve existing admins, users, orders, coupons,
  and products. Never delete or rewrite real records without explicit approval.
- **Back up first.** Policies, grants, function definitions, and env config must
  be captured before any risky change.
- **Migrations:** never assume applied; read the file header and current state.
  Apply in the documented order, one file at a time, with pre/post checks. Never
  rerun blindly. Lockdowns trail the replacement API/frontend.
- **Stop and report** on: nonzero/negative `reservedStock`, unexpected
  admin/user/order counts, migration conflicts, possible data loss, missing
  credentials, or any irreversible production impact.
- **No destructive tests** against production. Use local PostgreSQL/staging.
- **No fake features, mock production data, placeholder controls, or secrets.**
- **Do not weaken security** (RLS, CSRF, CORS, auth, rate limits) to make old
  code work.
- **Do not claim verification you did not perform.** Separate local proof,
  browser verification, and production verification.

### Known production blockers (as of the last audit)

- No Supabase Management token / DB connection string: SQL cannot be applied or
  catalog-verified from this environment; only the service-role REST key exists.
- Vercel CLI is logged out: deployments cannot be made or verified here.
- Vercel build-time env differences can change bundle hashes; verify the deployed
  bundle, not only a local build.
- `docs/production-remediation-handoff.md` and
  `docs/security-production-checklist.md` are the authoritative rollout docs;
  update them when decisions/order change.

---

## 8. Definition of done

- [ ] The change follows the relevant skill(s) and this guide.
- [ ] Correctness, authorization, error handling, and legacy data considered.
- [ ] Tests added/updated; `npm test` result stated (SQL suite actually ran).
- [ ] `npm run build` passes; no secret in the bundle.
- [ ] UI verified at 320/375/768/1440px when applicable; floating actions visible.
- [ ] Files changed and residual risks reported.
- [ ] No commit/push/deploy without explicit owner approval.
