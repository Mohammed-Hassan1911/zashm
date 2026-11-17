// Regression coverage for the storefront size recommendation engine and the
// "Find my size" UI wiring. Plain Node, no dependencies.
//
// The store is men's only, so there is deliberately no department/gender input.
// The engine has two modes:
//   1. owner ranges — per-size body height/weight windows set in the admin;
//   2. chart — the published chest chart, used when no window exists yet.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BODY_SHAPE_DEFAULT,
  CHEST_SHAPES,
  FIT_OFFSET,
  FIT_WEIGHT_NUDGE,
  WAIST_SHAPES,
  describeRange,
  estimateChest,
  hasOwnerRanges,
  loadFitProfile,
  normalizeSize,
  recommendSize,
  sanitizeBodyShape,
  sanitizeSizeRanges,
  saveFitProfile,
  scoreSizes,
  shapeChestOffset,
  shapeWeightOffset,
  sizeRangeProblems,
  supportsSizeGuidance,
} from '../src/lib/fit.js';

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
  ok(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n[${title}]`);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

// ── Owner windows used across the range-mode tests ──────────────────────────
// Deliberately disjoint so the expected winner is unambiguous.
const OWNER_RANGES = {
  M: { minWeight: 55, maxWeight: 70, minHeight: 160, maxHeight: 175 },
  L: { minWeight: 71, maxWeight: 85, minHeight: 176, maxHeight: 188 },
  XL: { minWeight: 86, maxWeight: 105, minHeight: 180, maxHeight: 205 },
};

section('1 — chest estimate (chart fallback)');
eq(estimateChest({ height: 180, weight: 78 }), 102, '180/78 estimates a 102 cm chest');
eq(estimateChest({ height: 165, weight: 60 }), 91, '165/60 estimates a 91 cm chest');
eq(estimateChest({ height: 100, weight: 78 }), null, 'height below 140 cm is rejected');
eq(estimateChest({ height: 180, weight: 500 }), null, 'weight above 200 kg is rejected');
eq(estimateChest({ height: '175', weight: '70' }), 98, 'numeric strings are accepted');
eq(estimateChest({}), null, 'missing input returns null');

section('2 — size normalisation');
eq(normalizeSize('m'), 'M', 'lowercase letters normalise');
eq(normalizeSize('  L  '), 'L', 'whitespace is trimmed');
eq(normalizeSize('48'), 'M', 'Egyptian numeric 48 maps to M');
eq(normalizeSize(46), 'S', 'numeric 46 maps to S');
eq(normalizeSize('XXL'), 'XXL', 'XXL is supported');
eq(normalizeSize('One Size'), null, 'one-size items are unsupported');
eq(normalizeSize(''), null, 'empty sizes are unsupported');
eq(normalizeSize(null), null, 'null sizes are unsupported');
ok(supportsSizeGuidance(['M', 'One Size']), 'one supported size is enough');
ok(!supportsSizeGuidance(['Free Size']), 'free-size only products are skipped');
ok(supportsSizeGuidance(['One Size'], { 'One Size': { minWeight: 60 } }),
  'an owner window makes an otherwise unsupported label usable');

section('3 — fit offsets (chart mode)');
ok(FIT_OFFSET.slim < FIT_OFFSET.regular && FIT_OFFSET.regular < FIT_OFFSET.relaxed && FIT_OFFSET.relaxed < FIT_OFFSET.oversized,
  'slim < regular < relaxed < oversized');
eq(FIT_OFFSET.regular, 0, 'regular keeps the body estimate');
eq(FIT_WEIGHT_NUDGE.regular, 0, 'regular never shifts the owner windows');
ok(FIT_WEIGHT_NUDGE.slim < FIT_WEIGHT_NUDGE.oversized, 'slim nudges down, oversized nudges up');

section('4 — chart mode: recommendation follows height, weight and fit');
const base = { height: 180, weight: 78, sizes: ['M', 'L', 'XL'] };
eq(recommendSize({ ...base, fit: 'regular' }).size, 'L', '180/78 regular picks L');
eq(recommendSize({ ...base, fit: 'slim' }).size, 'M', '180/78 slim picks M');
eq(recommendSize({ ...base, fit: 'relaxed' }).size, 'XL', '180/78 relaxed picks XL');
eq(recommendSize({ ...base, fit: 'oversized' }).size, 'XL', 'oversized clamps to the largest available size');
eq(recommendSize({ ...base, fit: 'regular' }).confidence, 'high', 'an exact match reports high confidence');
eq(recommendSize({ height: 160, weight: 50, sizes: ['M', 'L'], fit: 'regular' }).confidence, 'low',
  'a far match reports low confidence');
eq(recommendSize({ ...base, fit: 'regular' }).mode, 'chart', 'no owner windows falls back to the chart');
eq(recommendSize({ ...base, fit: 'regular' }).chest, 102, 'the result exposes the estimated chest');
eq(recommendSize({ ...base, fit: 'regular' }).chestRange.join('-'), '102-106', 'the result exposes the chart range');
ok(recommendSize({ ...base, fit: 'regular' }).reason.includes('cut for 102–106 cm'),
  'the chart explanation quotes the same range as the size guide');

section('5 — chart mode: ranges and numeric sizes');
const inRange = recommendSize({ height: 180, weight: 70, sizes: ['M', 'L'], fit: 'regular' });
eq(inRange.chest, 99, '180/70 estimates 99 cm');
eq(inRange.target, 99, 'regular keeps the target at the estimate');
eq(inRange.size, 'M', 'a chest inside the M range picks M');
const numeric = recommendSize({ height: 180, weight: 78, sizes: [46, 48, 50], fit: 'regular' });
eq(numeric.size, '50', 'numeric sizes return the product label, not the letter');

section('6 — owner ranges: closest window wins');
const ranged = { sizes: ['M', 'L', 'XL'], sizeRanges: OWNER_RANGES };
const exact = recommendSize({ ...ranged, height: 180, weight: 78, fit: 'regular' });
eq(exact.mode, 'ranges', 'owner windows switch the engine to range mode');
eq(exact.size, 'L', 'a body inside the L window picks L');
eq(exact.distance, 0, 'inside the window the distance is zero');
eq(exact.range.maxWeight, 85, 'the result exposes the chosen window');
eq(exact.reason, 'Your height and weight are inside the L range (71–85 kg, 176–188 cm) — a regular fit.',
  'the explanation quotes the owner window');

const taller = recommendSize({ ...ranged, height: 190, weight: 78, fit: 'regular' });
eq(taller.size, 'L', 'a 190 cm body stays L when the weight fits better than XL');
eq(taller.distance, 2, 'distance is the height gap above the L window');

const heavier = recommendSize({ ...ranged, height: 180, weight: 100, fit: 'regular' });
eq(heavier.size, 'XL', 'a 100 kg body picks XL');
eq(heavier.distance, 0, 'XL accepts the body without penalty');

const tooSmall = recommendSize({ ...ranged, height: 150, weight: 45, fit: 'regular' });
eq(tooSmall.size, 'M', 'a body below every window still gets the nearest size');
ok(tooSmall.distance > 0, 'a below-range body reports a positive distance');
ok(tooSmall.reason.startsWith('Closest to size M'), 'the explanation says it is the closest match');

section('7 — owner ranges: the fit preference nudges the weight');
// 172/71 sits one kilo above M's window: regular stays M, oversized moves to L.
eq(recommendSize({ ...ranged, height: 172, weight: 71, fit: 'regular' }).size, 'M',
  'regular keeps the boundary customer in M');
eq(recommendSize({ ...ranged, height: 172, weight: 71, fit: 'oversized' }).size, 'L',
  'oversized nudges the boundary customer to L');
eq(recommendSize({ ...ranged, height: 172, weight: 71, fit: 'slim' }).effectiveWeight, 67,
  'slim subtracts the documented nudge');

section('8 — owner ranges: partial windows and fallbacks');
// A single configured size is still used directly (nothing to compare against).
const oneWindow = recommendSize({
  height: 180, weight: 78, fit: 'regular', sizes: ['M', 'L'],
  sizeRanges: { M: { minWeight: 60, maxWeight: 80, minHeight: 170, maxHeight: 190 } },
});
eq(oneWindow.mode, 'ranges', 'one owner window is still range mode');
eq(oneWindow.size, 'M', 'the only configured size is recommended');

// Windows for sizes the product does not sell must not block the chart fallback.
const staleWindow = recommendSize({
  height: 180, weight: 78, fit: 'regular', sizes: ['M', 'L'],
  sizeRanges: { XXL: { minWeight: 90, maxWeight: 110, minHeight: 190, maxHeight: 210 } },
});
eq(staleWindow.mode, 'chart', 'a window for an undeclared size falls back to the chart');
eq(staleWindow.size, 'L', 'the chart still answers');

eq(hasOwnerRanges(OWNER_RANGES), true, 'hasOwnerRanges sees configured windows');
eq(hasOwnerRanges({}), false, 'hasOwnerRanges is false for an empty object');
eq(hasOwnerRanges(null), false, 'hasOwnerRanges tolerates null');

section('9 — range sanitizer');
eq(JSON.stringify(sanitizeSizeRanges(null)), '{}', 'null collapses to an empty object');
eq(JSON.stringify(sanitizeSizeRanges([1, 2])), '{}', 'an array is not a range map');
eq(JSON.stringify(sanitizeSizeRanges({ M: { minWeight: 'abc', maxWeight: 9999 } })), '{}',
  'an entry with no usable bound is dropped');
eq(JSON.stringify(sanitizeSizeRanges({ M: { minWeight: '60', maxWeight: 75.4, minHeight: 165, maxHeight: '180' } })),
  JSON.stringify({ M: { minWeight: 60, maxWeight: 75, minHeight: 165, maxHeight: 180 } }),
  'valid strings are parsed and rounded');
eq(JSON.stringify(sanitizeSizeRanges({ M: { minWeight: 90, maxWeight: 60, minHeight: 190, maxHeight: 170 } })),
  JSON.stringify({ M: { minWeight: 60, maxWeight: 90, minHeight: 170, maxHeight: 190 } }),
  'an inverted pair is swapped as a last resort');
eq(JSON.stringify(sanitizeSizeRanges({ m: { minWeight: 60 } }, ['M'])),
  JSON.stringify({ M: { minWeight: 60, maxWeight: null, minHeight: null, maxHeight: null } }),
  'keys resolve to the product spelling and missing bounds stay null');
eq(JSON.stringify(sanitizeSizeRanges({ M: { minWeight: 60 }, L: { maxWeight: 90 } })),
  JSON.stringify({
    M: { minWeight: 60, maxWeight: null, minHeight: null, maxHeight: null },
    L: { minWeight: null, maxWeight: 90, minHeight: null, maxHeight: null },
  }),
  'one-sided windows are preserved');
eq(JSON.stringify(sanitizeSizeRanges({ M: { minWeight: 20 } })), '{}',
  'bounds outside the accepted window are rejected');

section('10 — admin validation of inverted windows');
eq(JSON.stringify(sizeRangeProblems({ M: { minWeight: 80, maxWeight: 70 } })),
  JSON.stringify(['M: minimum weight is above maximum weight']),
  'an inverted weight pair is reported, not silently swapped');
eq(JSON.stringify(sizeRangeProblems({ L: { minHeight: 190, maxHeight: 170 } })),
  JSON.stringify(['L: minimum height is above maximum height']),
  'an inverted height pair is reported');
eq(sizeRangeProblems({ M: { minWeight: 70, maxWeight: 70, minHeight: 180, maxHeight: 180 } }).length, 0,
  'equal bounds are valid');
eq(JSON.stringify(sizeRangeProblems({ M: { minWeight: 300 } })),
  JSON.stringify(['M: minimum weight must be between 30 and 250 kg']),
  'an out-of-range weight is reported instead of silently dropped');
eq(JSON.stringify(sizeRangeProblems({ M: { maxHeight: 100 } })),
  JSON.stringify(['M: maximum height must be between 120 and 230 cm']),
  'an out-of-range height is reported');
eq(sizeRangeProblems(null).length, 0, 'missing ranges have no problems');
eq(describeRange({ minWeight: 60, maxWeight: 75, minHeight: 165, maxHeight: 180 }), '60–75 kg, 165–180 cm',
  'describeRange formats a full window');
eq(describeRange({ minWeight: 80, maxWeight: null, minHeight: null, maxHeight: 190 }), '80+ kg, up to 190 cm',
  'describeRange formats one-sided windows');

section('11 — stock awareness');
const oosNearest = recommendSize({ ...base, weight: 82, fit: 'regular', stockFor: (size) => ({ M: 5, L: 0, XL: 3 }[size]) });
eq(oosNearest.size, 'L', 'the right size is kept even when it is out of stock');
eq(oosNearest.inStock, false, 'the out-of-stock state is reported');
eq(oosNearest.swappedForStock, false, 'a whole size down is never swapped in for stock');
const nearTie = recommendSize({
  height: 180,
  weight: 78,
  sizes: ['M', 'L'],
  fit: 'regular',
  stockFor: (size) => ({ M: 5, L: 0 }[size]),
});
eq(nearTie.size, 'M', 'an equally good in-stock size replaces an out-of-stock one');
eq(nearTie.skippedSize, 'L', 'the skipped size is reported');
ok(nearTie.swappedForStock, 'the swap is flagged');
const allOut = recommendSize({ ...base, fit: 'regular', stockFor: () => 0 });
eq(allOut.size, 'L', 'with everything out of stock the nearest size is still shown');
eq(allOut.inStock, false, 'the out-of-stock state is reported');
eq(allOut.swappedForStock, false, 'no false swap is reported');
const unknown = recommendSize({ ...base, fit: 'regular' });
eq(unknown.inStock, null, 'unknown stock stays null');

section('12 — invalid requests');
eq(recommendSize({ height: 100, weight: 78, sizes: ['M'] }).reason, 'invalid-body', 'invalid body is rejected');
eq(recommendSize({ height: 180, weight: 78, sizes: ['Free Size'] }).reason, 'unsupported-sizes',
  'unsupported product sizes are rejected');

section('13 — saved profile (no gender)');
const storage = memoryStorage();
ok(saveFitProfile({ height: 180, weight: 78, fit: 'relaxed' }, storage), 'a valid profile is saved');
const loaded = loadFitProfile(storage);
eq(loaded.height, 180, 'height round-trips');
eq(loaded.weight, 78, 'weight round-trips');
eq(loaded.fit, 'relaxed', 'fit round-trips');
eq(loaded.gender, undefined, 'no gender is stored');
eq(loadFitProfile(memoryStorage()), null, 'an empty store returns null');
ok(!saveFitProfile({ height: 10, weight: 78 }, storage), 'out-of-range profiles are refused');
storage.setItem('zashm.fitProfile.v1', '{not json');
eq(loadFitProfile(storage), null, 'corrupt JSON is tolerated');
storage.setItem('zashm.fitProfile.v1', JSON.stringify({ height: 999, weight: 78 }));
eq(loadFitProfile(storage), null, 'out-of-range stored values are ignored');
storage.setItem('zashm.fitProfile.v1', JSON.stringify({ height: 180, weight: 78, fit: 'relaxed', gender: 'women' }));
eq(loadFitProfile(storage).gender, undefined, 'a legacy gender value is ignored, not returned');
eq(loadFitProfile(null), null, 'a missing storage object is tolerated');
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
eq(loadFitProfile(throwing), null, 'storage that throws is tolerated on read');
ok(!saveFitProfile({ height: 180, weight: 78 }, throwing), 'storage that throws is tolerated on write');

section('14 — UI wiring');
const productPage = read('src/pages/ProductPage.js');
const finder = read('src/components/shop/SizeFinder.js');
const admin = read('src/pages/AdminApp.js');
const apiLib = read('api/_lib.js');
const apiProducts = read('api/admin/products.js');
const css = read('src/index.css');
ok(productPage.includes("from '../components/shop/SizeFinder'"), 'the product page imports the finder');
ok(productPage.includes('<SizeFinder'), 'the product page renders the finder');
ok(productPage.includes('sizeRanges={p.sizeRanges}'), 'the finder receives the owner windows');
ok(productPage.includes('stockFor={(size) => sellableStockFor(p, size, selColor)}'),
  'the finder receives live per-colour stock');
ok(finder.includes('aria-live="polite"'), 'the result is announced politely');
ok(finder.includes('noValidate'), 'the finder controls its own validation');
ok(finder.includes('size-finder-input'), 'the inputs are scoped for mobile sizing');
ok(finder.includes('No tape measure needed'), 'the promise of no tape measure is stated');
ok(finder.includes('exchange within 7 days'), 'the exchange reassurance is shown');
ok(finder.includes('{shown.reason}'), 'every size renders its own explanation');
ok(finder.includes('{preferenceExplanation}') && finder.includes('entry.reason'),
  'the selected size explanation updates with its comparison against alternatives');
ok(!finder.includes('Why this size?') && !finder.includes('size-finder-comparisons'),
  'there is no separate explanation block below the result');
ok(finder.includes('resultProfile'), 'the collapsed facts come from the profile that produced the result');
ok(finder.includes('const [result, setResult] = useState(null)'),
  'no recommendation exists before the shopper submits');
ok(finder.includes('const hasResult = Boolean(result) && step === 3;'),
  'the result only shows on the last step');
ok(finder.includes("const stepTitles = ["), 'the flow has three questions');
ok((finder.match(/\{step === \d && \(/g) || []).length === 3, 'three step panels are rendered');
ok(finder.includes('Find my size'), 'the CTA says what the shopper gets');
ok(/label="Height in centimetres"/.test(finder) && /label="Weight in kilograms"/.test(finder),
  'the numeric fields name their unit');
ok(finder.includes('aria-label={label}'), 'the field passes that name to the input');
ok(finder.includes('type="range"'), 'height and weight are sliders');
ok(finder.includes('min={BODY_LIMITS.minHeight}') && finder.includes('max={BODY_LIMITS.maxHeight}'),
  'the height slider uses the engine limits');
ok(finder.includes('min={BODY_LIMITS.minWeight}') && finder.includes('max={BODY_LIMITS.maxWeight}'),
  'the weight slider uses the engine limits');
// The numeric fields must survive typing: clamping on every keystroke rewrites
// "1" into "140" and makes a height like 180 impossible to enter.
ok(finder.includes('function NumberField('), 'the numeric fields keep their own draft');
ok(finder.includes('const [text, setText] = useState(String(value))'),
  'the draft is seeded from the committed value');
ok((finder.match(/<NumberField/g) || []).length === 2,
  'both height and weight use the draft-based field');
ok(/parsed >= min && parsed <= max[\s\S]{0,80}onChange\(Math\.round\(parsed\)\)/.test(finder),
  'only in-range keystrokes move the live value');
ok(/onBlur=\{\(event\) => \{[\s\S]{0,120}commit\(event\.target\.value\)/.test(finder),
  'the draft is clamped when the field loses focus');
ok(/event\.key === 'Enter'[\s\S]{0,200}commit\(event\.currentTarget\.value\)/.test(finder),
  'Enter commits the draft too');
ok(/Math\.min\(max, Math\.max\(min, Math\.round\(parsed\)\)\)/.test(finder),
  'a committed value is clamped into the accepted range');
ok(finder.includes('aria-valuetext={`${height} centimetres`}'), 'the slider announces its value');
ok(finder.includes('CHEST_SHAPES.map') && finder.includes('WAIST_SHAPES.map'),
  'chest and waist are both asked');
ok(finder.includes('FIT_OPTIONS.map'), 'fit is asked');
ok(finder.includes('FIT_HINTS[option]'), 'every fit choice explains itself in place');
ok(finder.includes('BodySilhouette'), 'the live drawing is its own component');
ok(/transform: `scale\(\$\{widthScale\.toFixed\(3\)\}, \$\{heightScale\.toFixed\(3\)\}\)`/.test(finder),
  'the drawing scales with the slider values');
ok(finder.includes('CHEST_WIDTH') && finder.includes('WAIST_WIDTH'),
  'the chest and waist answers reshape the drawing');
ok(finder.includes('MatchGauge'), 'the result renders a circular gauge');
ok(finder.includes('We recommend size <strong>{shown.label}</strong>') && finder.includes('{shown.score}/100 match score'),
  'the result names the recommended size and its relative score');
ok(finder.includes('Fit score, not a fit guarantee.'), 'the score is clearly labelled as an estimate');
ok(finder.includes('scoreBand(shown.score,'), 'the estimated match score also reads as a sentence');
ok(finder.includes('Best available in this colour'),
  'a stock swap is labelled as the best available size, not a rough estimate');
ok(finder.includes('result?.decision?.swappedForStock'), 'the band knows about the stock swap');
ok(finder.includes('{entry.score}/100'), 'every size chip shows a score out of 100');
ok(finder.includes('showRecommendation(option)'), 'choosing a fit immediately shows the recommendation');
ok(!finder.includes("{step < 2 ? 'Next' : 'Find my size'}"), 'the last-step submit button is removed');
ok(finder.includes('onClick={() => setActiveSize(entry.label)}'),
  'the shopper can switch between sizes');
ok(finder.includes('aria-label="Estimated match score for every size, out of 100"'), 'the size chips explain their score to screen readers');
ok(finder.includes('className="size-finder-restart"'), 'the final step offers a restart control');
ok(/\.size-finder-restart\s*\{[^}]*border:\s*1px solid[^}]*border-radius:\s*5px/s.test(css),
  'Start over has a visible, polished border');
ok(finder.includes('className="size-finder-explanation"') &&
   finder.includes('${entry.label} fits better (${entry.score}/100 vs ${shown.score}/100)') &&
   finder.includes('setResultProfile({ height, weight, chest, waist, fit: fitPreference })') && finder.includes('onClick={goBack}'),
  'the reason changes with the chosen size and Back is available at the result actions');
ok(finder.includes('chosen (${recommended.score}/100); next closest ${closest.label} (${closest.score}/100)'),
  'the recommendation comparison stays short and shows relative scores');
const resultActionsStart = finder.lastIndexOf('<div className="size-finder-actions">');
const resultActions = finder.slice(resultActionsStart, resultActionsStart + 1800);
ok(resultActions.includes('Back') && resultActions.includes('Select size ${shown.label}') && resultActions.includes('Size guide'),
  'Back, Select size and Size guide share the final action group');
ok(finder.includes('role="dialog"') && finder.includes('aria-modal="true"'),
  'the flow is a modal dialog');
ok(finder.includes("event.key === 'Escape'"), 'Escape closes the dialog');
ok(finder.includes("body.style.overflow = 'hidden'"), 'the page behind the dialog is locked');
ok(finder.includes("html.style.overflow = 'hidden'") && finder.includes("body.style.position = 'fixed'") &&
   finder.includes('window.scrollTo(0, scrollY)') && finder.includes("body.classList.add('size-finder-open')") &&
   finder.includes("body.classList.remove('size-finder-open')"),
  'opening the finder freezes the page and closing it restores the exact scroll position');
eq((finder.match(/window\.scrollTo\(0, scrollY\)/g) || []).length, 1,
  'the saved scroll position is restored once, without a second animated correction');
ok(finder.indexOf('window.scrollTo(0, scrollY)') < finder.indexOf('html.style.scrollBehavior = previous.htmlScrollBehavior'),
  'scroll is restored before global smooth scrolling is re-enabled');
ok(/\.size-finder-dialog\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s.test(css) &&
   /\.size-finder-overlay\s*\{[^}]*overscroll-behavior:\s*none;/s.test(css),
  'scroll stays inside the finder instead of chaining to the page behind it');
ok(finder.includes('onDialogKeyDown'), 'Tab stays inside the dialog');
ok(finder.includes('inStock === false') && finder.includes('Sold out'),
  'a sold-out size is marked, never recommended as available');
ok(!/>\s*Women\s*</.test(finder) && !/>\s*Men\s*</.test(finder), 'no department choice ships in the finder');
ok(!/'women'|"women"/.test(finder), 'no women branch ships in the finder');
ok(css.includes('.size-finder-input') && /\.size-finder-input\s*\{\s*font-size:\s*16px/.test(css),
  'mobile inputs use 16px to prevent iOS zoom');
ok(/\.size-finder-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/.test(css), 'the dialog declares its layer');
const overlayZ = Number((css.match(/\.size-finder-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/) || [])[1]);
ok(overlayZ > 0 && overlayZ < 30000,
  `the dialog stays below the floating actions (z-index ${overlayZ})`);
ok(/@media \(min-width: 880px\)[\s\S]*?\.size-finder-body\s*\{[\s\S]*?grid-template-columns:/.test(css),
  'the dialog becomes two columns on a wide screen');
ok(css.includes('@media (max-width: 640px)') && css.includes('align-items: flex-end'),
  'phones get a bottom sheet');
ok(css.includes('100dvh'), 'the dialog fits the visible viewport on mobile browsers');
ok(css.includes('env(safe-area-inset-bottom'), 'the sheet clears the phone safe area');
ok(/body\.size-finder-open \.whatsapp-fab\s*\{[^}]*visibility:\s*hidden/.test(css),
  'WhatsApp is hidden only while the size finder is open');
ok(/\.size-finder-dialog::-webkit-scrollbar-thumb\s*\{[^}]*linear-gradient\(180deg, #e8c870, #a98736\)/.test(css) &&
   /\.size-finder-dialog\s*\{[^}]*scrollbar-color:\s*var\(--gold\)/s.test(css),
  'the finder scrollbar is gold on standard and WebKit browsers');
ok(/html\s*\{[^}]*scrollbar-color:\s*var\(--gold\) var\(--bg2\)/s.test(css) &&
   /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--gold\)/.test(css),
  'the site-wide scrollbar is gold outside the finder too');

// On phones the result controls share the bottom action group and the
// explanation stays inside the result panel.
const phoneCss = css.slice(css.indexOf('@media (max-width: 640px)'));
ok(/\.size-finder-restart\s*\{[^}]*justify-self:\s*end/s.test(css),
  'Start over sits on the right at every screen width');
ok(/\.size-finder-explanation\s*\{[^}]*display:\s*grid/.test(css),
  'the comparison explanation stays in the selected-size result area');
ok(/\.size-finder-restart\s*\{[\s\S]{0,60}min-height:\s*44px/.test(css),
  'Start over has a comfortable touch target');
ok(/\.size-finder-restart\s*\{[^}]*animation:\s*size-finder-restart-shine/.test(css) &&
   css.includes('@keyframes size-finder-restart-shine'), 'Start over has a visible, subtle shine');
ok(css.includes('@media (prefers-reduced-motion: reduce)') &&
   /\.size-finder-restart\s*\{\s*animation:\s*none/s.test(css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))),
  'the shine respects reduced-motion preferences');
const toolMarkers = ['open' + 'code', 'chat' + 'gpt', 'clau' + 'de', 'co' + 'pilot'];
ok(!toolMarkers.some((marker) => finder.toLowerCase().includes(marker)), 'no tooling wording ships in the finder');

section('15 — admin windows and server validation');
ok(admin.includes('Size finder windows'), 'the admin form has the per-size windows panel');
ok(admin.includes('sizeRangeProblems'), 'the admin blocks inverted windows before saving');
ok(admin.includes('sizeRanges,'), 'the admin sends sizeRanges with the product payload');
ok(admin.includes('supabase/product_size_ranges.sql'), 'the admin tells the owner which migration to apply');
ok(apiLib.includes('sanitizeSizeRangesInput'), 'the API sanitizes size ranges');
ok(apiProducts.includes("'sizeRanges'"), 'the API persists sizeRanges');
ok(apiProducts.includes('warnings'), 'the API reports a missing-column warning instead of lying');

section('16 — the migration ships the column and exposes it');
const migration = read('supabase/product_size_ranges.sql');
ok(migration.includes('ADD COLUMN IF NOT EXISTS "sizeRanges" jsonb'), 'the migration adds the column');
ok(migration.includes("'sizeRanges'"), 'the view allow-list includes sizeRanges');
ok(migration.includes("'reservedStock' = ANY (v_allow)"), 'the migration fails closed on reservedStock');
ok(/products_sizeRanges_object_chk/.test(migration), 'the migration constrains the column to an object');

section('17 — the live production windows (Jacket-Boxy)');
// Pinned copy of the windows the owner published for product 1794698667338998.
// If these probes ever move, the storefront is recommending a different size
// than the owner intended, so the suite fails loudly.
const LIVE_SIZES = ['M', 'L', 'XL', 'XXL'];
const LIVE_RANGES = {
  M: { minWeight: 60, maxWeight: 75, minHeight: 160, maxHeight: 174 },
  L: { minWeight: 70, maxWeight: 85, minHeight: 170, maxHeight: 185 },
  XL: { minWeight: 80, maxWeight: 90, minHeight: 180, maxHeight: 195 },
  XXL: { minWeight: 85, maxWeight: 110, minHeight: 190, maxHeight: 210 },
};
const live = (height, weight, extra = {}) => recommendSize({
  height, weight, fit: 'regular', sizes: LIVE_SIZES, sizeRanges: LIVE_RANGES, ...extra,
});
const insideLive = (size, height, weight) => {
  const range = LIVE_RANGES[size];
  return weight >= range.minWeight && weight <= range.maxWeight
    && height >= range.minHeight && height <= range.maxHeight;
};

eq(JSON.stringify(sanitizeSizeRanges(LIVE_RANGES, LIVE_SIZES)), JSON.stringify(LIVE_RANGES),
  'every live window survives sanitizing unchanged');

// Sweep the whole plausible body range: whenever a size window contains the
// customer, the engine must return a size that also contains them.
let containmentMisses = 0;
for (let height = 155; height <= 210; height += 5) {
  for (let weight = 55; weight <= 115; weight += 5) {
    const containing = LIVE_SIZES.filter((size) => insideLive(size, height, weight));
    if (!containing.length) continue;
    const result = live(height, weight);
    if (!containing.includes(result.size)) containmentMisses += 1;
  }
}
eq(containmentMisses, 0, 'no body inside a live window is sent to a size outside it');

const probes = [
  [160, 60, 'M', 'the smallest window starts at M'],
  [174, 75, 'L', 'the M/L overlap resolves to the roomier L'],
  [175, 76, 'L', 'just above M stays in L'],
  [180, 78, 'L', 'a tall, light body stays in L'],
  [185, 85, 'XL', 'the L/XL overlap resolves to XL'],
  [190, 90, 'XXL', 'the XL/XXL overlap resolves to XXL'],
  [195, 95, 'XXL', 'above XL the engine moves to XXL'],
  [200, 100, 'XXL', 'the top of the XXL window is still XXL'],
  [210, 110, 'XXL', 'the published maximum is XXL'],
];
for (const [height, weight, size, label] of probes) {
  eq(live(height, weight).size, size, `${height} cm / ${weight} kg → ${size} (${label})`);
}

const below = live(150, 45);
eq(below.size, 'M', 'a body below every window still gets the nearest size');
ok(below.distance > 0, 'the below-range distance is positive');
eq(below.confidence, 'low', 'a body far outside every window reports low confidence');

section('18 — confidence describes the body, not the fit nudge');
// A slim nudge must not make an in-window shopper look like a poor match.
const slimInside = live(185, 72, { fit: 'slim' });
eq(slimInside.size, 'L', 'the slim nudge keeps an L body in L');
eq(slimInside.distance, 2, 'the fit-adjusted distance is the nudged gap');
eq(slimInside.bodyDistance, 0, 'the body itself is inside the window');
eq(slimInside.confidence, 'high', 'an inside-the-window body keeps high confidence');
ok(slimInside.reason.startsWith('Your height and weight are inside the L range'),
  'the explanation still says the body is inside the range');

const regularInside = live(172, 70);
eq(regularInside.confidence, 'high', 'a regular in-window body is a high match');
const nearMiss = live(190, 78);
eq(nearMiss.distance, 2, 'a near miss keeps a small distance');
eq(nearMiss.confidence, 'medium', 'a near miss reports medium confidence');
eq(nearMiss.size, 'XL', 'a near miss moves up to the closer size');
ok(nearMiss.reason.startsWith('Closest to size XL'), 'a near miss is described as the closest size');

section('19 — stock swap uses the live matrix');
// XXL ships only in Burgundy: Black XXL is 0, so the engine must not claim it.
const blackStock = (size) => ({ M: 5, L: 6, XL: 6, XXL: 0 }[size] ?? 0);
const burgundyStock = (size) => ({ M: 4, L: 5, XL: 4, XXL: 8 }[size] ?? 0);

const blackNear = live(192, 92, { stockFor: blackStock });
eq(blackNear.size, 'XL', 'a near-XXL body is offered XL when Black XXL is gone');
eq(blackNear.swappedForStock, true, 'the swap is reported');
eq(blackNear.skippedSize, 'XXL', 'the skipped size is named');
eq(blackNear.inStock, true, 'the offered size is genuinely in stock');

const blackFar = live(196, 96, { stockFor: blackStock });
eq(blackFar.size, 'XXL', 'a far-XXL body is not pushed into a too-small XL');
eq(blackFar.inStock, false, 'the engine admits XXL is sold out in this colour');
eq(blackFar.swappedForStock, false, 'no dishonest swap happens');

const burgundy = live(192, 92, { stockFor: burgundyStock });
eq(burgundy.size, 'XXL', 'Burgundy XXL is offered when it is in stock');
eq(burgundy.inStock, true, 'Burgundy XXL reports in stock');
eq(burgundy.swappedForStock, false, 'no swap is needed when the right size exists');

section('20 — a refresh starts clean');
// The owner asked for the suggested size to disappear on refresh so other
// numbers can be entered. The saved profile may pre-fill the form, but the
// recommendation itself must never be restored on mount.
ok(!finder.includes('initialResult'), 'the finder no longer restores a saved recommendation');
ok(finder.includes('const [result, setResult] = useState(null)'),
  'no recommendation exists before the shopper submits');
ok(finder.includes('const [resultProfile, setResultProfile] = useState(null)'),
  'no result profile exists before the shopper submits');
const scoreCalls = (finder.match(/scoreSizes\(/g) || []).length;
eq(scoreCalls, 1, 'the engine runs only after the last answer is provided');
ok(!finder.includes('useEffect(() => {\n    if (!supported)'), 'no effect computes a size on mount');
ok(finder.includes("const saved = useMemo(() => loadFitProfile(readStorage()), [])"),
  'the saved profile is still read for pre-filling');
ok(finder.includes('clamp(saved.height, BODY_LIMITS.minHeight, BODY_LIMITS.maxHeight)') &&
   finder.includes('clamp(saved.weight, BODY_LIMITS.minWeight, BODY_LIMITS.maxWeight)'),
  'the saved numbers still pre-fill the sliders inside the accepted range');
ok(finder.includes("saved?.bodyShape?.chest || 'average'") &&
   finder.includes("saved?.bodyShape?.waist || 'average'"),
  'the saved shape answers pre-fill too, with neutral defaults');

section('21 — estimated match scores');
const scored = scoreSizes({ height: 180, weight: 78, sizes: ['M', 'L', 'XL'], fit: 'regular' });
eq(scored.ok, true, 'every offered size is scored');
eq(scored.sizes.length, 3, 'one score per size');
eq(scored.recommended, 'L', 'the highest score is the engine recommendation');
const highest = [...scored.sizes].sort((a, b) => b.score - a.score)[0];
eq(highest.label, 'L', 'the recommended size carries the highest score');
ok(scored.sizes.every((entry) => entry.score >= 1 && entry.score <= 97),
  'scores stay within the heuristic scale ceiling');
ok(scored.sizes.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 20),
  'every size explains its own number');
eq(scored.sizes.map((entry) => entry.label).join(','), 'M,L,XL',
  'the chips keep the product size order');
ok(scored.sizes.find((entry) => entry.label === 'L').reason.includes('chest'),
  'the chart reason quotes the chest range');
ok(/^\d+\/100$/.test(`${highest.score}/100`), 'the score is presented out of 100, not as probability');
const byScore = [...scored.sizes].sort((a, b) => b.score - a.score);
ok(byScore[0].distance <= byScore[byScore.length - 1].distance,
  'a higher match score never belongs to a more distant size');

const exactScore = scoreSizes({ height: 182, weight: 78, sizes: ['L'], sizeRanges: OWNER_RANGES });
eq(exactScore.sizes[0].score, 97, 'an exact window match is capped at 97 points');
ok(exactScore.sizes[0].reason.includes('in range'), 'an inside-the-window size is explained plainly');

const farScore = scoreSizes({ height: 160, weight: 50, sizes: ['M', 'L', 'XL'], fit: 'regular' });
ok(farScore.sizes.find((entry) => entry.label === 'M').score > farScore.sizes.find((entry) => entry.label === 'XL').score,
  'closer sizes score higher than distant ones');

const stockScored = scoreSizes({
  height: 180, weight: 78, sizes: ['M', 'L'], fit: 'regular',
  stockFor: (size) => ({ M: 5, L: 0 }[size]),
});
eq(stockScored.recommended, 'M', 'the recommendation still honours the stock swap');
eq(stockScored.sizes.find((entry) => entry.label === 'L').inStock, false,
  'the sold-out size is flagged, not hidden');
eq(scoreSizes({ height: 100, weight: 78, sizes: ['M'] }).reason, 'invalid-body',
  'an impossible body is refused, not scored');

// The sentence under a size must describe the same quantity its score was
// computed from. A relaxed fit adds 6 cm of ease, so a size can be "2 cm over"
// even though the shopper's own chest estimate sits inside its range.
const relaxedScored = scoreSizes({ height: 180, weight: 78, sizes: ['M', 'L', 'XL'], fit: 'relaxed' });
const relaxedL = relaxedScored.sizes.find((entry) => entry.label === 'L');
ok(relaxedL.score < 99, 'a size that only fits with ease is not scored as an exact match');
ok(!relaxedL.reason.includes('inside it'),
  'the reason never claims an exact fit while the score says otherwise');
ok(relaxedL.reason.includes('relaxed'), 'the reason names the selected fit');
ok(relaxedL.reason.includes('+ 6 cm relaxed'), 'the reason explains the ease added for the selected fit');
ok(relaxedL.reason.includes('2 cm over 102–106'), 'the reason states the exact chest-range difference');
eq(relaxedScored.sizes.find((entry) => entry.label === 'XL').score, 83,
  'an in-range chart match away from the centre stays below the ceiling');

// Range mode has the same rule: the fit nudge is applied to the weight, so the
// sentence has to say which weight was measured.
const nudgedScored = scoreSizes({
  height: 180, weight: 84, sizes: ['M', 'L', 'XL'], sizeRanges: OWNER_RANGES, fit: 'relaxed',
});
const nudgedL = nudgedScored.sizes.find((entry) => entry.label === 'L');
ok(nudgedL.reason.includes('87 kg') && nudgedL.reason.includes('relaxed +3 kg'), 'the range reason shows the adjusted comparison weight');
ok(nudgedL.reason.includes('2 kg over 71–85 kg'), 'the range reason states the exact weight difference');
ok(!nudgedL.reason.includes('in range 71–85 kg'),
  'a nudged body outside the window is never described as inside');
ok(nudgedScored.sizes.find((entry) => entry.label === 'XL').reason.includes('in range 86–105 kg'),
  'the roomier size explains that the counted weight fits it');

section('22 — body shape answers');
eq(CHEST_SHAPES.join(','), 'slimmer,average,broader', 'chest has three answers');
eq(WAIST_SHAPES.join(','), 'flatter,average,rounder', 'waist has three answers');
eq(sanitizeBodyShape({ chest: 'broader', waist: 'rounder' }).chest, 'broader', 'known answers survive');
eq(sanitizeBodyShape({ chest: 'wide', waist: 'thick' }).chest, 'average', 'unknown answers fall back');
eq(sanitizeBodyShape(null).waist, 'average', 'missing answers fall back');
eq(shapeChestOffset(BODY_SHAPE_DEFAULT), 0, 'average answers never move the chest estimate');
eq(shapeWeightOffset(BODY_SHAPE_DEFAULT), 0, 'average answers never move the weight');
ok(shapeChestOffset({ chest: 'broader', waist: 'average' }) > 0, 'a broader chest adds cm');
ok(shapeChestOffset({ chest: 'slimmer', waist: 'flatter' }) < 0, 'a slimmer chest removes cm');

// The shape must never override height and weight, only break the boundary.
eq(recommendSize({ ...base, fit: 'regular', bodyShape: BODY_SHAPE_DEFAULT }).size, 'L',
  'neutral answers leave the recommendation untouched');
eq(recommendSize({ ...base, fit: 'regular' }).size,
   recommendSize({ ...base, fit: 'regular', bodyShape: BODY_SHAPE_DEFAULT }).size,
  'omitting the answers is the same as answering average');

const slimBoundary = { height: 180, weight: 78, sizes: ['M', 'L', 'XL'], fit: 'regular' };
eq(recommendSize({ ...slimBoundary, bodyShape: { chest: 'slimmer', waist: 'average' } }).size, 'M',
  'a slimmer chest moves a boundary body down a size');
const heavyBoundary = { height: 180, weight: 84, sizes: ['M', 'L', 'XL'], fit: 'regular' };
eq(recommendSize(heavyBoundary).size, 'L', 'the plain boundary body is L');
eq(recommendSize({ ...heavyBoundary, bodyShape: { chest: 'broader', waist: 'average' } }).size, 'XL',
  'a broader chest moves the same body up a size');

const shapeRangeBase = { ...ranged, height: 178, weight: 66, fit: 'regular' };
eq(recommendSize(shapeRangeBase).size, 'M', 'the plain body sits in M');
eq(recommendSize({ ...shapeRangeBase, bodyShape: { chest: 'broader', waist: 'rounder' } }).size, 'L',
  'a fuller shape moves it to L inside owner windows');

const shapeStorage = memoryStorage();
ok(saveFitProfile({ height: 180, weight: 78, fit: 'relaxed', bodyShape: { chest: 'broader', waist: 'flatter' } }, shapeStorage),
  'the shape answers are saved with the profile');
eq(loadFitProfile(shapeStorage).bodyShape.chest, 'broader', 'the chest answer round-trips');
eq(loadFitProfile(shapeStorage).bodyShape.waist, 'flatter', 'the waist answer round-trips');
shapeStorage.setItem('zashm.fitProfile.v1', JSON.stringify({ height: 180, weight: 78, fit: 'regular' }));
eq(loadFitProfile(shapeStorage).bodyShape.chest, 'average',
  'a profile saved before this change still loads with neutral answers');

section('23 — Jacket Boxy owner windows shared by the storefront');
const JACKET_BOXY_RANGES = {
  M: { minWeight: 50, maxWeight: 65, minHeight: 155, maxHeight: 160 },
  L: { minWeight: 60, maxWeight: 70, minHeight: 160, maxHeight: 170 },
  XL: { minWeight: 65, maxWeight: 72, minHeight: 170, maxHeight: 177 },
  XXL: { minWeight: 76, maxWeight: 85, minHeight: 177, maxHeight: 180 },
};
const jacketSizes = Object.keys(JACKET_BOXY_RANGES);
const jacketFit = (height, weight, fit = 'regular') => scoreSizes({
  height, weight, fit, sizes: jacketSizes, sizeRanges: JACKET_BOXY_RANGES,
});
for (const [size, height, weight] of [
  ['M', 158, 57], ['L', 165, 65], ['XL', 174, 69], ['XXL', 179, 80],
]) {
  const result = jacketFit(height, weight);
  eq(result.recommended, size, `${height} cm / ${weight} kg → ${size} in its owner window`);
  ok(result.sizes.every((entry) => entry.score < 100), `${size} shows relative points, never 100% certainty`);
}
eq(jacketFit(160, 65).recommended, 'L', 'the shared M/L boundary resolves to L');
eq(jacketFit(170, 70).recommended, 'XL', 'the shared L/XL boundary resolves to XL');
eq(jacketFit(177, 74).recommended, 'XXL', '177 cm just below the XXL weight window picks the nearest size');
const jacketRelaxed = jacketFit(165, 65, 'relaxed');
eq(jacketRelaxed.recommended, 'L', 'relaxed preference is applied before scoring');
ok(jacketRelaxed.sizes.find((entry) => entry.label === 'L').reason.includes('relaxed +3 kg'),
  'the result text names the 3 kg relaxed-fit adjustment');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
