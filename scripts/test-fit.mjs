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
  FIT_OFFSET,
  FIT_WEIGHT_NUDGE,
  describeRange,
  estimateChest,
  hasOwnerRanges,
  loadFitProfile,
  normalizeSize,
  recommendSize,
  sanitizeSizeRanges,
  saveFitProfile,
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
ok(finder.includes('exchange within 4 days'), 'the exchange reassurance is shown');
ok(finder.includes('{result.reason}'), 'the component renders the engine explanation');
ok(finder.includes('Why this size?'), 'the long explanation sits behind a disclosure');
ok(finder.includes('resultProfile'), 'the collapsed facts come from the profile that produced the result');
ok(!/buildReason|inferGender/.test(finder), 'the component no longer builds its own reason or gender');
ok(!/>\s*Women\s*</.test(finder) && !/>\s*Men\s*</.test(finder), 'no department choice ships in the finder');
ok(!/'women'|"women"/.test(finder), 'no women branch ships in the finder');
ok(css.includes('.size-finder-input') && /\.size-finder-input\s*\{\s*font-size:\s*16px/.test(css),
  'mobile inputs use 16px to prevent iOS zoom');
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
