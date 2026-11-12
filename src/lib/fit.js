// Size recommendation engine for the storefront.
//
// The input is deliberately tiny: height, weight and the fit the customer
// likes. Shoppers rarely own a tape measure and will abandon any flow that
// asks them for body measurements, so the model never requests one.
//
// Two matching modes, in this order of preference:
//
//   1. OWNER RANGES (preferred). The shop owner can publish, per product and
//      per size, the body height/weight window that size is meant for. The
//      engine picks the size whose window is closest to the customer — zero
//      distance means the customer is inside the window. Nothing is guessed.
//
//   2. STANDARD CHART (fallback). For products the owner has not configured
//      yet, chest is estimated from height + weight and matched against the
//      same chest ranges the storefront size guide shows, so the
//      recommendation and the chart can never disagree.
//
// The result always explains itself (`reason`) and reports how it was reached
// (`mode`), so the UI never shows a black-box letter.

export const FIT_PROFILE_KEY = 'zashm.fitProfile.v1';

export const FIT_OPTIONS = ['slim', 'regular', 'relaxed', 'oversized'];

/** Accepted body input, in cm and kg. */
export const BODY_LIMITS = {
  minHeight: 140,
  maxHeight: 210,
  minWeight: 35,
  maxWeight: 200,
};

/** Accepted owner range bounds, in cm and kg (wider than body limits). */
export const RANGE_LIMITS = {
  minWeight: 30,
  maxWeight: 250,
  minHeight: 120,
  maxHeight: 230,
};

/**
 * Chart mode: how far the target chest moves from the body estimate, in cm.
 * Slim aims at the bottom of a size, oversized at the next size up.
 */
export const FIT_OFFSET = { slim: -4, regular: 0, relaxed: 6, oversized: 12 };

/**
 * Range mode: how much the requested fit shifts the *effective* weight, in kg.
 * A relaxed/oversized fit nudges the customer towards the roomier size when
 * they sit on the boundary between two sizes; slim nudges towards the closer
 * cut. Regular never changes the owner's numbers.
 */
export const FIT_WEIGHT_NUDGE = { slim: -4, regular: 0, relaxed: 3, oversized: 6 };

// Published "to fit chest" ranges (cm) — the same numbers as the size guide.
const CHEST_RANGES = {
  XS: [86, 91],
  S: [92, 96],
  M: [97, 101],
  L: [102, 106],
  XL: [107, 111],
  XXL: [112, 116],
  '3XL': [117, 121],
};

// EU / Egyptian numeric sizes → letter sizes (48 is a medium, 50 a large).
const NUMERIC_SIZES = {
  42: 'XS',
  44: 'XS',
  46: 'S',
  48: 'M',
  50: 'L',
  52: 'XL',
  54: 'XXL',
  56: '3XL',
};

/** Map any supported size token to its letter key, or null when unsupported. */
export function normalizeSize(size) {
  const raw = String(size == null ? '' : size).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/\s+/g, '');
  if (Object.prototype.hasOwnProperty.call(CHEST_RANGES, upper)) return upper;
  if (/^[0-9]{2}$/.test(upper)) return NUMERIC_SIZES[upper] || null;
  return null;
}

/** True when at least one size can be evaluated (owner range or chart). */
export function supportsSizeGuidance(sizes, sizeRanges) {
  if (!Array.isArray(sizes)) return false;
  const ranges = sanitizeSizeRanges(sizeRanges);
  return sizes.some((size) => normalizeSize(size) !== null || Object.prototype.hasOwnProperty.call(ranges, String(size).trim()));
}

/** Rough chest estimate in cm, or null when the input is unusable. */
export function estimateChest({ height, weight } = {}) {
  const h = Number(height);
  const w = Number(weight);
  if (!Number.isFinite(h) || !Number.isFinite(w)) return null;
  if (h < BODY_LIMITS.minHeight || h > BODY_LIMITS.maxHeight) return null;
  if (w < BODY_LIMITS.minWeight || w > BODY_LIMITS.maxWeight) return null;
  return Math.round(0.30 * h + 0.40 * w + 17);
}

function bound(value, limits) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < limits[0] || n > limits[1]) return null;
  return Math.round(n);
}

