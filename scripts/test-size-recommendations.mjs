#!/usr/bin/env node
// Focused tests for Smart Size Recommendations
import { recommendSize, isSizeAvailable, getAvailableSizes } from '../src/lib/sizeRecommendation.js';

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log('  PASS:', name);
    passed++;
  } else {
    console.log('  FAIL:', name);
    failed++;
  }
}

console.log('=== Size Recommendations Tests ===\n');

// 1. One unique perfect match
{
  console.log('1) Unique perfect match');
  const product = {
    sizes: ['S', 'M', 'L'],
    colors: ['Black'],
    variantStock: { 'S-Black': 5, 'M-Black': 0, 'L-Black': 0 },
    sizeRecommendations: {
      S: { heightMin: 170, heightMax: 175, weightMin: 65, weightMax: 72 },
      M: { heightMin: 176, heightMax: 180, weightMin: 73, weightMax: 80 }
    }
  };
  const res = recommendSize(product, { height: 172, weight: 68, color: 'Black' });
  assert('unique match returns success', res.success === true);
  assert('recommends S', res.size === 'S');
  assert('no alternatives on unique match', !res.alternatives || res.alternatives.length === 0);
}

// 2. Multiple perfect matches returning ambiguous result
{
  console.log('\n2) Multiple perfect matches -> ambiguous');
  const product = {
    sizes: ['M', 'L'],
    colors: ['Black'],
    variantStock: { 'M-Black': 3, 'L-Black': 2 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 },
      L: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  const res = recommendSize(product, { height: 177, weight: 72, color: 'Black' });
  assert('ambiguous returns not success', res.success === false);
  assert('ambiguous reason', res.reason === 'ambiguous');
  assert('has matchingSizes', Array.isArray(res.matchingSizes));
  assert('matchingSizes contains both', res.matchingSizes && res.matchingSizes.includes('M') && res.matchingSizes.includes('L'));
  assert('has alternatives', Array.isArray(res.alternatives) && res.alternatives.length === 2);
}

// 3. No perfect match, partial matches only
{
  console.log('\n3) Partial matches only -> no confident recommendation');
  const product = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  const res = recommendSize(product, { height: 177, weight: 65, color: 'Black' }); // height ok, weight low
  assert('partial match not recommended', res.success === false);
  assert('no confident recommendation message', /confident|size guide/i.test(res.message));
}

// 4. Invalid user measurements
{
  console.log('\n4) Invalid user measurements');
  const product = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('negative height invalid', recommendSize(product, { height: -1, weight: 70 }).success === false);
  assert('zero weight invalid', recommendSize(product, { height: 175, weight: 0 }).success === false);
  assert('non-numeric invalid', recommendSize(product, { height: 'abc', weight: 70 }).success === false);
  assert('out of sanity range', recommendSize(product, { height: 100, weight: 70 }).success === false);
}

// 5. Missing and incomplete recommendation data
{
  console.log('\n5) Missing/incomplete recommendation data');
  const product1 = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    sizeRecommendations: {}
  };
  assert('no recommendations configured', recommendSize(product1, { height: 177, weight: 72 }).success === false && /not configured|size guide/i.test(recommendSize(product1, { height: 177, weight: 72 }).message));
  
  const product2 = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180 } // missing weight
    }
  };
  assert('incomplete data not used', recommendSize(product2, { height: 177, weight: 72 }).success === false);
}

// 6. Invalid ranges, including min > max
{
  console.log('\n6) Invalid ranges');
  const product = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 5 },
    sizeRecommendations: {
      M: { heightMin: 180, heightMax: 175, weightMin: 70, weightMax: 75 } // min > max
    }
  };
  assert('min > max ignored', recommendSize(product, { height: 177, weight: 72 }).success === false);
}

// 7. Unavailable matching size
{
  console.log('\n7) Unavailable matching size');
  const product = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 0 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('out of stock not recommended', recommendSize(product, { height: 177, weight: 72 }).success === false);
}

// 8. Selected-color stock checks
{
  console.log('\n8) Selected color stock checks');
  const product = {
    sizes: ['M'],
    colors: ['Black', 'White'],
    variantStock: { 'M-Black': 0, 'M-White': 5 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('selected color Black unavailable', recommendSize(product, { height: 177, weight: 72, color: 'Black' }).success === false);
  assert('selected color White available', recommendSize(product, { height: 177, weight: 72, color: 'White' }).success === true);
}

// 9. Unselected-color checks where any available color may qualify
{
  console.log('\n9) Unselected color - any available color qualifies');
  const product = {
    sizes: ['M'],
    colors: ['Black', 'White'],
    variantStock: { 'M-Black': 0, 'M-White': 3 },
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('no color selected finds available in White', recommendSize(product, { height: 177, weight: 72 }).success === true);
}

// 10. Legacy global-stock fallback when variantStock is absent
{
  console.log('\n10) Legacy global stock fallback');
  const product = {
    sizes: ['M'],
    colors: [],
    stock: 5,
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('legacy stock allows recommendation', recommendSize(product, { height: 177, weight: 72 }).success === true);
  
  const product2 = {
    sizes: ['M'],
    colors: [],
    stock: 0,
    sizeRecommendations: {
      M: { heightMin: 175, heightMax: 180, weightMin: 70, weightMax: 75 }
    }
  };
  assert('legacy stock zero not recommended', recommendSize(product2, { height: 177, weight: 72 }).success === false);
}

// 11. isSizeAvailable
{
  console.log('\n11) isSizeAvailable utility');
  const product = {
    sizes: ['M'],
    colors: ['Black'],
    variantStock: { 'M-Black': 2 }
  };
  assert('available with stock', isSizeAvailable(product, 'M', 'Black') === true);
  assert('unavailable when zero', isSizeAvailable({ ...product, variantStock: { 'M-Black': 0 } }, 'M', 'Black') === false);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
