---
name: Senior Code Review
description: Use when reviewing ZASHM changes for correctness, security, data integrity, performance, maintainability, and regressions before merge or deployment.
---

# ZASHM Senior Code Review

## Mission

Find defects that would hurt customers, revenue, or security — with evidence.
A review is not a style preference list. Every finding must point at real code
and describe a concrete failure mode.

## Review order (highest risk first)

1. **Data integrity**
   - Orders: can totals/discounts be forged? Is stock/coupon movement atomic and
     idempotent? Can cancel/delete double-restore? Are legacy `items` shapes safe?
   - Products: does `stock = sum(variantStock)` still hold? Is `reservedStock`
     still excluded from availability? Can stock go negative?
   - Coupons: usage increments only on success; delete guard for open orders;
     expired/limit/min/max rules consistent between JS and SQL.
2. **Security**
   - Every admin route calls `requirePerm` with the right permission.
   - No service-role key, session secret, or PII in client code/logs/responses.
   - Cookie sessions enforce Origin + CSRF; Bearer path is intentional.
   - Inputs validated and bounded; no mass assignment; no raw driver errors.
   - RLS/grants: a change must not reopen `users`, `orders`, `coupons`, or base
     `products` to anon/authenticated.
3. **Correctness and failure handling**
   - Promise rejections handled; loading/error/empty states present.
   - 4xx vs 5xx mapping correct; no silent catches that hide data loss.
   - Null/undefined, empty arrays, deleted rows, and partial restores handled.
   - Timezone (Cairo) and money rounding are consistent.
4. **Concurrency**
   - SQL functions lock in the documented order (`orders` → `products` asc).
   - Optimistic status checks return `status_changed`, not a lost update.
   - Idempotency distinguishes duplicate from conflicting reuse.
5. **Performance**
   - No admin-only dependency imported into the storefront path.
   - No N+1 service-role queries or unbounded `select('*')` in hot paths.
   - Images sized/lazy; no layout shift; no unnecessary re-renders in new code.
6. **Accessibility/UX**
   - Keyboard, focus, labels, contrast, mobile layout, floating actions still
     visible above every layer.
7. **Maintainability**
   - Matches existing patterns; no duplicate helpers; no dead code; tests cover
     the new branch; docs updated when behaviour/order changes.

## How to review in this repo

```bash
git status --short
git diff --stat
git diff -- <file>
npm test
npm run build
```

- Read the full changed function plus its callers and the SQL it depends on.
- For migrations, read the header, gates, pre/post checks, and rollback; verify
  the file is idempotent and ordered correctly.
- For API changes, trace the request end-to-end and check the response contract
  against `src/lib/api.js` and the admin UI.
- For UI changes, check the relevant CSS/media queries and the floating-action
  invariant (`z-index: 30000`, always rendered, safe-area offsets).
- Run the specific test script when the full suite is slow; still run the full
  suite before declaring the change safe.

## Severity and format

Report findings as:

```
[Blocker|High|Medium|Low] <short title>
File: path:line
Why: concrete failure/exploit/regression
Fix: smallest correct change
Test: how to prove it (existing script or new assertion)
```

- **Blocker:** data loss, security bypass, payment/stock corruption, broken
  production build.
- **High:** user-visible broken journey, auth/authorization gap, race, PII leak.
- **Medium:** edge-case bug, missing validation/state, performance regression.
- **Low:** maintainability, minor a11y/UX, docs drift.

Include what you verified (commands, results) and what you could not verify
(credentials, production access). Never claim a production check you did not run.

## Review anti-patterns to reject

- Broad `catch {}` that swallows a failed write or restore.
- Trusting client price/total/discount/role/user id.
- Reintroducing `reservedStock` subtraction or direct base-table reads.
- Hiding floating buttons, lowering their z-index, or adding obstruction logic.
- Running lockdown SQL before the replacement API/frontend is live.
- "Fixing" a test by weakening the assertion instead of the code.
- Adding mock production data, fake features, or placeholder controls.
- New dependencies/frameworks without justification.
- Editing unrelated lines or reformatting whole files.

## Sign-off checklist

- [ ] Findings reported in severity order with file:line.
- [ ] `npm test` result stated (including any skipped suite).
- [ ] `npm run build` result stated.
- [ ] No secret/production data exposed during review.
- [ ] Residual risks and unverified production items listed explicitly.
- [ ] No commit/push/deploy performed without owner approval.
