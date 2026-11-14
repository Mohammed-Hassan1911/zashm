import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  MONTH_NAMES,
  WEEKDAY_SHORT,
  addMonths,
  buildMonthMatrix,
  clampISO,
  formatDateLabel,
  formatDateLong,
  isDateDisabled,
  monthStart,
  parseISODate,
  toISODate,
  todayISO,
} from '../../lib/calendar';

const POPOVER_ESTIMATE = 372;

/**
 * Brand date field for the admin discount drawer.
 *
 * The native `<input type="date">` renders an operating-system calendar that
 * ignores the ZASHM palette and differs on every browser. This keeps the same
 * `YYYY-MM-DD` value contract but draws the calendar itself: dark surface, gold
 * hairlines, Cormorant month title, Monday-first grid, today/selected/range
 * states, keyboard navigation and a clear path back to the field.
 */
export default function DateField({
  value = '',
  onChange,
  ariaLabel = 'Date',
  placeholder = 'Select date',
  minDate = '',
  maxDate = '',
  rangeStart = '',
  rangeEnd = '',
  align = 'left',
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const popoverId = `zshm-date-pop-${uid}`;
  const monthLabelId = `zshm-date-month-${uid}`;

  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);

  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const [view, setView] = useState(() => monthStart(parseISODate(value) || new Date()));
  const [focusISO, setFocusISO] = useState(() => clampISO(value, minDate, maxDate));

  const weeks = useMemo(() => buildMonthMatrix(view.getFullYear(), view.getMonth()), [view]);
  const today = todayISO();
  const rangeActive = Boolean(rangeStart && rangeEnd && rangeStart < rangeEnd);

  const close = (refocus) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const openPicker = () => {
    const startISO = clampISO(value || today, minDate, maxDate);
    const startDate = parseISODate(startISO) || new Date();
    setView(monthStart(startDate));
    setFocusISO(startISO);
    const rect = triggerRef.current?.getBoundingClientRect();
    const spaceBelow = rect ? window.innerHeight - rect.bottom : POPOVER_ESTIMATE;
    setOpenUp(Boolean(rect) && spaceBelow < POPOVER_ESTIMATE && rect.top > POPOVER_ESTIMATE);
    setOpen(true);
  };

  // Focus the active day once the grid exists, and keep focus on the day the
  // arrow keys moved to.
  useEffect(() => {
    if (!open) return;
    const node = popRef.current?.querySelector(`[data-iso="${focusISO}"]`);
    if (node && document.activeElement !== node) node.focus({ preventScroll: true });
  }, [open, focusISO, view]);

  // Clicking outside or resizing closes the popover; Escape and Tab-out are
  // handled on the wrapper so focus goes back to the field.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const select = (iso) => {
    if (isDateDisabled(iso, minDate, maxDate)) return;
    onChange?.(iso);
    close(true);
  };

  const findEnabled = (startDate, step) => {
    let cursor = startDate;
    for (let i = 0; i < 400; i += 1) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + step);
      const iso = toISODate(cursor);
      if (!isDateDisabled(iso, minDate, maxDate)) return cursor;
    }
    return null;
  };

  const moveTo = (date) => {
    if (!date) return;
    setView(monthStart(date));
    setFocusISO(toISODate(date));
  };

  // Month arrows keep a usable tab stop inside the grid: the same day in the
  // new month (clamped to its length and to the allowed window).
  const goMonth = (delta) => {
    const nextView = addMonths(view, delta);
    const daysInMonth = new Date(nextView.getFullYear(), nextView.getMonth() + 1, 0).getDate();
    const anchor = parseISODate(focusISO) || parseISODate(value) || new Date();
    const candidate = new Date(
      nextView.getFullYear(),
      nextView.getMonth(),
      Math.min(anchor.getDate(), daysInMonth),
    );
    setView(nextView);
    setFocusISO(clampISO(toISODate(candidate), minDate, maxDate));
  };

  const baseDate = () => parseISODate(focusISO) || parseISODate(value) || new Date();

  const onGridKeyDown = (event) => {
    const date = baseDate();
    const offset = (date.getDay() + 6) % 7; // Monday = 0
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        moveTo(findEnabled(date, -1));
        break;
      case 'ArrowRight':
        event.preventDefault();
        moveTo(findEnabled(date, 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(findEnabled(date, -7));
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveTo(findEnabled(date, 7));
        break;
      case 'Home':
        event.preventDefault();
        moveTo(findEnabled(new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset - 1), 1));
        break;
      case 'End':
        event.preventDefault();
        moveTo(findEnabled(new Date(date.getFullYear(), date.getMonth(), date.getDate() + (6 - offset) - 1), 1));
        break;
      case 'PageUp':
      case 'PageDown': {
        event.preventDefault();
        const direction = event.key === 'PageUp' ? -1 : 1;
        const months = event.shiftKey ? 12 : 1;
        const targetMonth = addMonths(monthStart(date), direction * months);
        const daysInTarget = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
        const target = new Date(
          targetMonth.getFullYear(),
          targetMonth.getMonth(),
          Math.min(date.getDate(), daysInTarget),
        );
        const clamped = clampISO(toISODate(target), minDate, maxDate);
        moveTo(parseISODate(clamped));
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      default:
        break;
    }
  };

  const onWrapperBlur = (event) => {
    if (!open) return;
    const next = event.relatedTarget;
    if (next && !wrapperRef.current?.contains(next)) setOpen(false);
  };

  const dayClass = (cell) => {
    const classes = ['zshm-date-day'];
    if (!cell.inMonth) classes.push('is-outside');
    if (cell.iso === today) classes.push('is-today');
    if (cell.iso === value) classes.push('is-selected');
    else if (rangeActive && cell.iso === rangeStart) classes.push('is-edge');
    else if (rangeActive && cell.iso === rangeEnd) classes.push('is-edge');
    if (rangeActive && cell.iso > rangeStart && cell.iso < rangeEnd) classes.push('is-between');
    if (isDateDisabled(cell.iso, minDate, maxDate)) classes.push('is-disabled');
    return classes.join(' ');
  };

  const monthTitle = `${MONTH_NAMES[view.getMonth()]} ${view.getFullYear()}`;

  return (
    <div
      ref={wrapperRef}
      className="zshm-date"
      onBlur={onWrapperBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="zshm-date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${ariaLabel}: ${value ? formatDateLabel(value) : 'not set'}`}
        onClick={() => (open ? close(true) : openPicker())}
      >
        <CalendarDays size={14} className="zshm-date-icon" aria-hidden="true" />
        <span className={value ? 'zshm-date-value' : 'zshm-date-placeholder'}>
          {value ? formatDateLabel(value) : placeholder}
        </span>
        <ChevronDown size={12} className="zshm-date-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popRef}
          id={popoverId}
          role="dialog"
          aria-label={`Choose ${ariaLabel.toLowerCase()}`}
          className={`zshm-date-pop ${openUp ? 'is-up' : 'is-down'} ${align === 'right' ? 'is-right' : 'is-left'}`}
        >
          <div className="zshm-date-head">
            <button
              type="button"
              className="zshm-date-nav"
              aria-label="Previous month"
              onClick={() => goMonth(-1)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span className="zshm-date-title" id={monthLabelId}>
              <span className="zshm-date-month">{MONTH_NAMES[view.getMonth()]}</span>
              <span className="zshm-date-year">{view.getFullYear()}</span>
            </span>
            <button
              type="button"
              className="zshm-date-nav"
              aria-label="Next month"
              onClick={() => goMonth(1)}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="zshm-date-weekdays" aria-hidden="true">
            {WEEKDAY_SHORT.map((day) => (
              <span key={day}>{day.slice(0, 1)}</span>
            ))}
          </div>

          <div
            role="grid"
            aria-labelledby={monthLabelId}
            className="zshm-date-grid"
            onKeyDown={onGridKeyDown}
          >
            {weeks.map((week) => (
              <div role="row" className="zshm-date-week" key={week[0].iso}>
                {week.map((cell) => {
                  const disabled = isDateDisabled(cell.iso, minDate, maxDate);
                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      role="gridcell"
                      data-iso={cell.iso}
                      tabIndex={cell.iso === focusISO ? 0 : -1}
                      aria-selected={cell.iso === value}
                      aria-current={cell.iso === today ? 'date' : undefined}
                      aria-label={formatDateLong(cell.iso)}
                      disabled={disabled}
                      className={dayClass(cell)}
                      onClick={() => select(cell.iso)}
                    >
                      {cell.date.getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="zshm-date-foot">
            <button
              type="button"
              className="zshm-date-shortcut is-primary"
              disabled={isDateDisabled(today, minDate, maxDate)}
              onClick={() => select(today)}
            >
              Today
            </button>
            {value ? (
              <button
                type="button"
                className="zshm-date-shortcut"
                onClick={() => { onChange?.(''); close(true); }}
              >
                Clear
              </button>
            ) : (
              <span className="zshm-date-foot-note">Mon – Sun</span>
            )}
          </div>

          <span className="sr-only" aria-live="polite">{monthTitle}</span>
        </div>
      )}
    </div>
  );
}
