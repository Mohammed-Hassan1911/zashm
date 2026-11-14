import React, { useMemo, useRef, useState } from 'react';
import { ChevronDown, Ruler, Sparkles } from 'lucide-react';
import {
  FIT_OPTIONS,
  loadFitProfile,
  recommendSize,
  saveFitProfile,
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

const CONFIDENCE = {
  high: { label: 'High match', short: 'High match', color: '#8fe0b0' },
  medium: { label: 'Likely match', short: 'Likely', color: 'var(--gold)' },
  low: { label: 'Rough estimate', short: 'Estimate', color: 'var(--text3)' },
};

const EYEBROW = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: 'uppercase',
  color: 'var(--gold)',
};

const META = {
  display: 'block',
  fontSize: 11,
  color: 'var(--text3)',
  marginTop: 3,
  lineHeight: 1.5,
};

const INPUT = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text)',
  padding: '10px 12px',
  minHeight: 44,
  outline: 'none',
};

const FIELD_LABEL = {
  display: 'grid',
  gap: 5,
  fontSize: 11,
  color: 'var(--text3)',
  letterSpacing: 1,
  textTransform: 'uppercase',
};

function readStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

/**
 * "Find my size" — height + weight + preferred fit, no tape measure.
 * Matching uses the owner's per-size height/weight windows when the product
 * has them, and the published size chart otherwise. The recommendation is
 * computed locally and remembered on the device, so returning shoppers see
 * their size on every product page.
 *
 * The card stays quiet: the size and one line of facts are always visible, and
 * the full explanation sits behind "Why this size?".
 */
