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
  CHEST_SHAPES,
  FIT_OPTIONS,
  WAIST_SHAPES,
  loadFitProfile,
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

// How the answers bend the drawing. Width only: height comes from the numbers.
const CHEST_WIDTH = { slimmer: 0.88, average: 1, broader: 1.12 };
const WAIST_WIDTH = { flatter: 0.9, average: 1, rounder: 1.11 };

// Score bands, so the number also reads as a sentence. When the engine had to
// step away from the best-fitting size because it is sold out, the band says so
// instead of calling a deliberately chosen size a rough estimate.
function scoreBand(score, swapped = false) {
  if (swapped) return { label: 'Best available in this colour', color: 'var(--gold)' };
  if (score >= 90) return { label: 'Excellent match', color: '#8fe0b0' };
  if (score >= 75) return { label: 'Strong match', color: 'var(--gold)' };
  if (score >= 55) return { label: 'Close match', color: 'var(--gold)' };
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
 * Height and weight scale the whole figure (taller, wider); the chest and waist
 * answers reshape the torso path itself, so the two extra questions are visible
 * rather than abstract. Everything is driven by the current slider values, so
 * the drawing and the recommendation can never drift apart.
 */
function BodySilhouette({ height, weight, chest, waist, reduceMotion }) {
  const span = BODY_LIMITS.maxHeight - BODY_LIMITS.minHeight;
  const weightSpan = BODY_LIMITS.maxWeight - BODY_LIMITS.minWeight;
  const heightScale = 0.82 + ((height - BODY_LIMITS.minHeight) / span) * 0.36;
  const widthScale = 0.8 + ((weight - BODY_LIMITS.minWeight) / weightSpan) * 0.4;

  const cx = 60;
  const shoulderY = 78;
  const chestY = 106;
  const waistY = 144;
  const hipY = 172;

  const chestMul = CHEST_WIDTH[chest] || 1;
  const waistMul = WAIST_WIDTH[waist] || 1;

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

/** One option in a choice group. */
function Choice({ active, onClick, title, hint }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="size-finder-choice"
      data-active={active ? 'true' : 'false'}
    >
      <span className="size-finder-choice-title">{title}</span>
      <span className="size-finder-choice-hint">{hint}</span>
    </button>
  );
}

/**
 * "Find my size" — a three-question flow that ends in an estimated match score.
 *
 * Height and weight come first because they do most of the work; the chest and
 * waist questions only break ties between neighbouring sizes, and the fit
 * preference applies the shopper's own taste on top. Nothing is computed until
 * the shopper reaches the last step, and nothing is restored on load: a refresh
 * always starts from the first question.
 */
export default function SizeFinder({
  sizes = [],
  sizeRanges,
  selectedSize,
  onSelect,
  stockFor,
  onOpenSizeGuide,
}) {
  const supported = useMemo(() => supportsSizeGuidance(sizes, sizeRanges), [sizes, sizeRanges]);
  const saved = useMemo(() => loadFitProfile(readStorage()), []);
  const reduceMotion = useReducedMotion();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [height, setHeight] = useState(saved ? clamp(saved.height, BODY_LIMITS.minHeight, BODY_LIMITS.maxHeight) : 175);
  const [weight, setWeight] = useState(saved ? clamp(saved.weight, BODY_LIMITS.minWeight, BODY_LIMITS.maxWeight) : 75);
  const [chest, setChest] = useState(saved?.bodyShape?.chest || 'average');
  const [waist, setWaist] = useState(saved?.bodyShape?.waist || 'average');
  const [fit, setFit] = useState(saved?.fit || 'regular');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [resultProfile, setResultProfile] = useState(null);
  const [activeSize, setActiveSize] = useState(null);
  const [showWhy, setShowWhy] = useState(false);

  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const restoreFocusRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    if (typeof window !== 'undefined') {
      const node = restoreFocusRef.current;
      window.setTimeout(() => node?.focus?.({ preventScroll: true }), 0);
    }
  }, []);

  // Lock the page behind the dialog, and let Escape close it. The floating
  // WhatsApp and scroll-to-top actions live above this layer (z-index 30000) and
  // are deliberately left untouched.
  useEffect(() => {
    if (!open) return undefined;

    const scrollY = window.scrollY;
    const html = document.documentElement;
    const body = document.body;
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
    body.style.width = `${html.clientWidth}px`;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      html.style.overflow = previous.htmlOverflow;
      html.style.scrollBehavior = previous.htmlScrollBehavior;
      body.style.overflow = previous.bodyOverflow;
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
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

  const showRecommendation = (fitPreference = fit) => {
    setError('');
    const next = scoreSizes({
      height,
      weight,
      bodyShape: { chest, waist },
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
    setResultProfile({ height, weight, chest, waist, fit });
    setActiveSize(next.recommended);
    setShowWhy(false);
    setStep(3);
    saveFitProfile({ height, weight, fit: fitPreference, bodyShape: { chest, waist } }, readStorage());
  };

  const goNext = () => {
    setError('');
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    showRecommendation();
  };

  const goBack = () => {
    setError('');
    setStep((value) => Math.max(0, value - 1));
  };

  const startOver = () => {
    setResult(null);
    setResultProfile(null);
    setActiveSize(null);
    setShowWhy(false);
    setStep(0);
  };

  // Keep Tab inside the dialog.
  const onDialogKeyDown = (event) => {
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
  const profileLine = resultProfile
    ? `${resultProfile.height} cm · ${resultProfile.weight} kg · ${FIT_LABELS[resultProfile.fit] || FIT_LABELS.regular}`
    : '';
  const hasResult = Boolean(result) && step === 3;
  const isSelected = shown && String(selectedSize) === String(shown.label);

  const stepTitles = [
    'Your height and weight',
    'How do you carry it?',
    'How should it sit?',
  ];

  return (
    <section aria-labelledby="size-finder-title" className="size-finder">
      <button
        type="button"
        ref={restoreFocusRef}
        className="size-finder-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          if (hasResult) setStep(3);
          else setStep(0);
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
            {hasResult ? profileLine : 'Three quick questions · no tape measure'}
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
              aria-labelledby="size-finder-dialog-title"
              className="size-finder-dialog"
              tabIndex={-1}
              onKeyDown={onDialogKeyDown}
              onClick={(event) => event.stopPropagation()}
              initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: 20, scale: 0.99 }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="size-finder-head">
                <div className="size-finder-head-text">
                  <span className="size-finder-eyebrow">
                    {step === 3 ? 'Your match' : `Step ${step + 1} of 3`}
                  </span>
                  <h2 id="size-finder-dialog-title" ref={titleRef} tabIndex={-1} className="size-finder-dialog-title">
                    {step === 3 ? 'Your size is' : stepTitles[step]}
                  </h2>
                </div>
                <button type="button" className="size-finder-close" onClick={close} aria-label="Close size finder">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>

              {step < 3 && (
                <div className="size-finder-progress" role="presentation">
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className="size-finder-progress-seg"
                      data-done={index <= step ? 'true' : 'false'}
                    />
                  ))}
                </div>
              )}

              <div className="size-finder-body">
                <div className="size-finder-figure-wrap">
                  <BodySilhouette
                    height={height}
                    weight={weight}
                    chest={chest}
                    waist={waist}
                    reduceMotion={reduceMotion}
                  />
                  <div className="size-finder-figure-facts" aria-hidden="true">
                    <span>{height} cm</span>
                    <span>{weight} kg</span>
                  </div>
                </div>

                <div className="size-finder-content">
                  <form
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      goNext();
                    }}
                  >
                    <AnimatePresence mode="wait" initial={false}>
                      {step === 0 && (
                        <motion.div
                          key="step-body"
                          className="size-finder-step"
                          initial={reduceMotion ? false : { opacity: 0, x: 18 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? undefined : { opacity: 0, x: -18 }}
                          transition={{ duration: 0.24 }}
                        >
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
                        <motion.div
                          key="step-shape"
                          className="size-finder-step"
                          initial={reduceMotion ? false : { opacity: 0, x: 18 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? undefined : { opacity: 0, x: -18 }}
                          transition={{ duration: 0.24 }}
                        >
                          <p className="size-finder-helper">
                            Two shoppers can weigh the same and still need different sizes. Pick what is closest.
                          </p>

                          <fieldset className="size-finder-fieldset">
                            <legend className="size-finder-field-label">Chest</legend>
                            <div className="size-finder-choices">
                              {CHEST_SHAPES.map((option) => (
                                <Choice
                                  key={option}
                                  active={chest === option}
                                  onClick={() => setChest(option)}
                                  title={CHEST_LABELS[option]}
                                  hint={CHEST_HINTS[option]}
                                />
                              ))}
                            </div>
                          </fieldset>

                          <fieldset className="size-finder-fieldset">
                            <legend className="size-finder-field-label">Waist</legend>
                            <div className="size-finder-choices">
                              {WAIST_SHAPES.map((option) => (
                                <Choice
                                  key={option}
                                  active={waist === option}
                                  onClick={() => setWaist(option)}
                                  title={WAIST_LABELS[option]}
                                  hint={WAIST_HINTS[option]}
                                />
                              ))}
                            </div>
                          </fieldset>
                        </motion.div>
                      )}

                      {step === 2 && (
                        <motion.div
                          key="step-fit"
                          className="size-finder-step"
                          initial={reduceMotion ? false : { opacity: 0, x: 18 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reduceMotion ? undefined : { opacity: 0, x: -18 }}
                          transition={{ duration: 0.24 }}
                        >
                          <p className="size-finder-helper">
                            Last one. How do you like a shirt or jacket to sit on you?
                          </p>

                          <fieldset className="size-finder-fieldset">
                            <legend className="size-finder-field-label">Fit</legend>
                            <div className="size-finder-choices">
                              {FIT_OPTIONS.map((option) => (
                                <Choice
                                  key={option}
                                  active={fit === option}
                                  onClick={() => {
                                    setFit(option);
                                    showRecommendation(option);
                                  }}
                                  title={FIT_LABELS[option]}
                                  hint={FIT_HINTS[option]}
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
                      {step < 2 && (
                        <button type="submit" className="size-finder-next">
                          Next
                          <ArrowRight size={15} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </form>

                  {step === 3 && shown && (
                    <div className="size-finder-result">
                      <div aria-live="polite" className="sr-only">
                        {`We recommend size ${shown.label}, with a match score of ${shown.score} out of 100. ${band.label}.`}
                      </div>

                      <p className="size-finder-recommendation">
                        We recommend size <strong>{shown.label}</strong> · {shown.score}/100 match score
                      </p>
                      <MatchGauge size={shown.label} score={shown.score} reduceMotion={reduceMotion} />
                      <p className="size-finder-score-note">
                        This score compares your answers with this item’s size information. It is not a guaranteed-fit percentage.
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

                      <p className="size-finder-reason">{shown.reason}</p>

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

                      <div className="size-finder-actions">
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
                            className="size-finder-back"
                            onClick={() => {
                              close();
                              onOpenSizeGuide();
                            }}
                          >
                            <Ruler size={14} aria-hidden="true" />
                            Size guide
                          </button>
                        )}
                      </div>

                      <div className="size-finder-why">
                        <button
                          type="button"
                          className="size-finder-why-toggle"
                          aria-expanded={showWhy}
                          aria-controls={showWhy ? 'size-finder-why-body' : undefined}
                          onClick={() => setShowWhy((value) => !value)}
                        >
                          Why this size?
                        </button>
                        {showWhy && (
                          <div id="size-finder-why-body" className="size-finder-why-body">
                            <p>{result.decision?.reason}</p>
                            <p className="size-finder-why-meta">
                              {result.mode === 'ranges'
                                ? 'Matched against the size windows published for this item.'
                                : 'Matched against the published chest chart for this item.'}
                            </p>
                          </div>
                        )}
                      </div>

                      <button type="button" className="size-finder-restart" onClick={startOver}>
                        Start over
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
