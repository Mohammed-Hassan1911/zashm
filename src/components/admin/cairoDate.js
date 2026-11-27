// Coupon windows are calendar dates in Egypt, never in the admin's browser
// timezone. Compare them against Africa/Cairo so a late-night admin in another
// timezone cannot activate or expire a code a day early.
const CAIRO_TIME_ZONE = 'Africa/Cairo';
const CAIRO_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: CAIRO_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function cairoTodayKey(date = new Date()) {
  const parts = CAIRO_FORMATTER.formatToParts(date);
  const part = (type) => (parts.find((item) => item.type === type) || {}).value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) return '';
  return `${year}-${month}-${day}`;
}

// Whole-day difference: both keys are date-only strings, so UTC parsing is
// intentional here (it is not a timestamp conversion).
export function daysUntilCairoDate(isoDate, todayKey = cairoTodayKey()) {
  const dateKey = String(isoDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !todayKey) return null;
  const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
  const targetMs = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(todayMs) || !Number.isFinite(targetMs)) return null;
  return Math.round((targetMs - todayMs) / 86400000);
}
