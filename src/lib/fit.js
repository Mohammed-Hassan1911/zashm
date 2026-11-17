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

// Trousers are not "oversized". A trouser's width is a cut — wide leg — not a
// garment size, and asking a shopper to buy an oversized waistband is wrong:
// an oversized waistband falls down instead of draping. So bottoms offer a
// wide leg, and the engine only adds a small waistband ease for it.
export const FIT_OPTIONS_BOTTOM = ['slim', 'regular', 'relaxed', 'wide'];

/** The fit choices offered for a garment kind. */
export function fitOptionsFor(garment) {
  return garment === GARMENT.BOTTOM ? FIT_OPTIONS_BOTTOM : FIT_OPTIONS;
}

/**
 * Translate a saved or cross-garment fit into one this garment offers.
 * A profile saved on a shirt ("oversized") becomes "wide" on a trouser, and a
 * trouser's "wide" becomes "oversized" on a shirt, so the choice survives a
 * switch instead of silently resetting to regular.
 */
export function normalizeFit(fit, garment) {
  const isBottom = garment === GARMENT.BOTTOM;
  const options = isBottom ? FIT_OPTIONS_BOTTOM : FIT_OPTIONS;
  if (options.includes(fit)) return fit;
  if (isBottom && fit === 'oversized') return 'wide';
  if (!isBottom && fit === 'wide') return 'oversized';
  return 'regular';
}

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

// ── Garment kind ─────────────────────────────────────────────────────────────
// A trouser is sized from the waist and seat, never from the chest, so the
// finder asks different questions and the chart fallback scores a different
// measurement. Categories are free text ("Shirts", "Trousers", ...), so the
// kind is read from the category and the product name.
//
// A top word wins when both appear, because "denim jacket" and "short sleeve
// shirt" are tops even though they contain a bottom word.
export const GARMENT = { TOP: 'top', BOTTOM: 'bottom' };

const TOP_PATTERN = /\b(shirts?|tees?|t-shirts?|tshirts?|polos?|jackets?|coats?|hoodies?|sweatshirts?|sweaters?|knitwear|cardigans?|blazers?|tops?|outerwear|overshirts?)\b/;
const BOTTOM_PATTERN = /\b(pants?|trousers?|jeans?|shorts?|skirts?|chinos?|cargos?|joggers?|sweatpants?|trackpants?|denim|bermudas?)\b/;

/** 'bottom' for trousers/shorts, 'top' for everything else (the safe default). */
export function garmentKind(product = {}) {
  const text = `${(product && product.category) || ''} ${(product && product.name) || ''}`.toLowerCase();
  if (TOP_PATTERN.test(text)) return GARMENT.TOP;
  if (BOTTOM_PATTERN.test(text)) return GARMENT.BOTTOM;
  return GARMENT.TOP;
}

/**
 * Chart mode: how far the target chest moves from the body estimate, in cm.
 * Slim aims at the bottom of a size, oversized at the next size up.
 */
export const FIT_OFFSET = { slim: -4, regular: 0, relaxed: 6, oversized: 12 };

/**
 * Chart mode for bottoms: how far the target waist moves, in cm. A trouser
 * waistband is far less forgiving than a shirt, so the steps are small. A wide
 * leg is a leg cut, not a bigger waist, so it adds less ease than the old
 * "oversized" did — one size at most, never two.
 */
export const FIT_WAIST_OFFSET = { slim: -3, regular: 0, relaxed: 2, wide: 4 };

/**
 * Range mode: how much the requested fit shifts the *effective* weight, in kg.
 * A relaxed fit nudges the customer towards the roomier size when they sit on
 * the boundary between two sizes; slim nudges towards the closer cut. Regular
 * never changes the owner's numbers. Bottoms use a smaller nudge than tops,
 * for the same reason the waist ease is small.
 */
export const FIT_WEIGHT_NUDGE = { slim: -4, regular: 0, relaxed: 3, oversized: 6 };
export const FIT_WEIGHT_NUDGE_BOTTOM = { slim: -4, regular: 0, relaxed: 2, wide: 4 };