/**
 * Normalise the owner's per-size ranges into a predictable object.
 *
 * `{ M: { minWeight: 60, maxWeight: 75, minHeight: 165, maxHeight: 180 } }`
 *
 * Rules: unknown/invalid numbers are dropped, bounds are clamped to a sane
 * window, an inverted min/max pair is swapped (never rejected), and entries
 * with no usable bound are removed entirely. Never throws.
 */
export function sanitizeSizeRanges(value, sizes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  // Resolve keys back to the product's declared spelling so `m` and `M` never
  // become two entries, and so the storefront can look a size up directly.
  const declared = new Map();
  for (const size of Array.isArray(sizes) ? sizes : []) {
    const label = String(size == null ? '' : size).trim();
    if (label) declared.set(label.toLowerCase(), label);
  }

  const out = {};
  for (const [rawKey, rawRange] of Object.entries(value)) {
    if (!rawRange || typeof rawRange !== 'object' || Array.isArray(rawRange)) continue;
    const trimmed = String(rawKey == null ? '' : rawKey).trim();
    if (!trimmed) continue;
    const key = declared.get(trimmed.toLowerCase()) || trimmed;

    let minWeight = bound(rawRange.minWeight, [RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight]);
    let maxWeight = bound(rawRange.maxWeight, [RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight]);
    let minHeight = bound(rawRange.minHeight, [RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight]);
    let maxHeight = bound(rawRange.maxHeight, [RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight]);

    if (minWeight !== null && maxWeight !== null && minWeight > maxWeight) {
      [minWeight, maxWeight] = [maxWeight, minWeight];
    }
    if (minHeight !== null && maxHeight !== null && minHeight > maxHeight) {
      [minHeight, maxHeight] = [maxHeight, minHeight];
    }

    if (minWeight === null && maxWeight === null && minHeight === null && maxHeight === null) continue;
    out[key] = { minWeight, maxWeight, minHeight, maxHeight };
  }
  return out;
}

/** True when this product carries at least one usable owner range. */
export function hasOwnerRanges(sizeRanges) {
  return Object.keys(sanitizeSizeRanges(sizeRanges)).length > 0;
}

/**
 * Human-readable problems in an owner range draft (used by the admin form).
 * An out-of-range value or an inverted min/max pair is almost always a typo,
 * so it is reported instead of being silently dropped or swapped on save.
 */
export function sizeRangeProblems(sizeRanges) {
  const problems = [];
  if (!sizeRanges || typeof sizeRanges !== 'object' || Array.isArray(sizeRanges)) return problems;
  const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
  const fields = [
    ['minWeight', 'minimum weight', RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight, 'kg'],
    ['maxWeight', 'maximum weight', RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight, 'kg'],
    ['minHeight', 'minimum height', RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight, 'cm'],
    ['maxHeight', 'maximum height', RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight, 'cm'],
  ];
  for (const [size, range] of Object.entries(sizeRanges)) {
    if (!range || typeof range !== 'object') continue;

    for (const [key, label, low, high, unit] of fields) {
      const value = num(range[key]);
      if (value === null || !Number.isFinite(value)) continue;
      if (value < low || value > high) {
        problems.push(`${size}: ${label} must be between ${low} and ${high} ${unit}`);
      }
    }

    const minWeight = num(range.minWeight);
    const maxWeight = num(range.maxWeight);
    const minHeight = num(range.minHeight);
    const maxHeight = num(range.maxHeight);
    const inWeight = minWeight !== null && maxWeight !== null
      && Number.isFinite(minWeight) && Number.isFinite(maxWeight)
      && minWeight >= RANGE_LIMITS.minWeight && minWeight <= RANGE_LIMITS.maxWeight
      && maxWeight >= RANGE_LIMITS.minWeight && maxWeight <= RANGE_LIMITS.maxWeight;
    const inHeight = minHeight !== null && maxHeight !== null
      && Number.isFinite(minHeight) && Number.isFinite(maxHeight)
      && minHeight >= RANGE_LIMITS.minHeight && minHeight <= RANGE_LIMITS.maxHeight
      && maxHeight >= RANGE_LIMITS.minHeight && maxHeight <= RANGE_LIMITS.maxHeight;
    if (inWeight && minWeight > maxWeight) {
      problems.push(`${size}: minimum weight is above maximum weight`);
    }
    if (inHeight && minHeight > maxHeight) {
      problems.push(`${size}: minimum height is above maximum height`);
    }
  }
  return problems;
}

