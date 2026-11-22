# Playwright audit patterns (when available)

Use the project's existing harness first. Only add Playwright with owner
approval. All data must be synthetic; screenshots go to a temp directory and
must never contain real customer data.

## Check availability

```bash
npx playwright --version
ls playwright.config.* 2>/dev/null
grep -R "playwright" package.json
```

If missing, record the gap and use the available browser tooling instead.

## Minimal journey script

```js
import { chromium, devices } from '@playwright/test';

const browser = await chromium.launch();
const errors = [];
for (const preset of [devices['Desktop Chrome'], devices['iPhone 13'], devices['iPad (gen 7)']]) {
  const context = await browser.newContext({ ...preset, baseURL: process.env.AUDIT_BASE_URL });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${preset.name}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${preset.name}: ${e.message}`));
  for (const path of ['/', '/shop', '/product/test-sku', '/cart', '/checkout', '/login', '/missing']) {
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    const title = await page.title();
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    const innerW = await page.evaluate(() => window.innerWidth);
    console.log(JSON.stringify({ preset: preset.name, path, status: res?.status(), title, overflow: scrollW > innerW }));
    await page.screenshot({ path: `/tmp/audit-${preset.name}-${path.replace(/\W+/g, '_')}.png`, fullPage: true });
  }
  await context.close();
}
await browser.close();
console.log('console/page errors:', errors);
```

Adapt routes and selectors to the project. Do not hardcode credentials or
production URLs in a committed file — read them from environment variables.

## What to assert

- [ ] Status codes: 200 for real pages, 404 for unknown routes.
- [ ] No console errors or unhandled page errors.
- [ ] No horizontal overflow at any viewport.
- [ ] Every interactive element is keyboard reachable with visible focus.
- [ ] Forms validate, submit, and surface success/failure states.
- [ ] Auth boundaries: anonymous cannot reach private pages or APIs.
- [ ] Layout does not shift after images/fonts load (measure CLS).
- [ ] Lighthouse/axe runs recorded with scores and top failures.

## Safety

- Never run destructive journeys against production (no real orders, deletes,
  coupon burns, or account changes).
- Prefer preview/staging; if production read-only checks are needed, say so
  explicitly in the report.
- Delete temporary screenshots containing synthetic data when finished.
- Report skipped checks honestly; a skipped check is not a pass.
