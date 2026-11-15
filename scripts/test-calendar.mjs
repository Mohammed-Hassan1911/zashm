// Regression coverage for the branded admin date field used by the discount
// start/end window. Plain Node, no dependencies: the calendar maths is pure,
// and the wiring checks read the component and the stylesheet as text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MONTH_NAMES,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  addMonths,
  buildMonthMatrix,
  clampISO,
  formatDateLabel,
  formatDateLong,
  inclusiveDays,
  isDateDisabled,
  monthStart,
  parseISODate,
  toISODate,
  todayISO,
} from '../src/lib/calendar.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (file) => readFileSync(path.join(root, file), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function ok(value, label, detail = '') {
  if (value) {
    passed += 1;
    console.log(`  PASS ${label}`);
    return;
  }
  failed += 1;
  failures.push(label);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function section(name) {
  console.log(`\n[${name}]`);
}

// ─── [1] ISO parsing stays in local time ─────────────────────────────────────
section('1 — parsing and formatting');

const parsed = parseISODate('2026-11-15');
ok(parsed instanceof Date, 'a valid ISO date parses');
eq(parsed.getFullYear(), 2026, 'the year is local');
eq(parsed.getMonth(), 10, 'the month is local (November)');
eq(parsed.getDate(), 15, 'the day is local');
eq(parsed.getHours(), 0, 'parsing lands at local midnight');
eq(toISODate(parsed), '2026-11-15', 'the ISO value round-trips');
eq(parseISODate('2026-02-31'), null, 'impossible dates are rejected, not rolled over');
eq(parseISODate('2026-13-01'), null, 'an out-of-range month is rejected');
eq(parseISODate('15/11/2026'), null, 'other formats are rejected');
eq(parseISODate(''), null, 'an empty value parses to null');
eq(parseISODate(null), null, 'null is tolerated');
eq(toISODate(new Date(2026, 0, 2)), '2026-01-02', 'single digits are padded');
eq(toISODate(new Date('nope')), '', 'an invalid Date formats to empty');
eq(todayISO(new Date(2026, 0, 2, 23, 59)), '2026-01-02', 'today is local, not UTC');
eq(formatDateLabel('2026-11-15'), '15 Nov 2026', 'the trigger shows a short readable label');
eq(formatDateLabel(''), '', 'an empty value has no label');
eq(formatDateLong('2026-11-15'), 'Sunday 15 November 2026', 'screen readers get the full label');
eq(formatDateLong('2026-11-16'), 'Monday 16 November 2026', 'weekday names are correct');
eq(MONTH_NAMES.length, 12, 'all twelve months are named');
eq(WEEKDAY_SHORT[0], 'Mon', 'the grid is Monday-first');
eq(WEEKDAY_LONG[6], 'Sunday', 'the long weekday list ends on Sunday');

// ─── [2] month grids ────────────────────────────────────────────────────────
section('2 — month grids');

const november = buildMonthMatrix(2026, 10);
eq(november.length, 6, 'six weeks are always rendered');
ok(november.every((week) => week.length === 7), 'every week has seven days');
eq(november[0][0].iso, '2026-10-26', 'the grid starts on the Monday before the 1st');
eq(november[0][0].inMonth, false, 'leading days are marked outside the month');
eq(november[5][6].iso, '2026-12-06', 'the grid ends six weeks later');
eq(november.flat().filter((cell) => cell.inMonth).length, 30, 'November contributes 30 days');
ok(november.flat().every((cell) => /^\d{4}-\d{2}-\d{2}$/.test(cell.iso)), 'every cell carries an ISO value');

const february = buildMonthMatrix(2028, 1);
eq(february.flat().filter((cell) => cell.inMonth).length, 29, 'a leap February contributes 29 days');

const sundayFirst = buildMonthMatrix(2026, 10, 0);
eq(sundayFirst[0][0].iso, '2026-11-01', 'a Sunday-first grid starts on the Sunday 1st');
eq(sundayFirst[0][0].date.getDay(), 0, 'the first column is Sunday');