/** Gap between a value and a [min, max] window; 0 when inside. */
function windowGap(min, max, value) {
  if (min !== null && value < min) return min - value;
  if (max !== null && value > max) return value - max;
  return 0;
}

function formatWindow(min, max, unit) {
  if (min !== null && max !== null) return `${min}–${max} ${unit}`;
  if (min !== null) return `${min}+ ${unit}`;
  if (max !== null) return `up to ${max} ${unit}`;
  return '';
}

/** Human sentence describing an owner range, e.g. "60–75 kg, 165–180 cm". */
export function describeRange(range) {
  if (!range) return '';
  const parts = [];
  const weight = formatWindow(range.minWeight, range.maxWeight, 'kg');
  const height = formatWindow(range.minHeight, range.maxHeight, 'cm');
  if (weight) parts.push(weight);
  if (height) parts.push(height);
  return parts.join(', ');
}

const FIT_WORD = {
  slim: 'slim',
  regular: 'regular',
  relaxed: 'relaxed',
  oversized: 'oversized',
};

/** Turn a recommendation into one honest, explainable sentence. */
export function describeRecommendation(result) {
  if (!result || !result.ok) return '';
  const fit = FIT_WORD[result.fit] || 'regular';

  if (result.mode === 'ranges') {
    const window = describeRange(result.range);
    if (!window) return `Size ${result.size} is the closest to your height and weight for a ${fit} fit.`;
    if (result.distance === 0) {
      return `Your height and weight are inside the ${result.size} range (${window}) — a ${fit} fit.`;
    }
    return `Closest to size ${result.size} (${window}) — a ${fit} fit.`;
  }

  const range = Array.isArray(result.chestRange) ? result.chestRange : [];
  if (range.length === 2) {
    const base = `Chest ≈ ${result.chest} cm. Size ${result.size} is cut for ${range[0]}–${range[1]} cm`;
    return result.distance === 0
      ? `${base} — a ${fit} fit.`
      : `${base} — the closest match for a ${fit} fit.`;
  }
  return `Chest ≈ ${result.chest} cm. Size ${result.size} is the closest match for a ${fit} fit.`;
}

/**
 * Recommend the closest size.
 *
 * @param {object} input
 * @param {number} input.height  cm
 * @param {number} input.weight  kg
 * @param {'slim'|'regular'|'relaxed'|'oversized'} [input.fit]
 * @param {Array<string|number>} input.sizes  sizes offered by the product
 * @param {object} [input.sizeRanges]  owner ranges, keyed by size label
 * @param {(size: string) => number|null} [input.stockFor] stock for the colour
 */
