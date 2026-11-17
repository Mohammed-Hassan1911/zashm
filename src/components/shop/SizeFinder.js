import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Ruler,
  Sparkles,
  X,
} from 'lucide-react';
import {
  BODY_LIMITS,
  BOTTOM_WAIST_SHAPES,
  CHEST_SHAPES,
  GARMENT,
  SEAT_SHAPES,
  WAIST_SHAPES,
  fitOptionsFor,
  garmentKind,
  loadFitProfile,
  normalizeFit,
  sanitizeBodyShape,
  saveFitProfile,
  scoreSizes,
  supportsSizeGuidance,
} from '../../lib/fit';

const FIT_LABELS = {
  slim: 'Slim',
  regular: 'Regular',
  relaxed: 'Relaxed',
  oversized: 'Oversized',
  wide: 'Wide leg',
};

const FIT_HINTS = {
  slim: 'Close to the body',
  regular: 'Classic and easy',
  relaxed: 'Roomy through the body',
  oversized: 'Loose and dropped',
};

const CHEST_LABELS = {
  slimmer: 'Slimmer',
  average: 'Average',
  broader: 'Broader',
};

const WAIST_LABELS = {
  flatter: 'Flatter',
  average: 'Average',
  rounder: 'Rounder',
};

const CHEST_HINTS = {
  slimmer: 'Narrow through the chest',
  average: 'Proportional',
  broader: 'Fuller through the chest',
};

const WAIST_HINTS = {
  flatter: 'Straight through the middle',
  average: 'Proportional',
  rounder: 'Fuller at the waist',
};

// Trousers are sized from the waistband and the seat, so the two shape
// questions describe those instead of the chest. Same three answers, different
// wording: "slimmer/wider" reads as circumference, which is what a waistband is.
const BOTTOM_WAIST_LABELS = {
  slimmer: 'Slimmer',
  average: 'Average',
  wider: 'Wider',
};

const BOTTOM_WAIST_HINTS = {
  slimmer: 'Narrow waistband',
  average: 'Proportional',
  wider: 'Fuller waistband',
};

const SEAT_LABELS = {
  narrow: 'Narrow',
  average: 'Average',
  wider: 'Wider',
};

const SEAT_HINTS = {
  narrow: 'Straight through the seat',
  average: 'Proportional',
  wider: 'Fuller through the seat',
};

const FIT_HINTS_BOTTOM = {
  slim: 'Close to the leg',
  regular: 'Classic and easy',
  relaxed: 'Roomy through the leg',
  wide: 'Wide from hip to hem',
};

// How the answers bend the drawing. Width only: height comes from the numbers.
const CHEST_WIDTH = { slimmer: 0.88, average: 1, broader: 1.12 };
const WAIST_WIDTH = { flatter: 0.9, average: 1, rounder: 1.11, slimmer: 0.92, wider: 1.1 };
const SEAT_WIDTH = { narrow: 0.93, average: 1, wider: 1.1 };

// Height/weight, chest, waist, fit — then the result. Keeping the result off the
// question count means "Step 4 of 4" stays honest while the last panel is a
// normal choice page with a normal Next button.
const QUESTION_COUNT = 4;
const RESULT_STEP = QUESTION_COUNT;

// Score bands, so the number also reads as a sentence. The thresholds follow
// the scoring model: 88+ means the shopper sits near the middle of the size's
// own window, 52–71 means the window covers them but close to an edge. When the
// engine had to step away from the best-fitting size because it is sold out,
// the band says so instead of calling a deliberately chosen size a rough guess.
function scoreBand(score, swapped = false) {
  if (swapped) return { label: 'Best available in this colour', color: 'var(--gold)' };
  if (score >= 88) return { label: 'Excellent match', color: '#8fe0b0' };
  if (score >= 72) return { label: 'Strong match', color: 'var(--gold)' };
  if (score >= 52) return { label: 'Likely fit', color: 'var(--gold)' };
  return { label: 'Rough estimate', color: 'var(--text3)' };
}

function readStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The live body drawing.
 *
 * Height and weight scale the whole figure (taller, wider); the shape answers
 * reshape the garment itself, so the extra questions are visible rather than
 * abstract. A top draws a torso and rings the chest or the waist; a bottom draws
 * a trouser and rings the waistband or the seat, because a trouser is never
 * sized from the chest. `focus` follows the current question, which turns the
 * drawing into a live explanation instead of decoration. Everything is driven by
 * the current answers, so the drawing and the recommendation cannot drift apart.
 */
