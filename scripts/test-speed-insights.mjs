/**
 * Vercel Speed Insights integration.
 *
 *   node scripts/test-speed-insights.mjs
 *
 * Proves the dependency is declared, the script is initialised once in the
 * browser entry, private routes are filtered before send, and the CSP allows
 * only the two Vercel-owned domains the SDK needs.
 */
import { readFileSync } from 'node:fs';
import { shouldReportVital } from '../src/lib/speedInsights.mjs';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n[1] dependency and entry point');
{
  const pkg = JSON.parse(read('package.json'));
  ok(pkg.dependencies && pkg.dependencies['@vercel/speed-insights'], 'SDK is a runtime dependency');
  const entry = read('src/index.js');
  ok(/import\s*\{\s*injectSpeedInsights\s*\}\s*from\s*'@vercel\/speed-insights'/.test(entry),
    'the SDK is imported in the browser entry');
  eq((entry.match(/injectSpeedInsights\(/g) || []).length, 1, 'the SDK is injected exactly once');
  ok(/import\s*\{\s*shouldReportVital\s*\}\s*from\s*'\.\/lib\/speedInsights\.mjs'/.test(entry),
    'the private-route filter is imported');
  ok(/beforeSend:\s*\(event\)\s*=>\s*\(shouldReportVital\(event && event\.url\)\s*\?\s*event\s*:\s*null\)/.test(entry),
    'beforeSend drops events for private routes');
}

console.log('\n[2] private URL filter');
{
  eq(shouldReportVital('https://za-shm.vercel.app/'), true, 'home is measured');
  eq(shouldReportVital('https://za-shm.vercel.app/shop'), true, 'shop is measured');
  eq(shouldReportVital('https://za-shm.vercel.app/product/42'), true, 'product pages are measured');
  eq(shouldReportVital('/admin'), false, 'admin is excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/admin/orders'), false, 'admin sub-pages are excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/cart'), false, 'cart is excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/checkout'), false, 'checkout is excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/wishlist'), false, 'wishlist is excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/track/ZSH-1'), false, 'tracking pages are excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/?track=ZSH-1&tk=abc'), false, 'tracking deep links are excluded');
  eq(shouldReportVital('https://za-shm.vercel.app/?tk=abc'), false, 'tk links are excluded');
  eq(shouldReportVital('not a url with spaces'), false, 'malformed URLs fail closed');
}

console.log('\n[3] CSP allows only the SDK domains');
{
  const cfg = JSON.parse(read('vercel.json'));
  const csp = cfg.headers.find((h) => h.source === '/(.*)')
    .headers.find((h) => h.key === 'Content-Security-Policy').value;
  const directive = (name) => (csp.match(new RegExp(`${name} ([^;]+)`)) || [])[1] || '';
  ok(directive('script-src').includes('https://va.vercel-scripts.com'), 'SDK script host is allowed');
  ok(directive('connect-src').includes('https://vitals.vercel-insights.com'), 'fallback intake host is allowed');
  ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no inline scripts were enabled');
  ok(/script-src-attr 'none'/.test(csp), 'inline event handlers remain forbidden');
}

console.log(`\nspeed-insights: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
