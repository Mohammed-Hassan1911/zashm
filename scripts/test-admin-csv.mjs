/**
 * Admin CSV export — spreadsheet formula injection regression.
 *
 *   node scripts/test-admin-csv.mjs
 *
 * Customer/order fields are attacker-controlled free text. Excel and Sheets
 * evaluate cells starting with = + - @ (and leading whitespace/tab/CR) even
 * inside quoted CSV. csvSafeCell() must force those values to stay text.
 */
import { csvSafeCell, toCSV } from '../src/components/admin/csvExport.js';

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

console.log('\n[1] dangerous leading characters are neutralised');
{
  eq(csvSafeCell('=1+1'), "'=1+1", 'equals formula is text');
  eq(csvSafeCell('+SUM(A1:A9)'), "'+SUM(A1:A9)", 'plus formula is text');
  eq(csvSafeCell('-cmd|/c calc'), "'-cmd|/c calc", 'minus formula is text');
  eq(csvSafeCell('@SUM(A1:A9)'), "'@SUM(A1:A9)", 'at formula is text');
  eq(csvSafeCell('\t@SUM(A1:A9)'), "'\t@SUM(A1:A9)", 'leading tab is text');
  eq(csvSafeCell('\r=1+1'), "'\r=1+1", 'leading carriage return is text');
  eq(csvSafeCell(' @SUM(A1:A9)'), "' @SUM(A1:A9)", 'leading space is text');
  eq(csvSafeCell(' \t=1+1'), "' \t=1+1", 'mixed leading whitespace is text');
}

console.log('\n[2] ordinary values are unchanged');
{
  eq(csvSafeCell('Cairo'), 'Cairo', 'plain text stays identical');
  eq(csvSafeCell('0112345678'), '0112345678', 'phone number stays identical');
  eq(csvSafeCell('note - 7'), 'note - 7', 'dash inside a value is not a formula');
  eq(csvSafeCell(null), '', 'null becomes an empty cell');
  eq(csvSafeCell(undefined), '', 'undefined becomes an empty cell');
  eq(csvSafeCell(0), '0', 'zero is preserved');
}

console.log('\n[3] CSV quoting and escaping');
{
  const csv = toCSV([
    ['name', 'note'],
    ['=1+1', 'She said "hi"'],
  ]);
  eq(csv, '"name","note"\n"\'=1+1","She said ""hi"""', 'rows are quoted and quotes doubled');
  ok(!/(^|\n)"=/.test(csv), 'no exported cell starts with an unquoted formula');
  ok(csv.indexOf("'") >= 0, 'the apostrophe guard is present in the export');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
