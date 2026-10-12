/**
 * Pure-function tests for src/lib/analytics.js (no deps, no React).
 * Runs the source in a VM so Node treats it as ESM regardless of the
 * CRA package.json ("type" is unset).
 *
 *   node scripts/test-analytics.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/lib/analytics.js', import.meta.url), 'utf8');
const exportsOut = {};
const names = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
const constNames = [...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
const code = src
  .replace(/^export const /gm, '')
  .replace(/^export function (\w+)/gm, 'function $1')
  + '\n' + [...names, ...constNames].map((n) => `module.exports.${n} = ${n};`).join('\n');
vm.runInNewContext('(function(module){ ' + code + ' })(moduleCtx)', { moduleCtx: { exports: exportsOut } });
const A = exportsOut;

const CAIRO = { timeZone: 'Africa/Cairo' };
const NOW = '2026-10-11T12:00:00';
const cairoToday = (d) => {
  const parts = new Intl.DateTimeFormat('en-CA', { ...CAIRO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const today = cairoToday(new Date(NOW)); // 2026-10-11
const realToday = cairoToday(new Date());

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; if (process.env.VERBOSE) console.log(`  ok  ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}

const order = (over) => ({ status: 'Pending', total: 0, date: today, ...over });

function overview(orders, rangeKey = '7d') { return A.computeSalesOverview(orders, rangeKey, new Date(NOW)); }

console.log('\n[1] empty store');
{
  const o = overview([]);
  eq(o.orderCount, 0, 'orderCount 0');
  eq(o.totalValue, 0, 'totalValue 0');
  eq(o.deliveredSales, 0, 'deliveredSales 0');
  eq(o.pendingValue, 0, 'pendingValue 0');
  eq(o.shippedValue, 0, 'shippedValue 0');
  eq(o.cancelledValue, 0, 'cancelledValue 0');
  eq(o.aov, 0, 'aov never divides by zero (0)');
  eq(o.series.length, 7, '7 empty series points');
  eq(o.series.every((p) => p.value === 0 && p.orders === 0), true, 'all series points empty');
}

console.log('\n[2] only pending orders (never a delivered)');
{
  const o = overview([order({ total: 509 })]);
  eq(o.totalValue, 509, 'total value includes pending');
  eq(o.deliveredSales, 0, 'delivered sales 0 for pending-only store');
  eq(o.pendingValue, 509, 'pending value 509');
  eq(o.pendingCount, 1, 'pending count 1');
  const day = o.series.find((p) => p.key === today);
  eq(day.value, 509, 'today series value = 509');
  eq(day.orders, 1, 'today series orders = 1');
  eq(o.totalDeltaPct, null, 'no meaningless % when prev == 0');
}

console.log('\n[3] shipped but no delivered');
{
  const o = overview([order({ status: 'Shipped', total: 300 })]);
  eq(o.shippedValue, 300, 'shipped value 300');
  eq(o.shippedCount, 1, 'shipped count 1');
  eq(o.deliveredSales, 0, 'delivered still 0');
  eq(o.pendingValue, 0, 'shipped not counted as pending');
}

console.log('\n[4] delivered + cancelled never mix');
{
  const o = overview([
    order({ status: 'Delivered', total: 100 }),
    order({ status: 'Delivered', total: 400 }),
    order({ status: 'Cancelled', total: 999 }),
  ]);
  eq(o.deliveredSales, 500, 'delivered sales 500');
  eq(o.deliveredCount, 2, 'delivered count 2');
  eq(o.totalValue, 500, 'total value excludes cancelled');
  eq(o.cancelledCount, 1, 'cancelled count 1');
  eq(o.cancelledValue, 999, 'cancelled value reported separately');
  eq(o.aov, 250, 'aov over eligible (non-cancelled) orders');
}

console.log('\n[5] multiple orders same day sum once');
{
  const o = overview([
    order({ total: 100 }),
    order({ total: 200 }),
    order({ status: 'Delivered', total: 300 }),
  ]);
  eq(o.orderCount, 3, '3 orders');
  eq(o.totalValue, 600, '600 total');
  eq(o.series.find((p) => p.key === today).orders, 3, 'day orders = 3 (no duplicates)');
}

console.log('\n[6] Egypt midnight / boundary handling');
{
  const isoLateNight = new Date('2026-10-10T23:59:00+03:00').toISOString();
  const isoTopOfDay = new Date('2026-10-11T00:30:00+03:00').toISOString();
  eq(A.orderDateKey({ timestamps: { created: isoTopOfDay } }), '2026-10-11', '00:30 Cairo ISO → 10-11');
  eq(A.orderDateKey({ timestamps: { created: isoLateNight } }), '2026-10-10', '23:59 Cairo ISO → 10-10');

  const o = overview([
    order({ date: '2026-10-10', total: 50 }), // yesterday (Egypt wall date)
    order({ total: 100 }),                    // today
  ]);
  const series = o.series;
  eq(series.find((p) => p.key === '2026-10-10').value, 50, 'yesterday bucket holds 50');
  eq(series.find((p) => p.key === today).value, 100, 'today bucket holds 100');

  const todayRange = overview([order({ date: '2026-10-10', total: 50 }), order({ total: 100 })], 'today');
  eq(todayRange.totalValue, 100, "'today' excludes yesterday");
  eq(todayRange.prevTotalValue, 50, "'today' previous = yesterday");
  eq(todayRange.totalDeltaPct, 100, 'delta 100% (100 vs 50)');
}

console.log('\n[7] range boundaries (30d / month / all)');
{
  const farOld = order({ date: '2026-08-01', total: 10 });      // 30d-30+
  const old30d = order({ date: '2026-09-12', total: 20 });      // today-29 (2026-09-12)
  const start30d = order({ date: '2026-09-12', total: 0 });
  const inPrevStop = order({ date: '2026-10-01', total: 300 }); // within prev for 7d? no (Oct2..Oct8 only)
  const monthFirst = order({ date: '2026-10-01', total: 7 });
  const prevMonthEnd = order({ date: '2026-09-30', total: 90 });
  const prevMonthStart = order({ date: '2026-09-01', total: 5 });

  const o30 = overview([farOld, old30d, inPrevStop, monthFirst], '30d');
  eq(o30.totalValue, 327, '30d includes day-29 back and month orders; excludes day-30+');

  const om = overview([monthFirst, prevMonthEnd, prevMonthStart], 'month');
  eq(om.totalValue, 7, 'month includes only this calendar month');
  eq(om.prevTotalValue, 95, 'previous month = 90 + 5');

  const oa = overview([order({ date: '2026-09-01', total: 5 }), monthFirst, prevMonthEnd], 'all');
  eq(oa.totalValue, 102, 'all-time includes every non-cancelled order');
  eq(oa.series.length, 2, 'all-time grouped into 2 months');
  eq(oa.prevTotalValue, null, 'all-time has no previous period');
}

console.log('\n[8] missing / invalid timestamps');
{
  eq(A.orderDateKey({}), realToday, 'no date fields → falls back to today');
  eq(A.orderDateKey({ date: '' }), realToday, "empty-string date → today (not epoch)");
  eq(A.orderDateKey({ date: 'not-a-date' }), realToday, 'garbage date → today');
  eq(A.orderDateKey({ timestamps: { created: '2026-10-01T10:00:00Z' } }), '2026-10-01', 'ISO created in Cairo');
  eq(A.orderDateKey(order({ date: '2026-10-05' })), '2026-10-05', 'wall-date passthrough');
}

console.log('\n[9] malformed totals');
{
  const o = overview([
    order({ total: -100 }),
    order({ total: 'not-a-number' }),
    order({ total: '50' }),
    order({ status: 'Delivered', total: 0 }),
    order({ total: undefined }),
  ]);
  eq(o.totalValue, 50, 'negative + NaN + undefined → 0; string 50 stays 50');
  eq(o.deliveredSales, 0, 'delivered 0 record is 0');
}

console.log('\n[10] inventory classification');
{
  const mk = (stock, name) => ({ id: stock, name, stock });
  const r = A.classifyInventory([mk(0, 'A'), mk(2, 'B'), mk(6, 'C'), mk(-1, 'D'), mk(5, 'E')]);
  eq(r.outOfStock.map((p) => p.name), ['A', 'D'], 'negative & zero are out of stock');
  eq(r.lowStock.map((p) => p.name), ['B', 'E'], '<=5 and >0 are low stock');
  eq(A.classifyInventory().outOfStock.length, 0, 'empty inventory → no alerts');
}

console.log('\n[11] formatting');
{
  eq(A.fmtEGP(509), 'EGP 509', 'fmtEGP basic');
  eq(A.fmtEGP(1234567.89), 'EGP 1,234,568', 'fmtEGP rounding + thousands');
  eq(A.fmtEGPAr(509), `509 ج.م`, 'fmtEGPAr');
  eq(A.compactEGP(0), '0', 'compact zero');
  eq(A.compactEGP(1234), '1.2K', 'compact thousands');
}

console.log('\n[12] legacy computeLast7Days (timezone fixed)');
{
  const res = A.computeLast7Days([order({ date: '2026-10-10', total: 80 }), order({ total: 20 })]);
  eq(res.find((p) => p.day === 'Sun' && p.revenue === 0 && p.orders === 1) ? true : false, true, 'yesterday slot present with 1 order');
  eq(res.find((p) => p.revenue > 0 || p.orders > 0) !== undefined, true, 'data present (was previously misleading)');
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail > 0) process.exit(1);