function BodySilhouette({ height, weight, chest, waist, seat, focus, garment, reduceMotion }) {
  const span = BODY_LIMITS.maxHeight - BODY_LIMITS.minHeight;
  const weightSpan = BODY_LIMITS.maxWeight - BODY_LIMITS.minWeight;
  const heightScale = 0.82 + ((height - BODY_LIMITS.minHeight) / span) * 0.36;
  const widthScale = 0.8 + ((weight - BODY_LIMITS.minWeight) / weightSpan) * 0.4;

  const cx = 60;
  const isBottom = garment === GARMENT.BOTTOM;
  const chestMul = CHEST_WIDTH[chest] || 1;
  const waistMul = WAIST_WIDTH[waist] || 1;
  const seatMul = SEAT_WIDTH[seat] || 1;

  // Top geometry: shoulders, chest, waist, hip.
  const shoulderY = 78;
  const chestY = 106;
  const waistY = 144;
  const hipY = 172;
  const shoulderHalf = 26 * chestMul;
  const chestHalf = 23 * chestMul;
  const waistHalf = 18 * waistMul;
  const hipHalf = 21 * waistMul;
  const torso = [
    `M ${cx - shoulderHalf} ${shoulderY}`,
    `Q ${cx} ${shoulderY - 15} ${cx + shoulderHalf} ${shoulderY}`,
    `Q ${cx + chestHalf} ${chestY} ${cx + waistHalf} ${waistY}`,
    `Q ${cx + hipHalf} ${hipY} ${cx + hipHalf} ${hipY + 12}`,
    `L ${cx - hipHalf} ${hipY + 12}`,
    `Q ${cx - hipHalf} ${hipY} ${cx - waistHalf} ${waistY}`,
    `Q ${cx - chestHalf} ${chestY} ${cx - shoulderHalf} ${shoulderY}`,
    'Z',
  ].join(' ');

  // Trouser geometry: waistband, seat, crotch, hem. A trouser is drawn from the
  // waistband down, so the same height/weight scale still reads correctly.
  const bandTop = 74;
  const bandBottom = 96;
  const seatY = 124;
  const crotchY = 152;
  const hemY = 240;
  const trouserWaist = 22 * waistMul;
  const trouserSeat = 27 * seatMul;
  const hemOuter = 24;
  const hemInner = 9;
  const waistRingY = (bandTop + bandBottom) / 2;
  const trousers = [
    `M ${cx - trouserWaist} ${bandBottom}`,
    `L ${cx + trouserWaist} ${bandBottom}`,
    `C ${cx + trouserWaist + 4} 112, ${cx + trouserSeat} 116, ${cx + trouserSeat} ${seatY + 4}`,
    `L ${cx + hemOuter} ${hemY}`,
    `L ${cx + hemInner} ${hemY}`,
    `L ${cx + 7} ${crotchY}`,
    `L ${cx - 7} ${crotchY}`,
    `L ${cx - hemInner} ${hemY}`,
    `L ${cx - hemOuter} ${hemY}`,
    `L ${cx - trouserSeat} ${seatY + 4}`,
    `C ${cx - trouserSeat} 116, ${cx - trouserWaist - 4} 112, ${cx - trouserWaist} ${bandBottom}`,
    'Z',
  ].join(' ');

  return (
    <div
      className="size-finder-figure"
      style={{
        transform: `scale(${widthScale.toFixed(3)}, ${heightScale.toFixed(3)})`,
        transition: reduceMotion ? 'none' : 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <svg viewBox="0 0 120 260" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="zshm-body-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(201,168,76,0.34)" />
            <stop offset="100%" stopColor="rgba(201,168,76,0.08)" />
          </linearGradient>
          <radialGradient id="zshm-body-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(201,168,76,0.28)" />
            <stop offset="100%" stopColor="rgba(201,168,76,0)" />
          </radialGradient>
        </defs>

        <ellipse cx="60" cy="250" rx="46" ry="10" fill="url(#zshm-body-halo)" />

        {/* Faint measurement rails: the drawing sits between them. */}
        <line x1="10" y1="30" x2="10" y2="240" stroke="rgba(201,168,76,0.16)" strokeWidth="1" />
        <line x1="110" y1="30" x2="110" y2="240" stroke="rgba(201,168,76,0.16)" strokeWidth="1" />
        {[40, 70, 100, 130, 160, 190, 220].map((y) => (
          <line
            key={y}
            x1="7"
            y1={y}
            x2="13"
            y2={y}
            stroke="rgba(201,168,76,0.3)"
            strokeWidth="1"
          />
        ))}
        {[40, 70, 100, 130, 160, 190, 220].map((y) => (
          <line
            key={`r-${y}`}
            x1="107"
            y1={y}
            x2="113"
            y2={y}
            stroke="rgba(201,168,76,0.3)"
            strokeWidth="1"
          />
        ))}

        {isBottom ? (
          <g>
            {/* Waistband, then the two legs. */}
            <rect
              x={cx - trouserWaist}
              y={bandTop}
              width={trouserWaist * 2}
              height={bandBottom - bandTop}
              rx="3"
              fill="url(#zshm-body-fill)"
              stroke="var(--gold)"
              strokeWidth="1.6"
            />
            <line
              x1={cx - trouserWaist + 3}
              y1={bandBottom - 7}
              x2={cx + trouserWaist - 3}
              y2={bandBottom - 7}
              stroke="var(--gold)"
              strokeWidth="1"
              opacity="0.45"
            />
            <path
              d={trousers}
              fill="url(#zshm-body-fill)"
              stroke="var(--gold)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <line x1={cx} y1={bandBottom} x2={cx} y2={crotchY - 6}
              stroke="var(--gold)" strokeWidth="1" opacity="0.4" />
            <line x1={cx - hemOuter + 2} y1={hemY - 10} x2={cx - hemInner + 1} y2={hemY - 10}
              stroke="var(--gold)" strokeWidth="1" opacity="0.35" />
            <line x1={cx + hemInner - 1} y1={hemY - 10} x2={cx + hemOuter - 2} y2={hemY - 10}
              stroke="var(--gold)" strokeWidth="1" opacity="0.35" />

            {focus === 'waist' && (
              <g className="size-finder-figure-focus">
                <ellipse
                  cx={cx}
                  cy={waistRingY}
                  rx={trouserWaist + 9}
                  ry="12"
                  fill="none"
                  stroke="var(--gold-light)"
                  strokeWidth="1.1"
                  strokeDasharray="4 4"
                />
                <line x1={cx - trouserWaist - 16} y1={waistRingY} x2={cx - trouserWaist - 9} y2={waistRingY}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
                <line x1={cx + trouserWaist + 9} y1={waistRingY} x2={cx + trouserWaist + 16} y2={waistRingY}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
              </g>
            )}
            {focus === 'seat' && (
              <g className="size-finder-figure-focus">
                <ellipse
                  cx={cx}
                  cy={seatY}
                  rx={trouserSeat + 9}
                  ry="14"
                  fill="none"
                  stroke="var(--gold-light)"
                  strokeWidth="1.1"
                  strokeDasharray="4 4"
                />
                <line x1={cx - trouserSeat - 16} y1={seatY} x2={cx - trouserSeat - 9} y2={seatY}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
                <line x1={cx + trouserSeat + 9} y1={seatY} x2={cx + trouserSeat + 16} y2={seatY}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
              </g>
            )}
          </g>
        ) : (
          <g>
            {/* Head + neck */}
            <circle cx="60" cy="48" r="16" fill="url(#zshm-body-fill)" stroke="var(--gold)" strokeWidth="1.4" />
            <line x1="60" y1="64" x2="60" y2="76" stroke="var(--gold)" strokeWidth="5" strokeLinecap="round" opacity="0.55" />

            {/* Torso */}
            <path
              d={torso}
              fill="url(#zshm-body-fill)"
              stroke="var(--gold)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />

            {/* The region the current question is about, so the answer has a place. */}
            {focus === 'chest' && (
              <g className="size-finder-figure-focus">
                <ellipse
                  cx={cx}
                  cy={chestY - 2}
                  rx={chestHalf + 9}
                  ry="15"
                  fill="none"
                  stroke="var(--gold-light)"
                  strokeWidth="1.1"
                  strokeDasharray="4 4"
                />
                <line x1={cx - chestHalf - 16} y1={chestY - 2} x2={cx - chestHalf - 9} y2={chestY - 2}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
                <line x1={cx + chestHalf + 9} y1={chestY - 2} x2={cx + chestHalf + 16} y2={chestY - 2}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
              </g>
            )}
            {focus === 'waist' && (
              <g className="size-finder-figure-focus">
                <ellipse
                  cx={cx}
                  cy={waistY - 2}
                  rx={waistHalf + 9}
                  ry="13"
                  fill="none"
                  stroke="var(--gold-light)"
                  strokeWidth="1.1"
                  strokeDasharray="4 4"
                />
                <line x1={cx - waistHalf - 16} y1={waistY - 2} x2={cx - waistHalf - 9} y2={waistY - 2}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
                <line x1={cx + waistHalf + 9} y1={waistY - 2} x2={cx + waistHalf + 16} y2={waistY - 2}
                  stroke="var(--gold-light)" strokeWidth="1" opacity="0.7" />
              </g>
            )}

            {/* Arms */}
            <line x1={cx - shoulderHalf - 2} y1={shoulderY + 4} x2={cx - shoulderHalf - 8} y2={hipY + 16}
              stroke="var(--gold)" strokeWidth="6" strokeLinecap="round" opacity="0.42" />
            <line x1={cx + shoulderHalf + 2} y1={shoulderY + 4} x2={cx + shoulderHalf + 8} y2={hipY + 16}
              stroke="var(--gold)" strokeWidth="6" strokeLinecap="round" opacity="0.42" />

            {/* Legs */}
            <line x1={cx - 9} y1={hipY + 12} x2={cx - 11} y2="240"
              stroke="var(--gold)" strokeWidth="7" strokeLinecap="round" opacity="0.42" />
            <line x1={cx + 9} y1={hipY + 12} x2={cx + 11} y2="240"
              stroke="var(--gold)" strokeWidth="7" strokeLinecap="round" opacity="0.42" />
          </g>
        )}
      </svg>
    </div>
  );
}

/** The circular match gauge: size in the middle, relative score out of 100. */
function MatchGauge({ size, score, reduceMotion }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * (1 - Math.min(100, Math.max(0, score)) / 100);

  return (
    <div className="size-finder-gauge">
      <span className="size-finder-gauge-halo" aria-hidden="true" />
      <svg viewBox="0 0 132 132" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="zshm-gauge-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#9a7a2e" />
            <stop offset="55%" stopColor="#e8c870" />
            <stop offset="100%" stopColor="#c9a84c" />
          </linearGradient>
        </defs>
        <circle cx="66" cy="66" r={radius} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7" />
        <circle
          cx="66"
          cy="66"
          r={radius}
          fill="none"
          stroke="url(#zshm-gauge-gold)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dash}
          transform="rotate(-90 66 66)"
          style={{
            transition: reduceMotion ? 'none' : 'stroke-dashoffset 720ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </svg>
      <div className="size-finder-gauge-center">
        <span className="size-finder-gauge-size">{size}</span>
        <span className="size-finder-gauge-score">{score}/100</span>
      </div>
    </div>
  );
}

/**
 * The numeric companion to a slider.
 *
 * It keeps its own text while the shopper is typing. Clamping on every
 * keystroke would rewrite "1" into "140" and make a height like 180 impossible
 * to type, so the value is committed on blur or Enter, and the live state only
 * follows input that is already inside the accepted range.
 */
function NumberField({ value, min, max, unit, label, onChange }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  const commit = (raw) => {
    const trimmed = String(raw).trim();
    const parsed = trimmed === '' ? NaN : Number(trimmed);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    onChange(next);
    setText(String(next));
  };

  return (
    <span className="size-finder-value">
      <input
        className="size-finder-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        aria-label={label}
        onFocus={() => setEditing(true)}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          const parsed = Number(raw);
          if (raw !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onChange(Math.round(parsed));
          }
        }}
        onBlur={(event) => {
          setEditing(false);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(event.currentTarget.value);
          }
        }}
      />
      <span aria-hidden="true">{unit}</span>
    </span>
  );
}

/** One option in a choice group. Choices arrive one after another so a step
 *  reads as a short list being laid out, not a wall of buttons appearing. */
function Choice({ active, onClick, title, hint, index = 0, reduceMotion }) {
  return (
    <motion.button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="size-finder-choice"
      data-active={active ? 'true' : 'false'}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 0.38, delay: 0.06 + index * 0.07, ease: [0.22, 1, 0.36, 1] }
      }
      whileHover={reduceMotion ? undefined : { y: -2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
    >
      <span className="size-finder-choice-title">{title}</span>
      <span className="size-finder-choice-hint">{hint}</span>
    </motion.button>
  );
}

/**
 * "Find my size" — a four-question flow that ends in an estimated match score.
 *
 * Height and weight come first because they do most of the work. The two shape
 * questions then follow the garment: a top asks about the chest and waist, a
 * trouser asks about the waistband and seat, because a trouser is never sized
 * from the chest. The fit preference applies the shopper's own taste on top.
 * Nothing is computed until the shopper presses Next on the last question, and
 * nothing is restored on load: a refresh always starts from the first question.
 */
export default function SizeFinder({
  sizes = [],
  sizeRanges,
  selectedSize,
  onSelect,
  stockFor,
  onOpenSizeGuide,
  category,
  name,
  sizeGuideOpen = false,
}) {
  const supported = useMemo(() => supportsSizeGuidance(sizes, sizeRanges), [sizes, sizeRanges]);
  const saved = useMemo(() => loadFitProfile(readStorage()), []);
  const reduceMotion = useReducedMotion();
  const garment = useMemo(() => garmentKind({ category, name }), [category, name]);

  // The saved waist answer may belong to the other garment kind ("wider" from a
  // trouser, "rounder" from a shirt). Start from average instead of showing no
  // selected answer.
  const savedWaist = saved?.bodyShape?.waist;
  const initialWaist = garment === GARMENT.BOTTOM
    ? (BOTTOM_WAIST_SHAPES.includes(savedWaist) ? savedWaist : 'average')
    : (WAIST_SHAPES.includes(savedWaist) ? savedWaist : 'average');

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [height, setHeight] = useState(saved ? clamp(saved.height, BODY_LIMITS.minHeight, BODY_LIMITS.maxHeight) : 175);
  const [weight, setWeight] = useState(saved ? clamp(saved.weight, BODY_LIMITS.minWeight, BODY_LIMITS.maxWeight) : 75);
  const [chest, setChest] = useState(saved?.bodyShape?.chest || 'average');
  const [waist, setWaist] = useState(initialWaist);
  const [seat, setSeat] = useState(saved?.bodyShape?.seat || 'average');
  const [fit, setFit] = useState(saved?.fit || 'regular');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [resultProfile, setResultProfile] = useState(null);
  const [activeSize, setActiveSize] = useState(null);

  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const backgroundScrollRef = useRef(0);
  const guideButtonRef = useRef(null);
  const sizeGuideOpenRef = useRef(false);
  const guideWasOpenRef = useRef(false);

  // The product page owns the size guide. While it is open, the finder stays
  // mounted behind it: Escape belongs to the guide, and focus returns to the
  // "Size guide" button when the guide closes, so the shopper never has to
  // reopen the finder to get back to the result.
  useEffect(() => {
    sizeGuideOpenRef.current = sizeGuideOpen;
    if (guideWasOpenRef.current && !sizeGuideOpen) {
      guideButtonRef.current?.focus?.({ preventScroll: true });
    }
    guideWasOpenRef.current = sizeGuideOpen;
  }, [sizeGuideOpen]);

  const close = useCallback(() => {
    setError('');
    setOpen(false);
    if (typeof window !== 'undefined') {
      const node = restoreFocusRef.current;
      window.setTimeout(() => node?.focus?.({ preventScroll: true }), 0);
    }
  }, []);

  // Lock the page behind the dialog and let Escape close it. The page's exact
  // scroll position is restored on exit. While the size guide is open on top,
  // Escape belongs to the guide, not to the finder.
  useEffect(() => {
    if (!open) return undefined;

    // Read the live offset here as well as at click time: the click handler can
    // run before a smooth scroll has settled, while this effect always sees the
    // position the shopper is actually looking at.
    const liveY = typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset;
    const scrollY = Number.isFinite(liveY) ? liveY : backgroundScrollRef.current;
    backgroundScrollRef.current = scrollY;

    const html = document.documentElement;
    const body = document.body;
    const lockedWidth = html.clientWidth;
    const previous = {
      htmlOverflow: html.style.overflow,
      htmlScrollBehavior: html.style.scrollBehavior,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
    };
    html.style.overflow = 'hidden';
    html.style.scrollBehavior = 'auto';
    // `overflow:hidden` alone does not reliably lock the page on iOS Safari.
    // Fix the body in place and restore its exact scroll position on close.
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = `${lockedWidth}px`;
    body.style.overflow = 'hidden';
    body.classList.add('size-finder-open');

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // The guide is stacked above the finder and owns Escape while it is open.
      // Do not stop propagation, so the product page can close the guide.
      if (sizeGuideOpenRef.current) return;
      event.stopPropagation();
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      html.style.overflow = previous.htmlOverflow;
      // The site uses smooth scrolling globally. Keep it disabled until the
      // saved position is restored so closing the dialog never animates from
      // the top of the page back to the trigger.
      html.style.scrollBehavior = 'auto';
      body.style.overflow = previous.bodyOverflow;
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
      // Un-fixing the body and re-enabling the root scroller can clamp the
      // offset for a frame on mobile browsers. Re-assert it once the layout has
      // settled so the shopper lands exactly where they opened the finder.
      window.requestAnimationFrame?.(() => window.scrollTo(0, scrollY));
      html.style.scrollBehavior = previous.htmlScrollBehavior;
      body.classList.remove('size-finder-open');
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  // Focus moves into the dialog on open and onto the question title on each
  // step, so a screen reader hears the new question instead of the old one.
  useEffect(() => {
    if (!open) return;
    const node = step === 0 ? dialogRef.current : titleRef.current;
    node?.focus?.({ preventScroll: true });
  }, [open, step]);

  if (!supported) return null;

  // Only answers that belong to this garment kind reach the engine, so a saved
  // trouser answer can never move a shirt's chest and vice versa.
  const chestValue = CHEST_SHAPES.includes(chest) ? chest : 'average';
  const waistChoices = garment === GARMENT.BOTTOM ? BOTTOM_WAIST_SHAPES : WAIST_SHAPES;
  const waistValue = waistChoices.includes(waist) ? waist : 'average';
  const seatValue = SEAT_SHAPES.includes(seat) ? seat : 'average';
  // Trousers offer "wide leg" instead of "oversized". A saved profile from the
  // other garment kind is translated, so the choice never resets on a switch.
  const fitOptions = fitOptionsFor(garment);
  const fitValue = normalizeFit(fit, garment);

  const showRecommendation = (fitPreference = fitValue) => {
    setError('');
    const next = scoreSizes({
      height,
      weight,
      garment,
      bodyShape: { chest: chestValue, waist: waistValue, seat: seatValue },
      fit: fitPreference,
      sizes,
      sizeRanges,
      stockFor,
    });

    if (!next.ok) {
      setError('Size guidance is not available for this item yet.');
      return;
    }

    setResult(next);
    setResultProfile({
      height,
      weight,
      chest: chestValue,
      waist: waistValue,
      seat: seatValue,
      garment,
      fit: fitPreference,
    });
    setActiveSize(next.recommended);
    setStep(RESULT_STEP);
    saveFitProfile({
      height,
      weight,
      fit: fitPreference,
      bodyShape: { chest: chestValue, waist: waistValue, seat: seatValue },
    }, readStorage());
  };

  const goNext = () => {
    setError('');
    if (step < RESULT_STEP - 1) {
      setDirection(1);
      setStep(step + 1);
      return;
    }
    showRecommendation();
  };

  const goBack = () => {
    setError('');
    setDirection(-1);
    setStep((value) => Math.max(0, value - 1));
  };

  const startOver = () => {
    setResult(null);
    setResultProfile(null);
    setActiveSize(null);
    setError('');
    setDirection(-1);
    setStep(0);
  };

  // Keep Tab inside the dialog. While the size guide is open it is the active
  // dialog, so the finder must not steal focus back.
  const onDialogKeyDown = (event) => {
    if (sizeGuideOpenRef.current) return;
    if (event.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = root.querySelectorAll(
      'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const shown = useMemo(() => {
    if (!result) return null;
    const list = Array.isArray(result.sizes) ? result.sizes : [];
    return list.find((entry) => entry.label === activeSize) || list[0] || null;
  }, [result, activeSize]);

  const band = shown
    ? scoreBand(shown.score, Boolean(result?.decision?.swappedForStock) && shown.label === result.recommended)
    : null;
  const recommended = result?.sizes?.find((entry) => entry.label === result.recommended) || shown;
  const preferenceExplanation = useMemo(() => {
    if (!shown || !recommended || !result?.sizes) return '';
    const alternatives = result.sizes.filter((entry) => entry.label !== shown.label);

    if (shown.label === recommended.label) {
      if (alternatives.length === 0) return 'This is the only size available for this item.';
      const closestAlternatives = [...alternatives]
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      const closest = closestAlternatives[0];
      if (!closest) return `${recommended.label} is the only size available.`;
      const stockNote = result.decision?.swappedForStock
        && result.decision.skippedSize === closest.label ? ' (sold out)' : '';
      return `Next closest is ${closest.label} at ${closest.score}/100${stockNote}.`;
    }

    const preferred = alternatives.filter((entry) =>
      entry.label === recommended.label || entry.score > shown.score
    );
    return preferred.map((entry) => {
      const stockNote = entry.inStock === false ? ' (sold out)' : '';
      return `${entry.label} fits better (${entry.score}/100 vs ${shown.score}/100)${stockNote}.`;
    }).join(' ');
  }, [shown, recommended, result]);
  const profileLine = resultProfile
    ? `${resultProfile.height} cm · ${resultProfile.weight} kg · ${FIT_LABELS[resultProfile.fit] || FIT_LABELS.regular}`
    : '';
  const hasResult = Boolean(result) && step === RESULT_STEP;
  const isSelected = shown && String(selectedSize) === String(shown.label);

  const stepTitles = garment === GARMENT.BOTTOM
    ? [
        'Your height and weight',
        'Your waist',
        'Your seat',
        'How should they sit?',
      ]
    : [
        'Your height and weight',
        'Your chest',
        'Your waist',
        'How should it sit?',
      ];

  // The figure highlights the region the current question is about. A trouser
  // has no chest step, so its two shape questions ring the waistband and seat.
  const figureFocus = step === 1
    ? (garment === GARMENT.BOTTOM ? 'waist' : 'chest')
    : step === 2
      ? (garment === GARMENT.BOTTOM ? 'seat' : 'waist')
      : null;

  const stepMotion = reduceMotion
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, x: direction * 26 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, y: -10, transition: { duration: 0.16, ease: 'easeIn' } },
        transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
      };

  return (
    <section aria-labelledby="size-finder-title" className="size-finder">
      <button
        type="button"
        ref={restoreFocusRef}
        className="size-finder-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          backgroundScrollRef.current = window.scrollY;
          setOpen(true);
          setDirection(1);
          setStep(hasResult ? RESULT_STEP : 0);
        }}
      >
        <span className="size-finder-trigger-icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <span className="size-finder-trigger-text">
          <span id="size-finder-title" className="size-finder-trigger-title">
            {hasResult ? 'Your size' : 'Find my size'}
          </span>
          <span className="size-finder-trigger-meta">
            {hasResult ? profileLine : 'Four quick questions · no tape measure'}
          </span>
        </span>
        {hasResult && shown && (
          <span className="size-finder-trigger-result">
            <span className="size-finder-trigger-size">{shown.label}</span>
            <span className="size-finder-trigger-score">{shown.score}/100</span>
          </span>
        )}
        <ArrowRight size={16} aria-hidden="true" className="size-finder-trigger-arrow" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="size-finder-overlay"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.22 }}
            onClick={close}
          >
            <motion.div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-hidden={sizeGuideOpen ? 'true' : undefined}
              aria-labelledby="size-finder-dialog-title"
              className="size-finder-dialog"
              data-size-guide-open={sizeGuideOpen ? 'true' : 'false'}
              tabIndex={-1}
              onKeyDown={onDialogKeyDown}
              onClick={(event) => event.stopPropagation()}
              initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 20, scale: 0.99 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="size-finder-scroll">
                {/* The topbar is sticky inside the scroller: the question and the
                    progress stay pinned while the answers move underneath, on
                    every step including the result. */}
                <div className="size-finder-topbar">
                  <div className="size-finder-head">
                    <div className="size-finder-head-text">
                      <span className="size-finder-eyebrow">
                        <span className="size-finder-eyebrow-rule" aria-hidden="true" />
                        {hasResult ? 'Your match' : `Step ${step + 1} of ${QUESTION_COUNT}`}
                      </span>
                      <h2 id="size-finder-dialog-title" ref={titleRef} tabIndex={-1} className="size-finder-dialog-title">
                        {hasResult
                          ? (shown && shown.label === recommended?.label ? 'Your size is' : `Size ${shown?.label || ''}`)
                          : stepTitles[step]}
                      </h2>
                    </div>
                    <button type="button" className="size-finder-close" onClick={close} aria-label="Close size finder">
                      <X size={18} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="size-finder-progress" role="presentation">
                    {Array.from({ length: QUESTION_COUNT }, (_, index) => (
                      <span
                        key={index}
                        className="size-finder-progress-seg"
                        data-done={(hasResult || index <= step) ? 'true' : 'false'}
                        data-current={(!hasResult && index === step) ? 'true' : 'false'}
                      />
                    ))}
                  </div>
                </div>

                <div className="size-finder-body">
                  <div className="size-finder-figure-wrap">
                    <BodySilhouette
                      height={height}
                      weight={weight}
                      chest={chestValue}
                      waist={waistValue}
                      seat={seatValue}
                      garment={garment}
                      focus={figureFocus}
                      reduceMotion={reduceMotion}
                    />
                    <div className="size-finder-figure-facts" aria-hidden="true">
                      <span>{height} cm</span>
                      <span>{weight} kg</span>
                    </div>
                  </div>

                  <div className="size-finder-content">
                    {!hasResult && (
                      <form
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault();
                          goNext();
                        }}
                      >
                        <AnimatePresence mode="wait" initial={false}>
                          {step === 0 && (
                            <motion.div key="step-body" className="size-finder-step" {...stepMotion}>
                              <p className="size-finder-helper">
                                Slide to your numbers. They drive the recommendation — the drawing moves with you.
                              </p>

                              <div className="size-finder-field">
                                <label htmlFor="size-finder-height" className="size-finder-field-label">
                                  Height
                                </label>
                                <div className="size-finder-slider-row">
                                  <input
                                    id="size-finder-height"
                                    className="size-finder-slider"
                                    type="range"
                                    min={BODY_LIMITS.minHeight}
                                    max={BODY_LIMITS.maxHeight}
                                    step={1}
                                    value={height}
                                    aria-valuetext={`${height} centimetres`}
                                    onChange={(event) => setHeight(clamp(event.target.value, BODY_LIMITS.minHeight, BODY_LIMITS.maxHeight))}
                                  />
                                  <NumberField
                                    value={height}
                                    min={BODY_LIMITS.minHeight}
                                    max={BODY_LIMITS.maxHeight}
                                    unit="cm"
                                    label="Height in centimetres"
                                    onChange={setHeight}
                                  />
                                </div>
                                <div className="size-finder-scale" aria-hidden="true">
                                  <span>{BODY_LIMITS.minHeight}</span>
                                  <span>{BODY_LIMITS.maxHeight}</span>
                                </div>
                              </div>

                              <div className="size-finder-field">
                                <label htmlFor="size-finder-weight" className="size-finder-field-label">
                                  Weight
                                </label>
                                <div className="size-finder-slider-row">
                                  <input
                                    id="size-finder-weight"
                                    className="size-finder-slider"
                                    type="range"
                                    min={BODY_LIMITS.minWeight}
                                    max={BODY_LIMITS.maxWeight}
                                    step={1}
                                    value={weight}
                                    aria-valuetext={`${weight} kilograms`}
                                    onChange={(event) => setWeight(clamp(event.target.value, BODY_LIMITS.minWeight, BODY_LIMITS.maxWeight))}
                                  />
                                  <NumberField
                                    value={weight}
                                    min={BODY_LIMITS.minWeight}
                                    max={BODY_LIMITS.maxWeight}
                                    unit="kg"
                                    label="Weight in kilograms"
                                    onChange={setWeight}
                                  />
                                </div>
                                <div className="size-finder-scale" aria-hidden="true">
                                  <span>{BODY_LIMITS.minWeight}</span>
                                  <span>{BODY_LIMITS.maxWeight}</span>
                                </div>
                              </div>
                            </motion.div>
                          )}

                          {step === 1 && (
                            <motion.div key={`step-shape-1-${garment}`} className="size-finder-step" {...stepMotion}>
                              {garment === GARMENT.BOTTOM ? (
                                <>
                                  <p className="size-finder-helper">
                                    A waistband is sized from your waist, not your chest. Pick the closest.
                                  </p>

                                  <fieldset className="size-finder-fieldset">
                                    <legend className="size-finder-field-label">Waist</legend>
                                    <div className="size-finder-choices">
                                      {BOTTOM_WAIST_SHAPES.map((option, index) => (
                                        <Choice
                                          key={option}
                                          index={index}
                                          reduceMotion={reduceMotion}
                                          active={waistValue === option}
                                          onClick={() => setWaist(option)}
                                          title={BOTTOM_WAIST_LABELS[option]}
                                          hint={BOTTOM_WAIST_HINTS[option]}
                                        />
                                      ))}
                                    </div>
                                  </fieldset>
                                </>
                              ) : (
                                <>
                                  <p className="size-finder-helper">
                                    Chest and shoulders decide how the top half sits. Pick the closest.
                                  </p>

                                  <fieldset className="size-finder-fieldset">
                                    <legend className="size-finder-field-label">Chest</legend>
                                    <div className="size-finder-choices">
                                      {CHEST_SHAPES.map((option, index) => (
                                        <Choice
                                          key={option}
                                          index={index}
                                          reduceMotion={reduceMotion}
                                          active={chestValue === option}
                                          onClick={() => setChest(option)}
                                          title={CHEST_LABELS[option]}
                                          hint={CHEST_HINTS[option]}
                                        />
                                      ))}
                                    </div>
                                  </fieldset>
                                </>
                              )}
                            </motion.div>
                          )}

                          {step === 2 && (
                            <motion.div key={`step-shape-2-${garment}`} className="size-finder-step" {...stepMotion}>
                              {garment === GARMENT.BOTTOM ? (
                                <>
                                  <p className="size-finder-helper">
                                    The seat decides how the trousers hang from the hip. Pick the closest.
                                  </p>

                                  <fieldset className="size-finder-fieldset">
                                    <legend className="size-finder-field-label">Seat</legend>
                                    <div className="size-finder-choices">
                                      {SEAT_SHAPES.map((option, index) => (
                                        <Choice
                                          key={option}
                                          index={index}
                                          reduceMotion={reduceMotion}
                                          active={seatValue === option}
                                          onClick={() => setSeat(option)}
                                          title={SEAT_LABELS[option]}
                                          hint={SEAT_HINTS[option]}
                                        />
                                      ))}
                                    </div>
                                  </fieldset>
                                </>
                              ) : (
                                <>
                                  <p className="size-finder-helper">
                                    The waist usually breaks the tie between two neighbouring sizes.
                                  </p>

                                  <fieldset className="size-finder-fieldset">
                                    <legend className="size-finder-field-label">Waist</legend>
                                    <div className="size-finder-choices">
                                      {WAIST_SHAPES.map((option, index) => (
                                        <Choice
                                          key={option}
                                          index={index}
                                          reduceMotion={reduceMotion}
                                          active={waistValue === option}
                                          onClick={() => setWaist(option)}
                                          title={WAIST_LABELS[option]}
                                          hint={WAIST_HINTS[option]}
                                        />
                                      ))}
                                    </div>
                                  </fieldset>
                                </>
                              )}
                            </motion.div>
                          )}

                          {step === 3 && (
                            <motion.div key={`step-fit-${garment}`} className="size-finder-step" {...stepMotion}>
                              <p className="size-finder-helper">
                                {garment === GARMENT.BOTTOM
                                  ? 'Last one. How do you like trousers to sit — close, classic, roomy, or wide?'
                                  : 'Last one. How do you like a shirt or jacket to sit on you?'}
                              </p>

                              <fieldset className="size-finder-fieldset">
                                <legend className="size-finder-field-label">Fit</legend>
                                <div className="size-finder-choices">
                                  {fitOptions.map((option, index) => (
                                    <Choice
                                      key={option}
                                      index={index}
                                      reduceMotion={reduceMotion}
                                      active={fitValue === option}
                                      onClick={() => setFit(option)}
                                      title={FIT_LABELS[option]}
                                      hint={(garment === GARMENT.BOTTOM ? FIT_HINTS_BOTTOM : FIT_HINTS)[option]}
                                    />
                                  ))}
                                </div>
                              </fieldset>

                              <p className="size-finder-note">
                                No tape measure needed — exchange within 7 days if it is not right.
                              </p>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {error && (
                          <p role="alert" className="size-finder-error">{error}</p>
                        )}

                        <div className="size-finder-actions">
                          {step > 0 && (
                            <button type="button" className="size-finder-back" onClick={goBack}>
                              <ArrowLeft size={15} aria-hidden="true" />
                              Back
                            </button>
                          )}
                          <button type="submit" className="size-finder-next">
                            Next
                            <ArrowRight size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </form>
                    )}

                    {hasResult && shown && (
                      <div className="size-finder-result">
                        <div aria-live="polite" className="sr-only">
                          {shown.label === recommended?.label
                            ? `We recommend size ${shown.label}, with a match score of ${shown.score} out of 100. ${band.label}.`
                            : `You are viewing size ${shown.label}. We recommend size ${recommended?.label}.`}
                        </div>

                        <MatchGauge size={shown.label} score={shown.score} reduceMotion={reduceMotion} />
                        <p className="size-finder-score-note">
                          Fit score, not a fit guarantee.
                        </p>

                        <div className="size-finder-result-head">
                          <span className="size-finder-band" style={{ color: band.color, borderColor: band.color }}>
                            <span className="size-finder-band-dot" style={{ background: band.color }} aria-hidden="true" />
                            {band.label}
                          </span>
                          {shown.inStock === false && (
                            <span className="size-finder-oos">Sold out in this colour</span>
                          )}
                        </div>

                        <div className="size-finder-explanation" aria-live="polite">
                          <p className="size-finder-reason">{shown.reason}</p>
                          {preferenceExplanation && (
                            <p className="size-finder-preference-reason">{preferenceExplanation}</p>
                          )}
                        </div>

                        {result.decision && result.decision.swappedForStock && (
                          <p className="size-finder-warn">
                            {result.decision.skippedSize} fits you slightly better but is sold out in this colour — {result.decision.size} is the closest available.
                          </p>
                        )}

                        <div className="size-finder-chips" role="group" aria-label="Estimated match score for every size, out of 100">
                          {result.sizes.map((entry) => (
                            <button
                              key={entry.label}
                              type="button"
                              className="size-finder-chip"
                              data-active={entry.label === shown.label ? 'true' : 'false'}
                              data-oos={entry.inStock === false ? 'true' : 'false'}
                              aria-pressed={entry.label === shown.label}
                              onClick={() => setActiveSize(entry.label)}
                            >
                              <span className="size-finder-chip-size">{entry.label}</span>
                              <span className="size-finder-chip-score">{entry.score}/100</span>
                              {entry.inStock === false && (
                                <span className="size-finder-chip-oos">Sold out</span>
                              )}
                            </button>
                          ))}
                        </div>

                        <div className="size-finder-actions size-finder-actions-result">
                          <button
                            type="button"
                            className="size-finder-back size-finder-back-result"
                            onClick={goBack}
                          >
                            <ArrowLeft size={15} aria-hidden="true" />
                            Back
                          </button>
                          <button
                            type="button"
                            className="size-finder-next"
                            disabled={shown.inStock === false}
                            onClick={() => {
                              if (shown.inStock === false) return;
                              if (typeof onSelect === 'function') onSelect(shown.label);
                              close();
                            }}
                          >
                            <Check size={15} aria-hidden="true" />
                            {shown.inStock === false
                              ? 'Sold out'
                              : isSelected
                                ? `Selected ${shown.label}`
                                : `Select size ${shown.label}`}
                          </button>
                          {typeof onOpenSizeGuide === 'function' && (
                            <button
                              type="button"
                              ref={guideButtonRef}
                              className="size-finder-back size-finder-guide"
                              aria-haspopup="dialog"
                              onClick={() => {
                                // The guide opens above the finder; the finder stays
                                // mounted so closing the guide returns to this result.
                                onOpenSizeGuide();
                              }}
                            >
                              <Ruler size={14} aria-hidden="true" />
                              Size guide
                            </button>
                          )}
                        </div>

                        <button type="button" className="size-finder-restart" onClick={startOver}>
                          Start over
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