// ── Body shape ───────────────────────────────────────────────────────────────
// Two extra questions the finder asks, because two shoppers with identical
// height and weight can still need different sizes: a broader chest fills a
// garment that a narrower one swims in.
//
// The offsets are deliberately small. They break ties and nudge a boundary
// case; they never override height and weight. `average` is exactly zero, so a
// shopper who skips the questions gets the unchanged height/weight model.
export const CHEST_SHAPES = ['slimmer', 'average', 'broader'];
export const WAIST_SHAPES = ['flatter', 'average', 'rounder'];

// Trousers are sized from the waist and the seat, so a bottom asks about those
// two instead of the chest. The waist question keeps three answers, but they
// describe circumference rather than profile, which is what a waistband needs.
export const BOTTOM_WAIST_SHAPES = ['slimmer', 'average', 'wider'];
export const SEAT_SHAPES = ['narrow', 'average', 'wider'];

const WAIST_VALUES = ['flatter', 'average', 'rounder', 'slimmer', 'wider'];

/** Chart mode: how the shape moves the estimated chest, in cm. */
export const SHAPE_CHEST_CM = { slimmer: -3, average: 0, broader: 3 };
export const SHAPE_WAIST_CM = { flatter: -1, average: 0, rounder: 2, slimmer: -2, wider: 2 };
export const SHAPE_SEAT_CM = { narrow: -2, average: 0, wider: 2 };

/** Range mode: the same idea expressed as kg, because windows are in kg. */
export const SHAPE_CHEST_KG = { slimmer: -3, average: 0, broader: 3 };
export const SHAPE_WAIST_KG = { flatter: -1, average: 0, rounder: 2, slimmer: -2, wider: 2 };
export const SHAPE_SEAT_KG = { narrow: -2, average: 0, wider: 2 };

// Top-only waist answers. A saved bottom answer ("slimmer"/"wider") must not
// move a shirt's chest, so tops read this narrower map instead of the union.
const SHAPE_CHEST_WAIST_CM = { flatter: -1, average: 0, rounder: 2 };
const SHAPE_CHEST_WAIST_KG = { flatter: -1, average: 0, rounder: 2 };

export const BODY_SHAPE_DEFAULT = Object.freeze({ chest: 'average', waist: 'average', seat: 'average' });

/** Never throws: unknown answers collapse to `average`. */
export function sanitizeBodyShape(shape) {
  const chest = shape && CHEST_SHAPES.includes(shape.chest) ? shape.chest : 'average';
  const waist = shape && WAIST_VALUES.includes(shape.waist) ? shape.waist : 'average';
  const seat = shape && SEAT_SHAPES.includes(shape.seat) ? shape.seat : 'average';
  return { chest, waist, seat };
}

/**
 * Total chest offset in cm for a shape answer (0 for average/average).
 * A bottom never uses the chest answer: it cannot size a waistband.
 */
export function shapeChestOffset(shape, garment = GARMENT.TOP) {
  if (garment === GARMENT.BOTTOM) return 0;
  const clean = sanitizeBodyShape(shape);
  // Only the top answers apply here: a bottom's "slimmer/wider" waist must not
  // leak into a shirt's chest because the saved profile is shared.
  const waist = SHAPE_CHEST_WAIST_CM[clean.waist] ?? 0;
  return SHAPE_CHEST_CM[clean.chest] + waist;
}

/** Total waist offset in cm for a bottom's shape answer (0 for average/average). */
export function shapeWaistOffset(shape) {
  const clean = sanitizeBodyShape(shape);
  return SHAPE_WAIST_CM[clean.waist] + SHAPE_SEAT_CM[clean.seat];
}

/** Total weight offset in kg for a shape answer (0 for average/average). */
export function shapeWeightOffset(shape, garment = GARMENT.TOP) {
  const clean = sanitizeBodyShape(shape);
  if (garment === GARMENT.BOTTOM) {
    return SHAPE_WAIST_KG[clean.waist] + SHAPE_SEAT_KG[clean.seat];
  }
  return SHAPE_CHEST_KG[clean.chest] + (SHAPE_CHEST_WAIST_KG[clean.waist] ?? 0);
}

