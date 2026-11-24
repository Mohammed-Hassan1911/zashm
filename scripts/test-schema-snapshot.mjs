/**
 * Guards the read-only Production/Staging schema snapshot.
 *
 *   node scripts/test-schema-snapshot.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function ok(value, label) {
  if (value) { pass += 1; if (process.env.VERBOSE) console.log(`  ok  ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}`); }
}
function eq(actual, expected, label) { ok(actual === expected, `${label} (got ${String(actual)}, expected ${String(expected)})`); }

const root = new URL('..', import.meta.url);
const sql = readFileSync(new URL('supabase/schema_snapshot_readonly.sql', root), 'utf8');
const doc = readFileSync(new URL('docs/production-staging-schema-comparison.md', root), 'utf8');

console.log('\n[1] the snapshot is read-only');
{
  ok(/^BEGIN READ ONLY;/m.test(sql), 'the snapshot opens a READ ONLY transaction');
  ok(/^ROLLBACK;/m.test(sql), 'the snapshot always rolls back');
  ok(/\bSELECT\b/.test(sql), 'the snapshot reads catalog metadata');
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const forbidden = /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE|VACUUM|REINDEX|CLUSTER|SECURITY LABEL)\b/i;
  ok(!statements.some((s) => forbidden.test(s.replace(/^\s*SET LOCAL\s+search_path[^\n]*/i, ''))),
    'the snapshot contains no data or schema modification');
  ok(!/pg_read_file|pg_sleep|COPY\s+TO|dblink|postgres_fdw/i.test(sql),
    'the snapshot contains no file/network side channels');
}

console.log('\n[2] the snapshot covers the required schema surface');
{
  for (const fn of [
    'atomic_place_order', 'atomic_adjust_stock', 'atomic_delete_order',
    'atomic_set_order_status', 'atomic_edit_order', 'zshm_sellable_stock',
    'zshm_valid_variant_stock', 'zshm_adjust_coupon_usage', 'zshm_guard_coupon_delete',
    'zshm_protect_last_admin', 'zshm_rate_limit', 'products_public',
  ]) ok(sql.includes(fn), `${fn} is checked`);
  for (const relation of [
    'products', 'products_public', 'users', 'orders', 'coupons', 'product_reviews',
  ]) ok(sql.includes(`('${relation}'`), `${relation} is checked`);
  ok(/pg_get_viewdef/.test(sql), 'the products_public definition is captured');
  ok(/pg_policy/.test(sql) && /relrowsecurity/.test(sql), 'RLS policies and flags are captured');
  ok(/aclexplode/.test(sql), 'relation grants are captured');
  ok(/nonzero_reserved_stock/.test(sql) && /negative_reserved_stock/.test(sql),
    'reservedStock invariants are checked without modification');
}

console.log('\n[3] the comparison procedure is explicit');
{
  ok(/STAGING_READONLY_URL/.test(doc) && /PRODUCTION_READONLY_URL/.test(doc),
    'the doc requires separate read-only connections');
  ok(/diff -u/.test(doc), 'the doc provides a deterministic diff command');
  ok(/Prepared only/.test(doc) && /No Production SQL\s+was executed/.test(doc),
    'the doc records that Production was not touched');
  ok(/Expected differences/.test(doc) && /not.*acceptable/i.test(doc),
    'the doc separates expected fixture/data differences from schema blockers');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
