---
name: Website Pre-launch Audit
description: "Runs a comprehensive pre-launch audit of any website - security (OWASP, authentication, APIs, database), UI/UX, responsive design, functional journeys, performance and Core Web Vitals, technical SEO, accessibility and WCAG, code quality, and deployment readiness. Use before launching a site, before a release, or whenever asked to audit a website for launch readiness. Produces a prioritised report and only applies safe improvements after an approved plan."
---

# Website Pre-launch Audit

## Mission

Audit a website end to end **before launch** and produce an evidence-based,
prioritised report. The deliverable is a decision: safe to launch, launch with
conditions, or no-go. Findings must point at real code, real behaviour, or a
measured result — never at assumptions about the stack.

**Order of operations: inspect → report → plan → approve → fix → verify.**

## Non-negotiable rules

1. **Inspect before recommending.** Read the actual repository, config, routes,
   tests and live site (if reachable). Do not assume the framework, hosting,
   database or auth model.
2. **No destructive changes without explicit owner approval.** Never deploy,
   push, apply production SQL, rotate secrets, delete data/users/orders, change
   DNS/Vercel/Supabase settings, force-push, or run destructive tests against
   production. Ask and wait for a clear yes.
3. **Never expose secrets or real user data.** Do not print `.env` values, tokens,
   connection strings, cookies, PII, order/customer records, or private URLs in
   the report or chat. Redact, summarise counts only, and use synthetic test data.
   Never attach screenshots containing real customer data.
4. **Prioritise critical security and functionality** over cosmetics. A broken
   auth rule or checkout outranks a spacing nit every time.
5. **Report first, fix second.** Implement safe improvements only after the
   project has been inspected and a written, prioritised plan has been approved.
6. **Verify every implemented change.** Focused test, full suite, build, and
   browser check where applicable. Never claim a verification that was not run.
7. **Separate proof classes.** Label results as *local proof*, *browser proof*, or
   *production proof*. Production access is never assumed.

## Phase 0 — Discovery (read-only)

Before any judgement:

- Inventory the repo: languages, framework, entry points, routes/pages, API
  handlers, build output, test scripts, CI workflows, docs, and infra config.
- Identify environments: local dev, preview/staging, production URLs and who
  owns them. Confirm which target the audit covers.
- Map sensitive surfaces: login/admin, payments/checkout, uploads/storage,
  database, third-party integrations, webhooks, analytics.
- Record a baseline: current branch, `git status`, dependency versions, last
  deployment, and which checks are already green.
- Note missing access (credentials, DB connection, deploy rights) explicitly —
  an unaudited surface is a finding, not a silent pass.

Use the dedicated project skills when they exist (security, frontend, backend,
database, SEO, QA, DevOps) — but this skill is the orchestrator and owns the
final report.

## Phase 1 — Cybersecurity

Audit against OWASP Top 10 and the project's threat model. Full checklist:
[AUDIT-CHECKLIST.md](AUDIT-CHECKLIST.md).

Minimum coverage:

- **Access control / IDOR:** authorisation on every route and object, role checks
  re-read from the source of truth, no client-trusted role or user id.
- **Authentication:** cookie flags (`HttpOnly`, `Secure`, `SameSite`), CSRF and
  Origin allow-list, session rotation/revocation, password policy, lockout and
  rate limits, privilege escalation, session fixation.
- **APIs:** input validation and bounds, mass assignment, server-authoritative
  money/pricing, idempotency, error contracts without stack traces, CORS, rate
  limits, business-logic abuse (coupons, stock, trials).
- **Database:** RLS and grants, least privilege, service-role isolation,
  parameterised queries, safe/idempotent migrations, backup and restore story,
  PII exposure through views or logs.
- **Secrets/config:** no service-role keys or private tokens in the client
  bundle; env separation; `.gitignore`; dependency audit; CSP, HSTS, HTTPS,
  security headers; file upload size/type sniffing and storage bucket policies.
- **Logging/monitoring:** auth failures and mutations logged without PII;
  alerting exists for the launch path.

## Phase 2 — UI/UX

Check brand consistency, colour and contrast, typographic scale, spacing grid,
visual hierarchy, states (loading / empty / error / success), button and form
affordances, iconography, motion, microcopy, and bilingual or RTL behaviour where
applicable. Flag inconsistent patterns, clipped text, overlapping fixed
elements, and controls that hide content or the on-screen keyboard.

## Phase 3 — Responsive design

Verify 320, 375, 768, 1024 and 1440 px (plus landscape on phones): no horizontal
scroll, no overflow or clipping, readable type, touch targets ≥ 44 px, usable
forms with the virtual keyboard open, correct stacking of sticky/fixed actions,
and safe-area insets. Test real content, not placeholder text.

## Phase 4 — Functional testing