export default function SizeFinder({ sizes = [], sizeRanges, selectedSize, onSelect, stockFor, onOpenSizeGuide }) {
  const supported = useMemo(() => supportsSizeGuidance(sizes, sizeRanges), [sizes, sizeRanges]);
  const saved = useMemo(() => loadFitProfile(readStorage()), []);

  // Mount-only: a saved profile is turned into a recommendation once. Later
  // submits replace it through state.
  const initialResult = useMemo(() => {
    if (!saved) return null;
    const recommendation = recommendSize({
      height: saved.height,
      weight: saved.weight,
      fit: saved.fit,
      sizes,
      sizeRanges,
      stockFor,
    });
    return recommendation.ok ? recommendation : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(!initialResult);
  const [height, setHeight] = useState(saved ? String(saved.height) : '');
  const [weight, setWeight] = useState(saved ? String(saved.weight) : '');
  const [fit, setFit] = useState(saved ? saved.fit : 'regular');
  const [error, setError] = useState('');
  const [result, setResult] = useState(initialResult);
  const [showWhy, setShowWhy] = useState(false);

  const heightRef = useRef(null);
  const weightRef = useRef(null);
  const resultRef = useRef(null);

  if (!supported) return null;

  const clearError = () => { if (error) setError(''); };

  const submit = (event) => {
    event.preventDefault();
    const h = Number(height);
    const w = Number(weight);
    if (!Number.isFinite(h) || h < 140 || h > 210) {
      setError('Please enter a height between 140 and 210 cm.');
      heightRef.current?.focus();
      return;
    }
    if (!Number.isFinite(w) || w < 35 || w > 200) {
      setError('Please enter a weight between 35 and 200 kg.');
      weightRef.current?.focus();
      return;
    }

    setError('');
    const next = recommendSize({ height: h, weight: w, fit, sizes, sizeRanges, stockFor });
    if (!next.ok) {
      setError('Size guidance is not available for this item yet.');
      return;
    }
    setResult(next);
    setEditing(false);
    setShowWhy(false);
    saveFitProfile({ height: h, weight: w, fit }, readStorage());
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 60);
    }
  };

  const confidence = result ? (CONFIDENCE[result.confidence] || CONFIDENCE.low) : null;
  const isSelected = result && String(selectedSize) === String(result.size);
  const profileLine = result
    ? `${height} cm · ${weight} kg · ${FIT_LABELS[fit] || FIT_LABELS.regular}`
    : '';

  return (
    <section
      aria-labelledby="size-finder-title"
      className="size-finder"
      style={{
        marginTop: 4,
        marginBottom: 28,
        border: '1px solid var(--border-gold, rgba(201,168,76,0.35))',
        borderRadius: 6,
        background: 'rgba(201,168,76,0.045)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="size-finder-panel"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          minHeight: 48,
          background: 'none',
          border: 'none',
          color: 'var(--text)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <Sparkles size={15} color="var(--gold)" aria-hidden="true" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span id="size-finder-title" style={EYEBROW}>
            {result ? 'Your size' : 'Find my size'}
          </span>
          <span style={META}>
            {result ? profileLine : 'Height + weight + fit'}
          </span>
        </span>
        {result && (
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              lineHeight: 1,
              color: 'var(--gold)',
              flexShrink: 0,
            }}
          >
            {result.size}
          </span>
        )}
        <ChevronDown
          size={16}
          aria-hidden="true"
          style={{ flexShrink: 0, color: 'var(--text3)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
        />
      </button>

      {open && (
        <form
          id="size-finder-panel"
          onSubmit={submit}
          noValidate
          style={{ padding: '0 14px 14px', display: 'grid', gap: 12 }}
        >
          {editing && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                <label style={FIELD_LABEL}>
                  Height (cm)
                  <input
                    ref={heightRef}
                    className="size-finder-input"
                    type="number"
                    inputMode="numeric"
                    min={140}
                    max={210}
                    step={1}
                    value={height}
                    onChange={(event) => { setHeight(event.target.value); clearError(); }}
                    placeholder="175"
                    aria-describedby={error ? 'size-finder-error' : undefined}
                    style={INPUT}
                  />
                </label>
                <label style={FIELD_LABEL}>
                  Weight (kg)
                  <input
                    ref={weightRef}
                    className="size-finder-input"
                    type="number"
                    inputMode="numeric"
                    min={35}
                    max={200}
                    step={1}
                    value={weight}
                    onChange={(event) => { setWeight(event.target.value); clearError(); }}
                    placeholder="75"
                    aria-describedby={error ? 'size-finder-error' : undefined}
                    style={INPUT}
                  />
                </label>
              </div>

              <div>
                <span id="size-finder-fit-label" style={{ ...FIELD_LABEL, display: 'block', marginBottom: 6 }}>
                  Fit
                </span>
                <div role="group" aria-labelledby="size-finder-fit-label" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {FIT_OPTIONS.map((option) => {
                    const active = fit === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={active}
                        onClick={() => { setFit(option); clearError(); }}
                        className="size-finder-chip"
                        title={FIT_HINTS[option]}
                        style={{
                          flex: '1 1 70px',
                          minHeight: 44,
                          padding: '6px 10px',
                          borderRadius: 3,
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          cursor: 'pointer',
                          border: `1px solid ${active ? 'var(--gold)' : 'var(--border)'}`,
                          background: active ? 'rgba(201,168,76,0.14)' : 'transparent',
                          color: active ? 'var(--gold)' : 'var(--text2)',
                        }}
                      >
                        {FIT_LABELS[option]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {error && (
                <p id="size-finder-error" role="alert" style={{ color: '#e74c3c', fontSize: 12, margin: 0 }}>{error}</p>
              )}

              <button
                type="submit"
                style={{
                  minHeight: 46,
                  borderRadius: 3,
                  border: '1px solid var(--gold)',
                  background: 'var(--gold)',
                  color: '#0a0a0a',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
              >
                Suggest my size
              </button>
            </>
          )}

          <div ref={resultRef} aria-live="polite">
            {result && (
              <div
                style={{
                  border: '1px solid rgba(201,168,76,0.28)',
                  background: 'rgba(0,0,0,0.25)',
                  borderRadius: 6,
                  padding: 12,
                  display: 'grid',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 34, lineHeight: 0.9, color: 'var(--gold)' }}>
                    {result.size}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', color: confidence.color }}>
                    <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: confidence.color }} />
                    {confidence.label}
                  </span>
                  {!editing && (
                    <button
                      type="button"
                      onClick={() => { setEditing(true); setShowWhy(false); }}
                      style={{ marginLeft: 'auto', minHeight: 36, padding: '4px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text2)', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', cursor: 'pointer' }}
                    >
                      Edit
                    </button>
                  )}
                </div>

                {result.swappedForStock && (
                  <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--gold)' }}>
                    {result.skippedSize} sold out — {result.size} is the closest available.
                  </p>
                )}
                {!result.swappedForStock && result.inStock === false && (
                  <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--gold)' }}>
                    Sold out in this colour — try another one above.
                  </p>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => onSelect && onSelect(result.size)}
                    style={{
                      flex: '1 1 130px',
                      minHeight: 44,
                      borderRadius: 3,
                      border: '1px solid var(--gold)',
                      background: isSelected ? 'rgba(201,168,76,0.2)' : 'transparent',
                      color: 'var(--gold)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      cursor: 'pointer',
                    }}
                  >
                    {isSelected ? `Selected ${result.size}` : `Select ${result.size}`}
                  </button>
                  {typeof onOpenSizeGuide === 'function' && (
                    <button
                      type="button"
                      onClick={onOpenSizeGuide}
                      style={{
                        flex: '0 0 auto',
                        minHeight: 44,
                        padding: '0 12px',
                        borderRadius: 3,
                        border: '1px solid var(--border)',
                        background: 'transparent',
                        color: 'var(--text2)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: 0.6,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <Ruler size={13} aria-hidden="true" />
                      Size guide
                    </button>
                  )}
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowWhy((value) => !value)}
                    aria-expanded={showWhy}
                    aria-controls={showWhy ? 'size-finder-why' : undefined}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      minHeight: 32,
                      padding: '4px 0',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text3)',
                      fontSize: 11,
                      letterSpacing: 0.3,
                      cursor: 'pointer',
                    }}
                  >
                    Why this size?
                    <ChevronDown
                      size={12}
                      aria-hidden="true"
                      style={{ transform: showWhy ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
                    />
                  </button>
                  {showWhy && (
                    <div id="size-finder-why" style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text2)' }}>
                        {result.reason}
                      </p>
                      <p style={{ margin: 0, fontSize: 10, lineHeight: 1.6, color: 'var(--text3)' }}>
                        No tape measure needed — exchange within 7 days if it is not right.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
