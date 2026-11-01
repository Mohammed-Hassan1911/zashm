---
name: Security Auditing
description: "Use when reviewing or hardening ZASHM security: authentication, sessions, CSRF/CORS, RLS, secrets, XSS, CSP, storage, rate limiting, coupon abuse, order tracking, and data exposure."
---

# ZASHM Security Auditing

## Mission

Find and prove real vulnerabilities in ZASHM, then fix them without breaking
legitimate flows or exposing data during the audit itself. Prefer read-only
verification; never run destructive tests against production.

## Trust boundaries

```
Browser (anon key, public bundle)
   │  fetch /api/*  (cookie session + CSRF; guest checkout)
   ▼
Vercel serverless (service-role key, SESSION_SECRET, Telegram/Upstash secrets)
   │  service role (BYPASSRLS)
   ▼
Supabase Postgres + Storage
```

The anon key is public by design. Anything readable with it is public data.
The service-role key must never reach the browser, logs, URLs, or error bodies.

## ZASHM threat model (prioritised)

1. **Direct anon/authenticated access** to `users`, `orders`, `coupons`, or the
   base `products` table (PII, password hashes, coupon abuse, inventory data).
2. **Auth bypass / IDOR** in `/api/admin/*` — missing `requirePerm`, trusting a
   client role/id, or acting on a resource without an ownership/permission check.
3. **Session attacks** — stolen cookie, CSRF, origin bypass, token replay after
   role change/deletion, weak password hashing, user enumeration.
4. **Checkout/coupon abuse** — client-supplied prices/totals, coupon guessing,
   usage-limit races, idempotency replay with a different cart.
5. **Inventory races** — overselling the last unit, double restore on cancel,
   negative stock, coupon usage lost on failure.
6. **Injection/XSS** — raw order/customer text in Telegram/HTML, unescaped
   product fields, `javascript:` URLs, SQL string interpolation in RPCs.
7. **Data leakage in errors/logs** — driver messages containing row values,
   stack traces, internal ids; verbose auth errors enabling enumeration.
8. **Storage abuse** — public bucket listing, unrestricted MIME/size, orphaned
   uploads, path traversal in object keys.
9. **Rate-limit gaps** — login, coupon validation, checkout, admin mutations;
   per-instance fallback mistaken for durable protection.
10. **Transport/config** — missing security headers, weak CSP, permissive CORS,
   `noindex` missing on private routes, debug flags, exposed source maps.

## Audit method

1. **Baseline:** read `docs/security-production-checklist.md` and
   `docs/production-remediation-handoff.md`. Never assume a migration is applied.
2. **Static trace:** for each route, follow request → method guard → CORS/CSRF →
   `requirePerm` → validation → service-role query/RPC → response. Note gaps.
3. **Anon probe (read-only):** with the anon key, `GET /rest/v1/<table>` must be
   401/403 for `users`, `orders`, `coupons`, `products`; `products_public` must
   return only public columns and no `reservedStock`. Storage listing must be
   denied.
4. **Auth probe:** login with a wrong password and a nonexistent email — response
   shape/timing should not enumerate users. Check cookie flags (`HttpOnly`,
   `Secure`, `SameSite`), TTL, logout clearing, and `session_version` revocation.
5. **CSRF/CORS probe:** unsafe cookie-authenticated requests without
   `X-CSRF-Token` or from a foreign Origin must be 403; Bearer requests are
   exempt by design.
6. **Authorization matrix:** admin/manager/support × each admin route. Confirm
   least privilege and that a demoted/deleted user's token stops working.
7. **Business-logic probe (staging/local only):** forged totals/discounts,
   coupon reuse, concurrent last-unit orders, concurrent cancels, idempotency
   key reuse. Use the real PostgreSQL harness.
8. **Client bundle:** grep the built output for `SERVICE_ROLE`, `SESSION_SECRET`,
   Telegram/Upstash tokens, and unexpected `VITE_` secrets.
9. **Headers:** verify CSP, HSTS, `X-Frame-Options`, `nosniff`, referrer policy,
   permissions policy, and `X-Robots-Tag` on private routes.
10. **Report:** severity, evidence, affected files/lines, exploitability, fix,
    residual risk. Never include live secrets or full PII in the report.

## Severity guide

| Level | Meaning | Examples |
|---|---|---|
| Critical | Immediate data/account compromise | anon can read `users.passwordhash`; auth bypass on admin route; service-role key in bundle |
| High | Major abuse or PII exposure | coupon/order tampering, oversell race, stolen-session replay, stored XSS |
| Medium | Limited exposure or hardening gap | verbose errors, missing rate limit, weak CSP, storage listing |
| Low | Defence-in-depth | missing header, cookie flag nuance, noisy logs |

## Known ZASHM controls (verify, don't assume)

- HttpOnly session cookie + double-submit CSRF; legacy Bearer supported; origin
  allow-list; `session_version` re-check on every privileged call.
- scrypt password hashing (`scrypt$N$r$p$salt$hash`), legacy SHA-256 compatibility
  path, dummy hash for nonexistent users (timing equalisation), 12+ password
  policy, last-admin trigger.
- `requirePerm` uses the DB role, not the token role.
- Shared rate limiter with Upstash when configured; per-instance fallback logs a
  warning. Coupon validation has a per-code lockout.
- `atomic_place_order` recomputes money server-side and holds a coupon lock;
  lifecycle functions lock the order first.
- RLS + grant lockdown for `users`, `orders`, `coupons`; base `products` revoked
  after the staged `products_public` rollout.
- `products_public` uses an explicit allow-list and `WHERE active IS TRUE`.
- Storage: 5 MB, image MIME allow-list, no anon listing; uploads sniffed by magic
  bytes; unreferenced images cleaned.
- Security headers + CSP in `vercel.json`; private routes `noindex`.
- Telegram message sanitisation; tracking tokens are HMAC-signed.

Treat every item above as **to verify**, not as reassurance.

## Hard rules for auditors

- **No destructive production testing.** No writes, deletes, stock changes, or
  coupon tests against production. Use local PostgreSQL/staging.
- **No secret exfiltration.** Do not print env values, tokens, hashes, or full
  customer rows. Redact to a prefix/length when evidence is needed.
- **No broad scans** that could trip rate limits or look like an attack. Scope to
  the project and use the documented probes.
- **Do not "fix" by weakening controls** (e.g. reopening RLS so an old bundle
  works, disabling CSRF, allowing all origins).
- **Stop and report** any sign of active compromise, unexpected admin accounts,
  nonzero `reservedStock`, or data that does not match the documented baseline.

## Verification commands (safe)

```bash
npm test                      # includes SQL concurrency harness (local PG)
npm run build                 # then grep build/ for secrets
node scripts/test-edge-transport.mjs
node scripts/test-sessions-admin.mjs
node scripts/test-final-hardening.mjs
```

For production, use only read-only HTTP probes with the anon key and
`supabase/verify_production_security.sql` in the SQL Editor.