Enumerate **every** page/route, button, link, form, modal, and user journey into
a matrix of *expected vs actual*. Cover:

- happy path, validation failures, empty states, error states, and retries;
- auth states (anonymous, customer, staff/admin), permission boundaries;
- persistence across reload, back/forward navigation, and deep links;
- unknown routes return a real 404; destructive actions confirm and are
  idempotent;
- all mutation results visible to the user (pending, success, failure).

Use synthetic accounts and data only.

## Phase 5 — Performance & Core Web Vitals

Measure, do not guess. Targets: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, TTFB
≤ 800 ms (lab targets, note field data when available). Check bundle size and
code splitting, image formats/dimensions/`srcset`/lazy loading, font loading,
caching/CDN headers, third-party script cost, N+1 or unbounded queries, layout
shifts, and long tasks. Separate lab results from field data.

## Phase 6 — Technical SEO

Metadata and unique titles/descriptions, canonical tags, `robots.txt`, sitemap,
XML validity, `noindex` on private/authenticated routes, structured data
validity, Open Graph/social cards, hreflang for multilingual sites, clean URL
and redirect rules, crawlable links, real 404s instead of soft redirects, image
alt text, and mobile-friendliness.

## Phase 7 — Accessibility (WCAG 2.2 AA)

POUR: perceivable, operable, understandable, robust. Check colour contrast
(4.5:1 text, 3:1 large text/UI), keyboard access and visible focus, semantic
headings/landmarks, form labels and error association, alt text, ARIA correctness,
no keyboard traps, 200% zoom, reduced-motion support, and screen-reader sanity
checks. Combine automated scans with manual keyboard/visual checks.

## Phase 8 — Code quality & architecture

Structure and separation of concerns, duplication/dead code, error handling and
unhandled promises, state management, dependency hygiene, test coverage for new
branches, observability, configuration management, and maintainability. Match
existing conventions; do not introduce a second framework/router/state library.

## Phase 9 — Production & deployment readiness

Environment variables and build-time values, CI pipeline, migration order and
rollback plan, backups, DNS/TLS, security headers, monitoring/alerting, runbook,
feature flags, and a documented verification checklist. Confirm the deployed
bundle matches what was tested. **Never deploy without explicit approval.**

## Phase 10 — Automated browser testing (Playwright when available)

- Prefer the project's existing test harness. Check for Playwright with
  `npx playwright --version` or its config; do not add a heavy dependency
  without approval.
- When available, drive real pages across the viewport matrix, assert journeys,
  collect console/network errors, capture screenshots to a temp directory, and
  run accessibility/axe checks. Use synthetic data only.
- When unavailable, record the gap and fall back to the in-app browser or
  available tooling; state what could not be verified.
- See [PLAYWRIGHT.md](PLAYWRIGHT.md) for reusable patterns.

## Severity and finding format

| Severity | Meaning |
|---|---|
| **Blocker** | Data loss, auth bypass, payment/stock corruption, broken production build, launch-breaking failure. |
| **High** | User-visible broken journey, authorisation gap, race condition, PII leak, major a11y/SEO failure. |
| **Medium** | Edge-case bug, missing validation/state, performance regression, inconsistent UX. |
| **Low** | Maintainability, minor a11y/UX, documentation drift. |

Every finding:

```
[Severity] Short title
Location: path:line / URL / screen
Evidence: what was observed and how it was reproduced
Impact: concrete failure or risk
Fix: smallest correct change
Verification: test or command that proves the fix
Approval: required | not required
```

## Safe improvement workflow

1. Present the prioritised findings and a concrete plan (scope, files, order,
   rollback). **Wait for explicit approval.**
2. Apply one concern at a time; back up configs/policies before changing them.
3. Keep production data and access untouched; use local/staging/synthetic data.
4. Stop and report on migration conflicts, unexpected data, missing credentials,
   or any irreversible impact.
5. Verify each fix, then re-run the full audit scope affected by it.
6. If verification fails, revert the change and report — do not paper over it.

## Report

Write a detailed report using [REPORT-TEMPLATE.md](REPORT-TEMPLATE.md). It must
include the executive summary, scope and method, severity counts, all findings,
verified evidence, residual risks, explicitly unverified items, and a clear
go / no-go recommendation.

## Verification checklist (before signing off)

- [ ] Repository inspected; stack and environments documented.
- [ ] All ten audit areas covered or explicitly marked unverified.
- [ ] Findings are severity-ordered with evidence and locations.
- [ ] No secrets or real user data in the report or chat.
- [ ] Approved changes implemented and verified; full suite and build run where applicable.
- [ ] Browser verification performed at the responsive matrix where applicable.
- [ ] Residual risks and unverified production items listed.
- [ ] No commit/push/deploy/SQL/secret change made without approval.