export function recommendSize(input = {}) {
  const fit = FIT_OPTIONS.includes(input.fit) ? input.fit : 'regular';
  const height = Number(input.height);
  const weight = Number(input.weight);
  const chest = estimateChest({ height, weight });
  if (chest == null) return { ok: false, reason: 'invalid-body' };

  const declaredSizes = (Array.isArray(input.sizes) ? input.sizes : [])
    .map((size) => String(size == null ? '' : size).trim())
    .filter(Boolean);
  if (!declaredSizes.length) return { ok: false, reason: 'unsupported-sizes' };

  const ranges = sanitizeSizeRanges(input.sizeRanges, declaredSizes);
  const candidates = [];

  // ── Mode 1: owner ranges ──────────────────────────────────────────────────
  const effectiveWeight = weight + FIT_WEIGHT_NUDGE[fit];
  for (const size of declaredSizes) {
    const range = ranges[size];
    if (!range) continue;
    const distance = windowGap(range.minWeight, range.maxWeight, effectiveWeight)
      + windowGap(range.minHeight, range.maxHeight, height);
    candidates.push({ label: size, key: normalizeSize(size), range, distance });
  }

  let mode = 'ranges';
  if (candidates.length === 0) {
    // No size has an owner window yet. Fall back to the published chart so the
    // customer still gets an answer for products the owner has not configured.
    mode = 'chart';
    const offset = FIT_OFFSET[fit];
    const target = chest + offset;
    for (const size of declaredSizes) {
      const key = normalizeSize(size);
      if (!key) continue;
      const chestRange = CHEST_RANGES[key];
      const distance = windowGap(chestRange[0], chestRange[1], target);
      candidates.push({ label: size, key, chestRange, distance });
    }
  }

  if (!candidates.length) return { ok: false, reason: 'unsupported-sizes' };

  // Closest wins. On a tie prefer the larger size: roomier is the safer
  // mistake and never feels unexpectedly tight.
  const sizeOrder = (candidate) => {
    if (candidate.range) {
      const mid = ((candidate.range.minWeight ?? candidate.range.maxWeight ?? 0)
        + (candidate.range.maxWeight ?? candidate.range.minWeight ?? 0)) / 2;
      const heightMid = ((candidate.range.minHeight ?? candidate.range.maxHeight ?? 0)
        + (candidate.range.maxHeight ?? candidate.range.minHeight ?? 0)) / 2;
      return mid + heightMid;
    }
    return candidate.chestRange[0];
  };
  candidates.sort((a, b) => a.distance - b.distance || sizeOrder(b) - sizeOrder(a));

  const nearest = candidates[0];
  const stockOf = typeof input.stockFor === 'function' ? input.stockFor : null;
  const stockValue = (size) => {
    if (!stockOf) return null;
    const value = Number(stockOf(size));
    return Number.isFinite(value) ? value : null;
  };

  // A different size is only offered when it is an equally good fit. A whole
  // size away is never substituted just because the right size sold out.
  const swapTolerance = mode === 'ranges' ? 4 : 2;
  let chosen = nearest;
  let skippedSize = null;
  const nearestStock = stockValue(nearest.label);
  if (nearestStock !== null && nearestStock <= 0) {
    const fallback = candidates.find((candidate) => {
      const stock = stockValue(candidate.label);
      return stock !== null && stock > 0 && candidate.distance <= nearest.distance + swapTolerance;
    });
    if (fallback) {
      chosen = fallback;
      skippedSize = nearest.label;
    }
  }

  const chosenStock = stockValue(chosen.label);
  const bmi = weight / ((height / 100) ** 2);
  let confidence = chosen.distance === 0 ? 'high' : chosen.distance <= 3 ? 'medium' : 'low';
  if (Number.isFinite(bmi) && (bmi < 16 || bmi > 40)) confidence = 'low';

  const result = {
    ok: true,
    mode,
    size: chosen.label,
    key: chosen.key,
    distance: chosen.distance,
    confidence,
    fit,
    inStock: chosenStock === null ? null : chosenStock > 0,
    swappedForStock: skippedSize !== null,
    skippedSize,
    alternatives: candidates
      .filter((candidate) => candidate.label !== chosen.label)
      .slice(0, 2)
      .map((candidate) => candidate.label),
  };

  if (mode === 'ranges') {
    result.range = chosen.range;
    result.effectiveWeight = effectiveWeight;
  } else {
    result.chest = chest;
    result.offset = FIT_OFFSET[fit];
    result.target = chest + FIT_OFFSET[fit];
    result.chestRange = chosen.chestRange;
  }
  result.reason = describeRecommendation(result);
  return result;
}

/** Read the saved profile, tolerating missing / corrupt storage. */
export function loadFitProfile(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return null;
    const raw = storage.getItem(FIT_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const height = Number(parsed.height);
    const weight = Number(parsed.weight);
    if (!Number.isFinite(height) || !Number.isFinite(weight)) return null;
    if (height < BODY_LIMITS.minHeight || height > BODY_LIMITS.maxHeight) return null;
    if (weight < BODY_LIMITS.minWeight || weight > BODY_LIMITS.maxWeight) return null;
    return {
      height: Math.round(height),
      weight: Math.round(weight),
      fit: FIT_OPTIONS.includes(parsed.fit) ? parsed.fit : 'regular',
    };
  } catch (error) {
    return null;
  }
}

/** Persist the profile locally; never throws (private mode, quota, ...). */
export function saveFitProfile(profile, storage) {
  try {
    if (!storage || typeof storage.setItem !== 'function' || !profile) return false;
    const height = Number(profile.height);
    const weight = Number(profile.weight);
    if (!Number.isFinite(height) || !Number.isFinite(weight)) return false;
    if (height < BODY_LIMITS.minHeight || height > BODY_LIMITS.maxHeight) return false;
    if (weight < BODY_LIMITS.minWeight || weight > BODY_LIMITS.maxWeight) return false;
    storage.setItem(FIT_PROFILE_KEY, JSON.stringify({
      height: Math.round(height),
      weight: Math.round(weight),
      fit: FIT_OPTIONS.includes(profile.fit) ? profile.fit : 'regular',
    }));
    return true;
  } catch (error) {
    return false;
  }
}
