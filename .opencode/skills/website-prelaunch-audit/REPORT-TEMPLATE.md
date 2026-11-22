# Pre-launch audit report

> Copy this template into a new report file. Replace every bracketed placeholder.
> Redact secrets and real user data before sharing. State proof class for each
> verified item: **local**, **browser**, or **production**.

---

# Pre-launch Audit — [Site / Product]

**Date:** [YYYY-MM-DD]
**Auditor:** [name/agent]
**Scope:** [URLs, repo commit/branch, environments]
**Out of scope:** [surfaces not inspected, and why]

## Executive summary

[2–4 sentences: overall readiness, top risks, recommendation.]

**Recommendation:** [ ] Go  [ ] Go with conditions  [ ] No-go

## Severity summary

| Severity | Count | Launch-blocking? |
|---|---:|---|
| Blocker | 0 | Yes |
| High | 0 | Usually |
| Medium | 0 | No, track |
| Low | 0 | No |

## Findings

Repeat per finding, ordered by severity:

### [Blocker|High|Medium|Low] [Short title]

- **Location:** `path:line`, URL, or screen
- **Area:** [Security | UI/UX | Responsive | Functional | Performance | SEO | Accessibility | Code | Deployment]
- **Evidence:** [observed behaviour, command output, measurement, screenshot ref]
- **Impact:** [concrete failure / risk]
- **Fix:** [smallest correct change]
- **Verification:** [test/command/journey that proves the fix]
- **Approval required:** [yes/no + what]
- **Status:** [open | fixed & verified | accepted risk]

## Coverage matrix

| Area | Result | Evidence | Unverified |
|---|---|---|---|
| Security / OWASP | pass/fail | | |
| UI/UX | pass/fail | | |
| Responsive | pass/fail | | |
| Functional | pass/fail | | |
| Performance / CWV | pass/fail | | |
| Technical SEO | pass/fail | | |
| Accessibility / WCAG | pass/fail | | |
| Code quality | pass/fail | | |
| Deployment readiness | pass/fail | | |
| Browser automation | pass/fail/skipped | | |

## Verification log

| Change | Command / journey | Result | Proof class |
|---|---|---|---|
| | | | local / browser / production |

## Residual risks

- [Risk and who accepts it]

## Unverified / blocked

- [Missing credentials, inaccessible production, no Playwright, etc.]

## Conditions to launch

1. [Specific, testable condition]
2. [Specific, testable condition]

## Appendix

- Commands run: [list]
- Test suites: [counts, including skipped suites honestly]
- Build: [result]
- Secrets exposed: **none** (confirm)
- Production changes made: **none** (unless approved and listed)