eq(toISODate(addMonths(new Date(2026, 11, 15), 1)), '2027-01-01', 'addMonths crosses the year boundary');
eq(toISODate(addMonths(new Date(2026, 0, 31), -1)), '2025-12-01', 'addMonths lands on the 1st');
eq(toISODate(monthStart(new Date(2026, 10, 15))), '2026-11-01', 'monthStart resets the day');

// ─── [3] allowed window and range length ────────────────────────────────────
section('3 — allowed window and range length');

ok(isDateDisabled('', '', ''), 'an empty date is disabled');
ok(isDateDisabled('2026-11-14', '2026-11-15', ''), 'a day before the minimum is disabled');
ok(!isDateDisabled('2026-11-15', '2026-11-15', ''), 'the minimum itself is selectable');
ok(isDateDisabled('2026-11-16', '2026-11-15', '2026-11-15'), 'a day after the maximum is disabled');
ok(!isDateDisabled('2026-11-20', '2026-11-15', '2026-11-30'), 'a day inside the window is selectable');
ok(isDateDisabled('2026-11-15', '2026-11-20', '2026-11-10'), 'an inverted window disables everything');

eq(inclusiveDays('2026-11-15', '2026-11-15'), 1, 'a one-day window counts as one day');
eq(inclusiveDays('2026-11-15', '2026-11-29'), 15, 'a two-week window counts both ends');
eq(inclusiveDays('2026-11-29', '2026-12-02'), 4, 'a range can cross the month boundary');
eq(inclusiveDays('', '2026-11-29'), 0, 'an incomplete range has no length');
eq(inclusiveDays('2026-11-15', ''), 0, 'a missing end has no length');

// Date-independent: an empty value falls back to today, then clamps into the
// window. Using a window far in the future keeps the assertion true on any day.
eq(clampISO('', '2099-01-01', '2099-12-31'), '2099-01-01', 'an empty value clamps to the minimum');
eq(clampISO('', '', ''), todayISO(), 'an empty value without a window falls back to today');
eq(clampISO('2026-10-01', '2026-11-15', '2026-12-31'), '2026-11-15', 'a value below the window clamps up');
eq(clampISO('2027-01-01', '2026-11-15', '2026-12-31'), '2026-12-31', 'a value above the window clamps down');
eq(clampISO('2026-11-20', '2026-11-15', '2026-12-31'), '2026-11-20', 'a value inside the window is untouched');

// ─── [4] the field is a real, branded dialog ────────────────────────────────
section('4 — date field component');

const field = read('src/components/admin/DateField.js');
ok(field.includes("from '../../lib/calendar'"), 'the field uses the tested helpers');
ok(field.includes('role="dialog"'), 'the calendar is a dialog');
ok(field.includes('aria-label={`Choose ${ariaLabel.toLowerCase()}`}'), 'the dialog is named');
ok(field.includes('aria-haspopup="dialog"') && field.includes('aria-expanded={open}'),
  'the trigger exposes the popup state');
ok(field.includes('aria-controls={open ? popoverId : undefined}'), 'the trigger points at the popover');
ok(field.includes('role="grid"') && field.includes('role="row"') && field.includes('role="gridcell"'),
  'the calendar exposes the full grid pattern');
ok(field.includes('aria-selected={cell.iso === value}'), 'the selected day is announced');
ok(field.includes("aria-current={cell.iso === today ? 'date' : undefined}"), 'today is marked');
ok(field.includes('disabled={disabled}'), 'out-of-window days are disabled');
ok(field.includes("case 'ArrowLeft'") && field.includes("case 'ArrowRight'") &&
   field.includes("case 'ArrowUp'") && field.includes("case 'ArrowDown'"),
  'arrow keys move by day and week');
ok(field.includes("case 'Home'") && field.includes("case 'End'"), 'Home/End move within the week');
ok(field.includes("case 'PageUp'") && field.includes("case 'PageDown'") && field.includes('shiftKey'),
  'PageUp/PageDown move by month (Shift by year)');
ok(field.includes("case 'Escape'"), 'Escape closes the calendar');
ok(field.includes('aria-label="Previous month"') && field.includes('aria-label="Next month"'),
  'month arrows are named');
