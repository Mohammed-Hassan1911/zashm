// Spreadsheet formula injection: a cell beginning with one of these characters
// is interpreted as a formula by Excel/Sheets even inside quoted CSV. Prefixing
// an apostrophe keeps the visible text identical and forces it to stay text.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvSafeCell(value) {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  return FORMULA_PREFIX.test(raw) || FORMULA_PREFIX.test(trimmed) ? `'${raw}` : raw;
}

export function toCSV(rows) {
  return rows
    .map((row) => row.map((cell) => `"${csvSafeCell(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
}