// Published "to fit chest" ranges (cm) — the same numbers as the size guide.
export const CHEST_RANGES = {
  XS: [86, 91],
  S: [92, 96],
  M: [97, 101],
  L: [102, 106],
  XL: [107, 111],
  XXL: [112, 116],
  '3XL': [117, 121],
};

// Published "to fit waist" ranges (cm) — the waist column of the size guide.
// A trouser is scored against these instead of the chest.
export const WAIST_RANGES = {
  XS: [71, 75],
  S: [76, 80],
  M: [81, 85],
  L: [86, 90],
  XL: [91, 95],
  XXL: [96, 100],
  '3XL': [101, 105],
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

/**
 * Rough waist estimate in cm, or null when the input is unusable.
 *
 * Calibrated against the published waist chart: 165 cm / 60 kg ≈ 74 cm,
 * 175 cm / 75 kg ≈ 82 cm, 180 cm / 78 kg ≈ 84 cm. It is an estimate from
 * height and weight, not a measurement, and the result says so.
 */
export function estimateWaist({ height, weight } = {}) {
  const h = Number(height);
  const w = Number(weight);
  if (!Number.isFinite(h) || !Number.isFinite(w)) return null;
  if (h < BODY_LIMITS.minHeight || h > BODY_LIMITS.maxHeight) return null;
  if (w < BODY_LIMITS.minWeight || w > BODY_LIMITS.maxWeight) return null;
  return Math.round(0.13 * h + 0.44 * w + 26);
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
 *
 * `sizes` limits the check to the sizes the product currently declares. The
 * form keeps the window of a size that was removed (so re-adding it brings the
 * window back), but that hidden window must never block saving: the admin
 * cannot see the field, so the message would be unfixable.
 */
export function sizeRangeProblems(sizeRanges, sizes) {
  const problems = [];
  if (!sizeRanges || typeof sizeRanges !== 'object' || Array.isArray(sizeRanges)) return problems;
  const declared = Array.isArray(sizes)
    ? new Set(sizes.map((size) => String(size == null ? '' : size).trim().toLowerCase()).filter(Boolean))
    : null;
  const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
  const fields = [
    ['minWeight', 'minimum weight', RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight, 'kg'],
    ['maxWeight', 'maximum weight', RANGE_LIMITS.minWeight, RANGE_LIMITS.maxWeight, 'kg'],
    ['minHeight', 'minimum height', RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight, 'cm'],
    ['maxHeight', 'maximum height', RANGE_LIMITS.minHeight, RANGE_LIMITS.maxHeight, 'cm'],
  ];
  for (const [size, range] of Object.entries(sizeRanges)) {
    if (declared && !declared.has(String(size).trim().toLowerCase())) continue;
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

/**
 * Signed distance from a window: 0 inside, positive above the maximum,
 * negative below the minimum. Used for wording ("3 kg above"), never for
 * ranking — ranking uses the absolute gap so both sides cost the same.
 */
function windowDelta(min, max, value) {
  if (min !== null && value < min) return value - min;
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
  wide: 'wide-leg',
};

/** Turn a recommendation into one honest, explainable sentence. */
export function describeRecommendation(result) {
  if (!result || !result.ok) return '';
  const fit = FIT_WORD[result.fit] || 'regular';

  if (result.mode === 'ranges') {
    const window = describeRange(result.range);
    if (!window) return `Size ${result.size} is the closest to your height and weight for a ${fit} fit.`;
    const distance = Number.isFinite(result.bodyDistance) ? result.bodyDistance : result.distance;
    if (distance === 0) {
      return `Your height and weight are inside the ${result.size} range (${window}) — a ${fit} fit.`;
    }
    return `Closest to size ${result.size} (${window}) — a ${fit} fit.`;
  }

  if (result.garment === GARMENT.BOTTOM) {
    const waistRange = Array.isArray(result.waistRange) ? result.waistRange : [];
    if (waistRange.length === 2) {
      const base = `Waist ≈ ${result.waist} cm. Size ${result.size} is cut for ${waistRange[0]}–${waistRange[1]} cm`;
      return result.distance === 0
        ? `${base} — a ${fit} fit.`
        : `${base} — the closest match for a ${fit} fit.`;
    }
    return `Waist ≈ ${result.waist} cm. Size ${result.size} is the closest match for a ${fit} fit.`;
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

// ── Match quality ────────────────────────────────────────────────────────────
// How well one window covers one number, from 1 at its centre down to 0 outside.
// It compares sizes whose distance is tied and refines the score for sizes that
// contain the shopper.
//
// Inside the window the score falls from 1 at the centre to 0.7 at the edge,
// because a shopper sitting on the edge is one centimetre away from the next
// size. Outside it keeps falling with a short decay. `average` shape answers and
// a regular fit leave every input untouched, so they never move the number.
const QUALITY_EDGE_LOSS = 0.3;
const QUALITY_DECAY = 2.6;

function axisQuality(min, max, value) {
  if (min === null && max === null) return 1;

  if (min !== null && max !== null) {
    const mid = (min + max) / 2;
    const tolerance = (max - min) / 2;
    const deviation = Math.abs(value - mid);
    if (tolerance === 0) {
      return deviation === 0 ? 1 : (1 - QUALITY_EDGE_LOSS) * Math.exp(-deviation / QUALITY_DECAY);
    }
    if (deviation <= tolerance) {
      return 1 - QUALITY_EDGE_LOSS * (deviation / tolerance) ** 2;
    }
    return (1 - QUALITY_EDGE_LOSS) * Math.exp(-(deviation - tolerance) / QUALITY_DECAY);
  }

  // One-sided window: the owner only promised "from here up" (or down), so there
  // is no centre to sit in.
  const gap = min !== null ? Math.max(0, min - value) : Math.max(0, value - max);
  return gap === 0 ? 1 : (1 - QUALITY_EDGE_LOSS) * Math.exp(-gap / QUALITY_DECAY);
}

/**
 * Build every candidate size with its distance, without deciding anything.
 *
 * This is the single source of truth for the model: `recommendSize` uses it to
 * pick one size, `scoreSizes` uses it to score all of them.
 */
function buildCandidates(input = {}) {
  const garment = input.garment === GARMENT.BOTTOM ? GARMENT.BOTTOM : GARMENT.TOP;
  const fit = normalizeFit(input.fit, garment);
  const height = Number(input.height);
  const weight = Number(input.weight);
  const chest = estimateChest({ height, weight });
  const waist = estimateWaist({ height, weight });
  if (chest == null || waist == null) return { ok: false, reason: 'invalid-body' };

  const declaredSizes = (Array.isArray(input.sizes) ? input.sizes : [])
    .map((size) => String(size == null ? '' : size).trim())
    .filter(Boolean);
  if (!declaredSizes.length) return { ok: false, reason: 'unsupported-sizes' };

  const shape = sanitizeBodyShape(input.bodyShape);
  // A top is sized from the chest, a bottom from the waist. The unused
  // measurement is still computed so the result can describe the body, but it
  // never influences the choice.
  const bodyChest = chest + shapeChestOffset(shape, garment);
  const bodyWaist = waist + shapeWaistOffset(shape);
  const chartRanges = garment === GARMENT.BOTTOM ? WAIST_RANGES : CHEST_RANGES;
  const fitOffset = garment === GARMENT.BOTTOM ? FIT_WAIST_OFFSET[fit] : FIT_OFFSET[fit];
  const target = (garment === GARMENT.BOTTOM ? bodyWaist : bodyChest) + fitOffset;
  const ranges = sanitizeSizeRanges(input.sizeRanges, declaredSizes);
  const candidates = [];

  // ── Mode 1: owner ranges ──────────────────────────────────────────────────
  const fitWeightNudge = garment === GARMENT.BOTTOM ? FIT_WEIGHT_NUDGE_BOTTOM[fit] : FIT_WEIGHT_NUDGE[fit];
  const effectiveWeight = weight + fitWeightNudge + shapeWeightOffset(shape, garment);
  for (const size of declaredSizes) {
    const range = ranges[size];
    if (!range) continue;
    const distance = windowGap(range.minWeight, range.maxWeight, effectiveWeight)
      + windowGap(range.minHeight, range.maxHeight, height);
    // The customer's own body, before the fit preference shifts the weight.
    // Confidence and the "inside the range" wording must describe the body, not
    // the nudge: a slim shopper squarely inside a window is still an exact match.
    const bodyDistance = windowGap(range.minWeight, range.maxWeight, weight)
      + windowGap(range.minHeight, range.maxHeight, height);
    const quality = Math.min(
      axisQuality(range.minWeight, range.maxWeight, effectiveWeight),
      axisQuality(range.minHeight, range.maxHeight, height),
    );
    candidates.push({ label: size, key: normalizeSize(size), range, distance, bodyDistance, quality });
  }

  let mode = 'ranges';
  if (candidates.length === 0) {
    // No size has an owner window yet. Fall back to the published chart so the
    // customer still gets an answer for products the owner has not configured.
    mode = 'chart';
    for (const size of declaredSizes) {
      const key = normalizeSize(size);
      if (!key) continue;
      const sizeRange = chartRanges[key];
      const distance = windowGap(sizeRange[0], sizeRange[1], target);
      const quality = axisQuality(sizeRange[0], sizeRange[1], target);
      if (garment === GARMENT.BOTTOM) {
        candidates.push({ label: size, key, waistRange: sizeRange, distance, quality });
      } else {
        candidates.push({ label: size, key, chestRange: sizeRange, distance, quality });
      }
    }
  }

  if (!candidates.length) return { ok: false, reason: 'unsupported-sizes' };

  return {
    ok: true,
    mode,
    garment,
    fit,
    height,
    weight,
    chest,
    waist,
    bodyChest,
    bodyWaist,
    shape,
    effectiveWeight,
    target,
    declaredSizes,
    candidates,
  };
}

// Closest wins. On a tie prefer the larger size: roomier is the safer mistake
// and never feels unexpectedly tight.
function sizeOrder(candidate) {
  if (candidate.range) {
    const mid = ((candidate.range.minWeight ?? candidate.range.maxWeight ?? 0)
      + (candidate.range.maxWeight ?? candidate.range.minWeight ?? 0)) / 2;
    const heightMid = ((candidate.range.minHeight ?? candidate.range.maxHeight ?? 0)
      + (candidate.range.maxHeight ?? candidate.range.minHeight ?? 0)) / 2;
    return mid + heightMid;
  }
  const chartRange = candidate.chestRange || candidate.waistRange;
  return chartRange ? chartRange[0] : 0;
}

function compareCandidates(a, b) {
  return a.distance - b.distance
    || (b.quality ?? 0) - (a.quality ?? 0)
    || sizeOrder(b) - sizeOrder(a);
}

function stockReader(input) {
  const stockOf = typeof input.stockFor === 'function' ? input.stockFor : null;
  return (size) => {
    if (!stockOf) return null;
    const value = Number(stockOf(size));
    return Number.isFinite(value) ? value : null;
  };
}

/**
 * Pick the size to recommend from an already-sorted candidate list.
 * A different size is only offered when it is an equally good fit. A whole
 * size away is never substituted just because the right size sold out.
 */
function chooseCandidate(candidates, mode, stockValue) {
  const nearest = candidates[0];
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
  return { chosen, skippedSize };
}

/**
 * Recommend the closest size.
 *
 * @param {object} input
 * @param {number} input.height  cm
 * @param {number} input.weight  kg
 * @param {'slim'|'regular'|'relaxed'|'oversized'|'wide'} [input.fit]
 * @param {{chest?: string, waist?: string}} [input.bodyShape]
 * @param {Array<string|number>} input.sizes  sizes offered by the product
 * @param {object} [input.sizeRanges]  owner ranges, keyed by size label
 * @param {(size: string) => number|null} [input.stockFor] stock for the colour
 */
export function recommendSize(input = {}) {
  const built = buildCandidates(input);
  if (!built.ok) return built;

  const { mode, garment, fit, height, weight, chest, waist, bodyChest, bodyWaist, effectiveWeight } = built;
  const candidates = [...built.candidates].sort(compareCandidates);
  const stockValue = stockReader(input);
  const { chosen, skippedSize } = chooseCandidate(candidates, mode, stockValue);

  const chosenStock = stockValue(chosen.label);
  const bmi = weight / ((height / 100) ** 2);
  const bodyDistance = Number.isFinite(chosen.bodyDistance) ? chosen.bodyDistance : chosen.distance;
  let confidence = bodyDistance === 0 ? 'high' : bodyDistance <= 3 ? 'medium' : 'low';
  if (Number.isFinite(bmi) && (bmi < 16 || bmi > 40)) confidence = 'low';

  const result = {
    ok: true,
    mode,
    garment,
    size: chosen.label,
    key: chosen.key,
    distance: chosen.distance,
    bodyDistance,
    confidence,
    fit,
    bodyShape: built.shape,
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
  } else if (garment === GARMENT.BOTTOM) {
    result.waist = waist;
    result.bodyWaist = bodyWaist;
    result.offset = FIT_WAIST_OFFSET[fit];
    result.target = bodyWaist + FIT_WAIST_OFFSET[fit];
    result.waistRange = chosen.waistRange;
  } else {
    result.chest = chest;
    result.bodyChest = bodyChest;
    result.offset = FIT_OFFSET[fit];
    result.target = bodyChest + FIT_OFFSET[fit];
    result.chestRange = chosen.chestRange;
  }
  result.reason = describeRecommendation(result);
  return result;
}

// ── Relative match scores ────────────────────────────────────────────────────
// This is a heuristic score, not a calibrated probability. It answers one
// question — how well does this size's own window cover your numbers? — and
// never claims more than that:
//
//   • inside the window it falls from 97 points at the centre to about 68 at the
//     edge, because a shopper on the edge is one centimetre from the next size;
//   • outside it falls smoothly with an 8-unit distance decay;
//   • the published chart is an estimate from height and weight, not a
//     measurement, so it is capped lower than a window the owner set himself.
//
// The store cannot see the garment on the body, so this relative ranking score
// is never a probability or a guarantee.
const SCORE_CEILING = { ranges: 0.97, chart: 0.9 };
const SCORE_MAX = 97;
const SCORE_RANK_STEP = 2;
const SCORE_DECAY = { ranges: 8, chart: 8 };

function explainCandidate(candidate, ctx) {
  // The sentence describes the same numbers the score was computed from: the
  // fit-adjusted weight in range mode, the fit-adjusted chest in chart mode.
  // It never repeats the size label, because the result already shows it.
  if (ctx.mode === 'ranges') {
    const range = candidate.range;
    const heightWindow = formatWindow(range.minHeight, range.maxHeight, 'cm');
    const weightWindow = formatWindow(range.minWeight, range.maxWeight, 'kg');
    const heightDelta = windowDelta(range.minHeight, range.maxHeight, ctx.height);
    const weightDelta = windowDelta(range.minWeight, range.maxWeight, ctx.effectiveWeight);
    const heightText = heightDelta === 0
      ? `Your ${ctx.height} cm is inside this size's height window (${heightWindow})`
      : `Your ${ctx.height} cm is ${Math.abs(heightDelta)} cm ${heightDelta > 0 ? 'over' : 'under'} this size's height window (${heightWindow})`;
    const weightText = weightDelta === 0
      ? `your ${ctx.effectiveWeight} kg is inside its weight window (${weightWindow})`
      : `your ${ctx.effectiveWeight} kg is ${Math.abs(weightDelta)} kg ${weightDelta > 0 ? 'over' : 'under'} its weight window (${weightWindow})`;
    const nudge = ctx.effectiveWeight !== ctx.weight
      ? ` For a ${ctx.fit} fit we count ${ctx.weight} kg as ${ctx.effectiveWeight} kg.`
      : '';
    return `${heightText}, and ${weightText}.${nudge}`;
  }

  const isBottom = ctx.garment === GARMENT.BOTTOM;
  const [lo, hi] = isBottom ? candidate.waistRange : candidate.chestRange;
  const shapeNudge = isBottom ? shapeWaistOffset(ctx.shape) : shapeChestOffset(ctx.shape, ctx.garment);
  const fitNudge = (isBottom ? FIT_WAIST_OFFSET[ctx.fit] : FIT_OFFSET[ctx.fit]) || 0;
  const causes = [];
  if (shapeNudge) causes.push('your build');
  if (fitNudge) causes.push(`a ${FIT_WORD[ctx.fit] || ctx.fit} fit`);
  const adjusted = causes.length
    ? `, adjusted to ${ctx.target} cm for ${causes.join(' and ')}`
    : '';
  const delta = windowDelta(lo, hi, ctx.target);
  const position = delta === 0
    ? `sits inside this size's ${lo}–${hi} cm cut`
    : `is ${Math.abs(delta)} cm ${delta > 0 ? 'over' : 'under'} this size's ${lo}–${hi} cm cut`;
  const body = isBottom ? `Your ${ctx.waist} cm waist estimate` : `Your ${ctx.chest} cm chest estimate`;
  return `${body}${adjusted} ${position}.`;
}

/**
 * Score every offered size, in the product's own size order.
 *
 * The recommendation comes from `recommendSize`, so the highlighted size is
 * exactly the one the engine would pick — including its stock swap. Scores
 * follow the engine's distance order, using window quality to separate ties.
 */
export function scoreSizes(input = {}) {
  const decision = recommendSize(input);
  if (!decision.ok) return decision;

  const built = buildCandidates(input);
  if (!built.ok) return built;

  const ordered = [...built.candidates].sort(compareCandidates);
  const ceiling = SCORE_CEILING[built.mode] ?? SCORE_CEILING.ranges;
  const decay = SCORE_DECAY[built.mode] ?? SCORE_DECAY.ranges;
  const stockValue = stockReader(input);

  const sizes = ordered.map((candidate, index) => {
    const quality = Number.isFinite(candidate.quality) ? candidate.quality : 1;
    const ceilingScore = 100 * ceiling;
    const edgeScore = ceilingScore * (1 - QUALITY_EDGE_LOSS);
    const raw = candidate.distance === 0
      ? Math.round(ceilingScore * Math.max(0, Math.min(1, quality)))
      : Math.round(edgeScore * Math.exp(-candidate.distance / decay));
    const stock = stockValue(candidate.label);
    return {
      label: candidate.label,
      score: Math.max(1, Math.min(SCORE_MAX, raw - index * SCORE_RANK_STEP)),
      distance: candidate.distance,
      quality,
      inStock: stock === null ? null : stock > 0,
      recommended: candidate.label === decision.size,
      reason: explainCandidate(candidate, built),
    };
  });

  // Keep the product's size order so the chips read XS → 3XL, not best-first.
  sizes.sort((a, b) => built.declaredSizes.indexOf(a.label) - built.declaredSizes.indexOf(b.label));

  return {
    ok: true,
    mode: built.mode,
    garment: built.garment,
    sizes,
    recommended: decision.size,
    decision,
  };
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
      fit: FIT_OPTIONS.includes(parsed.fit) || FIT_OPTIONS_BOTTOM.includes(parsed.fit) ? parsed.fit : 'regular',
      bodyShape: sanitizeBodyShape(parsed.bodyShape),
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
      fit: FIT_OPTIONS.includes(profile.fit) || FIT_OPTIONS_BOTTOM.includes(profile.fit) ? profile.fit : 'regular',
      bodyShape: sanitizeBodyShape(profile.bodyShape),
    }));
    return true;
  } catch (error) {
    return false;
  }
}