ok(field.includes('className="sr-only" aria-live="polite"'), 'month changes are announced');
ok(/>\s*Today\s*</.test(field) && />\s*Clear\s*</.test(field), 'Today and Clear shortcuts exist');
ok(field.includes('onChange?.(\'\')'), 'Clear empties the value');
ok(field.includes('close(true)') && field.includes('triggerRef.current?.focus()'),
  'closing returns focus to the field');
ok(field.includes("document.addEventListener('pointerdown'"), 'clicking outside closes it');
ok(field.includes("window.addEventListener('resize'"), 'resizing closes it');
ok(field.includes('const rangeActive = Boolean(rangeStart && rangeEnd && rangeStart < rangeEnd)'),
  'the range highlight needs both ends');
ok(field.includes("classes.push('is-between')"), 'the days between the ends are tinted');
ok(field.includes('POPOVER_ESTIMATE'), 'the popover flips when there is no room below');
// The doc comment mentions the native input it replaces; only real JSX counts.
const fieldCode = field.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(!/<input/.test(fieldCode), 'the field draws its own calendar instead of a native input');

// ─── [5] the discount form wiring ───────────────────────────────────────────
section('5 — discount form wiring');

const admin = read('src/pages/AdminApp.js');
ok(admin.includes("import DateField from '../components/admin/DateField'"), 'the admin imports the field');
ok(!/<input type="date"/.test(admin), 'no native date input is left in the admin');
ok(admin.includes('className="admin-date-range"'), 'the two fields share a responsive row');
ok(admin.includes('minDate={form.startDate}'), 'the end date cannot precede the start');
ok(admin.includes('rangeStart={form.startDate}') && admin.includes('rangeEnd={form.endDate}'),
  'both fields know the range for the tint');
ok(admin.includes('align="right"'), 'the end calendar aligns to the right edge');
ok(admin.includes('className="admin-date-hint is-error"') && admin.includes('role="alert"'),
  'an inverted range is reported inline');
ok(admin.includes('inclusiveDays(form.startDate, form.endDate)'), 'the form shows the window length');
ok(admin.includes('formatDateLabel(form.startDate)'), 'the form repeats the chosen dates');
ok(admin.includes('startDate: form.startDate') && admin.includes('endDate: form.endDate'),
  'the API still receives YYYY-MM-DD strings');
ok(!/toISOString/.test(field), 'the field never converts a date through UTC');

// ─── [6] the calendar is styled by the brand ────────────────────────────────
section('6 — brand styling');

const css = read('src/index.css');
ok(css.includes('.zshm-date-trigger') && css.includes('min-height: 44px'), 'the trigger is touch sized');
ok(css.includes('.zshm-date-pop') && css.includes('border: 1px solid rgba(201, 168, 76, 0.34)'),
  'the popover uses a gold hairline');
ok(css.includes('font-family: var(--font-display)'), 'the month title uses the display serif');
ok(css.includes('.zshm-date-day.is-selected') && css.includes('background: var(--gold)'),
  'the selected day is gold');
ok(css.includes('.zshm-date-day.is-between'), 'the range tint is styled');
ok(css.includes('.zshm-date-day.is-today'), 'today is outlined');
ok(css.includes('.zshm-date-day:disabled'), 'disabled days look disabled');
ok(css.includes('.zshm-date-day:focus-visible'), 'days have a visible focus ring');
ok(css.includes('@media (max-width: 380px)') && css.includes('.admin-date-range { grid-template-columns: 1fr; }'),
  'the fields stack on very small screens');
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.zshm-date-pop \{\s*animation: none;/.test(css),
  'reduced motion is honoured');
ok(css.includes('.admin-date-hint .admin-date-days'), 'the window length is highlighted in gold');

// ─── [7] no new dependency ──────────────────────────────────────────────────
section('7 — no new dependency');

const pkg = JSON.parse(read('package.json'));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
ok(!deps['react-day-picker'] && !deps['date-fns'] && !deps['flatpickr'] && !deps['react-datepicker'],
  'the calendar is hand-built, not a new package');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
