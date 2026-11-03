/**
 * Stock edge-case static checks for the hardened order path.
 *
 *   node scripts/test-stock-edge-cases.mjs
 *
 * Verifies (read-only) that api/orders.js and atomic_place_order.sql enforce:
 *   - active must be strictly true (NULL treated as inactive)
 *   - no 99 fallback for NULL stock (treated as 0)
 *   - finite/non-negative stock validation
 *   - variant validation (no phantom variants)
 *   - salePrice = 0 preserved
 *   - atomic_adjust_stock consistency (0 default, unchanged policy)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}`); }
}

const ordersSrc = read('api/orders.js');
const rpcSrc = read('supabase/atomic_place_order.sql');
const adjustSrc = read('supabase/atomic_place_order.sql');

console.log('\n[1] api/orders.js hardened checks');
ok(/p\.active !== true/.test(ordersSrc), 'active requires strictly true (NULL rejected)');
ok(!/let stockAmount = 99/.test(ordersSrc), 'no 99 fallback default');
ok(/let stockAmount = 0/.test(ordersSrc), 'default stock is 0');
ok(/Number\.isFinite/.test(ordersSrc), 'finite stock/price checks present');
ok(/hasSizesOrColors && !hasVariantStock/.test(ordersSrc), 'phantom variants rejected');
ok(/Object\.prototype\.hasOwnProperty\.call\(pv, variantKey\)/.test(ordersSrc), 'unknown variant key rejected');
ok(/rawSale !== null && rawSale !== undefined/.test(ordersSrc), 'salePrice = 0 preserved (null check)');
ok(/unitPrice < 0/.test(ordersSrc), 'negative price rejected');

console.log('\n[2] atomic_place_order.sql hardened checks');
ok(/v_prod\.active IS NOT TRUE/.test(rpcSrc), 'SQL active check uses IS NOT TRUE');
ok(!/COALESCE\(v_prod\.stock, 99\)/.test(rpcSrc), 'no 99 fallback in availability');
ok(/COALESCE\(v_prod\.stock, 0\)/.test(rpcSrc), 'SQL default stock is 0');
ok(/COALESCE\(v_prod\.stock, 0\) - v_total_qty/.test(rpcSrc), 'SQL decrement uses 0 default');
ok(/invalid_product_config/.test(rpcSrc), 'phantom-variant products rejected in SQL');
ok(rpcSrc.includes("~ '^-?[0-9]+$'"), 'safe numeric cast for variant stock');

console.log('\n[3] atomic_adjust_stock consistency');
ok(/COALESCE\(stock, 0\)/.test(adjustSrc), 'adjust uses 0 default (consistent)');
ok(/COALESCE\(v_prod\.stock, 0\)/.test(adjustSrc), 'adjust preflight uses 0 default');
ok(!/COALESCE\(.*99\)/.test(adjustSrc), 'adjust has no 99 fallback');

console.log('\n[4] migration file present');
const mig = read('supabase/stock_hardening_constraints.sql');
ok(/ADD CONSTRAINT products_stock_nonnegative/.test(mig), 'migration has stock CHECK');
ok(/ALTER COLUMN active SET NOT NULL/.test(mig), 'migration has active NOT NULL');
ok(/-- .*UPDATE public.products/.test(mig), 'migration includes cleanup (commented)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
