# Audit checklist (detail)

Work top to bottom. Mark each item **pass / fail / N/A / unverified** with
evidence. Never mark `unverified` as `pass`.

## 1. Security — OWASP Top 10

- **A01 Broken access control:** every endpoint/route enforces authz server-side;
  object-level checks (IDOR); role re-read from source of truth; no client-trusted
  role/user id; private routes return real 404/403; static files not private data.
- **A02 Cryptographic failures:** TLS everywhere, HSTS, no secrets in client
  bundle, strong password hashing, secure session ids, no sensitive data in URLs.
- **A03 Injection:** parameterised SQL, no dynamic query string building,
  output encoding, safe shell/command usage, template injection checks.
- **A04 Insecure design:** rate limits, abuse cases, business-logic validation,
  least privilege by default, fail-closed guards.
- **A05 Security misconfiguration:** security headers (CSP, X-Content-Type-Options,
  Referrer-Policy, frame controls), debug mode off, default accounts removed,
  verbose errors off, CORS allow-list, storage bucket policies.
- **A06 Vulnerable components:** `npm audit --omit=dev` (or ecosystem equivalent),
  outdated frameworks, unneeded dependencies, lockfile committed.
- **A07 Auth failures:** HttpOnly/Secure/SameSite cookies, CSRF tokens and Origin
  checks, session rotation on login, logout invalidation, brute-force lockout,
  password policy, MFA where applicable.
- **A08 Software/data integrity:** signed updates, safe deserialization, no
  client-trusted prices/totals/roles, CI integrity.
- **A09 Logging/monitoring:** auth failures and mutations logged without PII,
  alerting configured, logs not publicly readable.
- **A10 SSRF:** no user-controlled outbound URLs without allow-list, no internal
  metadata access, redirects validated.

### Database

- RLS enabled on sensitive tables; grants revoked from anonymous/authenticated
  roles; service role used only server-side.
- Views expose explicit allow-lists, not base tables.
- Migrations are idempotent, ordered, have pre/post checks and a rollback section.
- No destructive statements against production; backup before risky changes.
- PII minimised, encrypted at rest where required, excluded from logs.

### APIs

- Auth → CORS/Origin → method guard → rate limit → validation → query → response.
- Inputs typed, bounded, enumerated; no mass assignment.
- Error contract stable; no raw driver errors leaked.
- Idempotency for mutations; concurrency safe; server-authoritative money/stock.

## 2. UI/UX

- [ ] Consistent palette, spacing scale, radii, and elevation.
- [ ] Typographic hierarchy: one display face, one UI face, readable sizes.
- [ ] Colour used meaningfully (error/success/neutral), not decoratively.
- [ ] All states designed: loading, empty, error, success, disabled, readonly.
- [ ] Buttons/links recognisable, labels specific, no dead or placeholder controls.
- [ ] Forms: inline validation, clear errors, preserved input on failure.
- [ ] Fixed/sticky elements never cover content or the virtual keyboard.
- [ ] Bilingual/RTL layout mirrors correctly where applicable.
- [ ] Motion is subtle, respects `prefers-reduced-motion`.

## 3. Responsive

- [ ] 320 / 375 / 768 / 1024 / 1440 px and phone landscape.
- [ ] No horizontal scroll at any width; long words/URLs wrap or truncate.
- [ ] Touch targets ≥ 44×44 px with adequate spacing.
- [ ] Navigation collapses and reopens correctly.
- [ ] Images/videos scale without layout shift.
- [ ] Modals/drawers fit the viewport and scroll internally.
- [ ] Safe-area insets for notched devices.

## 4. Functional journeys

For each route and component record expected vs actual:

- [ ] Every nav link, button, icon button, and form submits to the right action.
- [ ] Happy path completes end to end.
- [ ] Validation errors, empty results, and API failures are visible and recoverable.
- [ ] Auth gates: anonymous / customer / staff / admin boundaries.
- [ ] Reload, back/forward, and deep links preserve correct state.
- [ ] Unknown routes are real 404s.
- [ ] Two rapid submissions cannot double-charge/double-write.
- [ ] Session expiry handled without losing work silently.

## 5. Performance / Core Web Vitals

- [ ] LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, TTFB ≤ 800 ms (lab; note field data).
- [ ] Images: modern format, explicit dimensions, `srcset`, lazy below the fold.
- [ ] Fonts: subset, `font-display: swap`, preload the LCP font.
- [ ] JS/CSS split into caches; no unused admin code in the storefront path.
- [ ] Caching/CDN and compression headers verified.
- [ ] Third-party scripts deferred and measured.
- [ ] No layout shift from late content, ads, or fonts.
- [ ] Database queries bounded; no N+1 in hot paths.

## 6. Technical SEO

- [ ] Unique titles and meta descriptions; canonical per URL.
- [ ] `robots.txt`, `sitemap.xml`, valid XML, correct production hosts.
- [ ] `noindex` on private/auth routes; no private URLs in sitemap.
- [ ] Structured data present and valid for the page type.
- [ ] Open Graph/Twitter cards with real images.
- [ ] hreflang / locale alternates if multilingual.
- [ ] 301 redirects vs real 404s; no soft 404s or redirect chains.
- [ ] Des crawlable link text; headings form a logical outline.

## 7. Accessibility (WCAG 2.2 AA)

- [ ] Contrast: 4.5:1 body text, 3:1 large text and UI components.
- [ ] Full keyboard operation, visible focus, logical tab order, no traps.
- [ ] Skip link, landmarks, one `<h1>`, ordered headings.
- [ ] Form labels, `aria-describedby` errors, required states announced.
- [ ] Alt text for informative images; `alt=""` for decorative.
- [ ] ARIA used only where native semantics are insufficient.
- [ ] 200% zoom and 400% reflow without loss of content.
- [ ] `prefers-reduced-motion` honoured; no flashing content.
- [ ] Automated scan + manual keyboard/screen-reader spot check.

## 8. Code quality

- [ ] Clear structure; concerns separated; no duplicate helpers.
- [ ] No dead code, TODO stubs, placeholder controls, or mock production data.
- [ ] Errors handled; promises never left unhandled; states complete.
- [ ] Tests exist for new branches; full suite and build pass.
- [ ] No secrets in source; dependencies minimal and licensed.
- [ ] Docs updated when behaviour or order changes.

## 9. Deployment readiness

- [ ] Env vars complete for the target environment; build-time values verified.
- [ ] CI green; production build tested, not just dev server.
- [ ] Migration order and rollback documented; backups verified.
- [ ] DNS/TLS/certificates valid; security headers live.
- [ ] Monitoring, error tracking, and alerting active.
- [ ] Deployed bundle hash matches tested build when possible.
- [ ] Runbook and owner contacts documented.
- [ ] Explicit approval recorded before any deploy.

## 10. Evidence ledger

Keep a short table: area | check | result | evidence | severity | owner action.
