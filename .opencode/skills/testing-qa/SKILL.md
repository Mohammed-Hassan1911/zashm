---
name: Testing & QA
description: Use when adding or running ZASHM tests, writing regression coverage, validating user journeys, reproducing bugs, or deciding whether a change is safe to merge.
---

# ZASHM Testing & QA

## Mission

Prove behaviour, not just presence. ZASHM uses dependency-free Node test scripts
and a real PostgreSQL harness; keep that style — do not add Jest/Vitest/Playwright
unless the user explicitly asks.

## Test suite map

| Script | Focus |
|---|---|
| `scripts/test-analytics.mjs` | GA event shape, no PII, opt-out |
| `scripts/test-coupons.mjs` | coupon validation/pricing + static security assertions |
| `scripts/test-order-lifecycle.mjs` | status/delete RPC behaviour, legacy payloads, concurrency |
| `scripts/test-order-pricing.mjs` | server totals, availability, idempotency races |
| `scripts/test-sessions-admin.mjs` | login/session/CSRF/revocation/last-admin/password policy |
| `scripts/test-admin-products.mjs` | admin auth, full rows, no error leakage, router wiring |
| `scripts/test-edge-transport.mjs` | headers/CSP/rewrites, storage migration, rate limiter |
| `scripts/test-final-hardening.mjs` | Telegram/XSS, ids, image sniffing, tracking, SQL hardening, view, floating actions |
| `scripts/test-sql-concurrency.mjs` | applies all migrations to a temp PostgreSQL cluster and races real connections |

`npm test` runs them in that order. CI (`.github/workflows/ci.yml`) sets
`ZSHM_REQUIRE_SQL_TESTS=1`, so a missing PostgreSQL binary **fails** instead of
skipping. Locally, a skipped SQL suite is allowed but must be reported as skipped,
never as passing.

## Style

- Plain ESM `.mjs`, `node:assert`-free custom `eq`/`ok` helpers, sections logged
  as `[n] description`, final `N passed, M failed`, `process.exit(1)` on failure.
- Tests import code with `createRequire` and stub `@supabase/supabase-js` through
  `Module._load`; no network and no real credentials.
- SQL tests use a temporary cluster (initdb/pg_ctl/psql), apply the actual
  migration files, and exercise two connections for races. Never mock the SQL
  you are trying to prove.
- Static assertions are acceptable for frontend/security invariants (e.g. CSS
  z-index, absence of an auth bypass, presence of a permission check) when a
  browser harness is not available. Make the assertion precise, not a broad
  keyword match that can pass accidentally.

## What to cover for a change

1. **Happy path** — the user-visible outcome.
2. **Validation** — missing/boundary/oversized inputs.
3. **Authorization** — unauthenticated, wrong role, stale session.
4. **Conflicts** — duplicate, race, optimistic status mismatch.
5. **Failure** — DB error, network error, malformed legacy data; no 500 where a
    safe 4xx is expected.
6. **Regression** — the exact bug you fixed, asserted so it cannot return.

For SQL changes, add: concurrent callers, missing row/product/variant, duplicate
idempotency keys, and rollback/no-write-on-error.

## Running

```bash
npm test                 # full suite
node scripts/test-final-hardening.mjs
VERBOSE=1 node scripts/test-order-lifecycle.mjs
npm run build            # required for frontend changes
```

For UI journeys, run the Vite server (`npm start`, port 3000) or `npm run dev`
when `/api` is required, then verify in a browser at 320/375/768/1440px. Cover:
home → shop → product → size/colour → add to bag → cart → coupon → checkout →
success → track; login → admin → product edit → order status → cancel; deep-link
and back/forward; empty and error states.

## Test data hygiene

- Never use production Supabase for write tests.
- Use the local PostgreSQL harness or a dedicated staging project.
- Do not add fake production rows, mock customer PII, or seed scripts that could
  run against production.
- If a test needs a credential, read it from an env var and skip with a clear
  message when absent — never hardcode it.

## Flakiness rules

- No arbitrary `setTimeout` waits for correctness; await the real promise/event.
- Concurrency tests must synchronise on real locks/connections, not timers.
- Clean up temp clusters, servers, and files even on failure.
- Tests must be deterministic and independent of ordering.

## Reporting

Always report: command, exit code, pass/fail counts, and any skipped suite with
the reason. Never say "tests pass" when the SQL suite was skipped. Distinguish
"unit/static proven" from "verified in a real browser" and "verified in
production".
