// ─── ZASHM admin calendar helpers ───────────────────────────────────────────
// Dates in the admin UI travel to the API as plain `YYYY-MM-DD` strings. These
// helpers parse and format them in local time so a date never shifts by a day
// because of a timezone offset, and they stay dependency-free so the Node test
// suite can import them directly.

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse `YYYY-MM-DD` into a local-midnight Date, or null when invalid. */
export function parseISODate(value) {
  const match = ISO_RE.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  // Reject impossible dates such as 2026-02-31 (which Date would roll over).
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

/** Format a local Date as `YYYY-MM-DD`. */
export function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

/** Human label for the trigger: `15 Nov 2026`. */
export function formatDateLabel(value) {
  const date = parseISODate(value);
  if (!date) return '';
  return `${date.getDate()} ${MONTH_NAMES[date.getMonth()].slice(0, 3)} ${date.getFullYear()}`;
}

/** Long label for screen readers: `Sunday 15 November 2026`. */
export function formatDateLong(value) {
  const date = parseISODate(value);
  if (!date) return '';
  return `${WEEKDAY_LONG[(date.getDay() + 6) % 7]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/** First day of the month containing `date`. */
export function monthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Move whole months, always landing on the 1st so the grid stays stable. */
export function addMonths(date, count) {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

/** Six weeks of days, Monday first, covering the given month. */
export function buildMonthMatrix(year, month, weekStartsOn = 1) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const weeks = [];
  for (let week = 0; week < 6; week += 1) {
    const days = [];
    for (let index = 0; index < 7; index += 1) {
      const dayOffset = week * 7 + index - offset;
      const date = new Date(year, month, 1 + dayOffset);
      days.push({
        date,
        iso: toISODate(date),
        inMonth: date.getMonth() === month && date.getFullYear() === year,
      });
    }
    weeks.push(days);
  }
  return weeks;
}

/** True when `iso` falls outside the allowed window. */
export function isDateDisabled(iso, minDate, maxDate) {
  if (!parseISODate(iso)) return true;
  if (minDate && iso < minDate) return true;
  if (maxDate && iso > maxDate) return true;
  return false;
}

/** Inclusive length of a date range, e.g. 15 → 29 Nov is 15 days. */
export function inclusiveDays(startISO, endISO) {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/** Clamp an ISO date into an allowed window (used when opening the picker). */
export function clampISO(iso, minDate, maxDate) {
  let next = parseISODate(iso) ? iso : todayISO();
  if (minDate && next < minDate) next = minDate;
  if (maxDate && next > maxDate) next = maxDate;
  return next;
}
