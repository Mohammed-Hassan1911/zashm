/**
 * Regressions from the final independent admin-console review.
 *
 *   node scripts/test-admin-review-fixes.mjs
 *
 * Source-level guards for state transitions that are otherwise hard to reach
 * in the dependency-free harness: closing the product editor while a save is
 * in flight, and the compact summary/full snapshot notification race.
 */
import { readFileSync } from 'node:fs';

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

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

console.log('\n[1] product editor cannot be cancelled mid-save');
{
  const src = read('src/pages/AdminApp.js');
  ok(/const formDialog = useAdminDialog\(\{[^}]*disabled: savingProduct/.test(src),
    'the product editor dialog disables Escape while saving');
  ok(/const handleCancel = async \(\) => \{[\s\S]{0,600}if \(savingProduct \|\| cancelInFlightRef\.current\) return;/.test(src),
    'handleCancel is a no-op while a product save is pending');
  ok(/<button type="button" className="outline-btn" onClick=\{handleCancel\} disabled=\{savingProduct\}>Cancel<\/button>/.test(src),
    'the Cancel button is disabled while saving');
}

console.log('\n[2] compact poll cannot seed a partial first-load baseline');
{
  const src = read('src/store.js');
  ok(/let orderSnapshotLoaded = false;/.test(src), 'a full-snapshot gate is shared by both poll paths');
  ok(/const firstLoad = !orderSnapshotLoaded;/.test(src), 'the full refresh owns the first-load decision');
  ok(/const firstSummary = !summarySeeded;/.test(src), 'only the first summary seeds the baseline');
  ok(/if \(fullOrders\.length === 0\) initNotifBaseline\(\);/.test(src),
    'a summary-only first load initialises the read baseline');
  ok(!/const firstSummary = knownOrderIds === null;/.test(src), 'the summary no longer seeds from five partial ids');
  ok(/const fresh = firstSummary \? \[\] : newest\.filter/.test(src), 'a first summary never reports fresh orders');
}

console.log('\n[3] support PII mask covers customer free text and tracking credentials');
{
  const src = read('api/admin/orders.js');
  const fields = src.match(/const SUPPORT_PII_FIELDS = \[([^\]]+)\]/);
  ok(Boolean(fields), 'the support field allow-list exists');
  const list = fields ? fields[1].replace(/['\s]/g, '') : '';
  for (const field of ['customer', 'phone', 'phoneAlt', 'email', 'address', 'notes', 'tracking_url']) {
    ok(list.split(',').includes(field), `support mask includes ${field}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
