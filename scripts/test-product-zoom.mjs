import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
};

const page = await read('src/pages/ProductPage.js');
const card = await read('src/components/shop/ProductCard.js');
const lightbox = await read('src/components/ui/ProductImageLightbox.js');
const gesture = await read('src/lib/zoomGesture.mjs');
const css = await read('src/index.css');
const pkg = JSON.parse(await read('package.json'));
const {
  MIN_ZOOM, MAX_ZOOM, clampZoom, clampPan, pointDistance, pointMidpoint, settleZoom,
} = await import('../src/lib/zoomGesture.mjs');

console.log('[1] the gallery opens an accessible zoom stage');
{
  check('the lightbox component is imported and rendered only when open', () => {
    assert.ok(/import ProductImageLightbox from '..\/components\/ui\/ProductImageLightbox'/.test(page));
    assert.ok(/\{zoomOpen && \(\s*<ProductImageLightbox/.test(page));
  });
  check('the stage receives the gallery order and hands the index back', () => {
    assert.ok(/images=\{productImages\}/.test(page));
    assert.ok(/index=\{imgIdx\}/.test(page));
    assert.ok(/onIndexChange=\{setImgIdx\}/.test(page));
    assert.ok(/returnTo=\{zoomOpenerRef\.current\}/.test(page));
  });
  check('the image and a labelled button both open it', () => {
    assert.ok(/cursor: 'zoom-in'/.test(page));
    assert.ok(/aria-label="Zoom image"/.test(page));
    assert.ok(/aria-haspopup="dialog"/.test(page));
    assert.ok(/onClick=\{\(event\) => \{\s*event\.stopPropagation\(\); openZoom\(event\.currentTarget\); \}\}/.test(page));
  });
  check('focus always returns to the real button, never the bare image box', () => {
    assert.ok(/const zoomButtonRef = useRef\(null\)/.test(page));
    assert.ok(/ref=\{zoomButtonRef\}/.test(page));
    assert.ok(/zoomOpenerRef\.current = opener \|\| zoomButtonRef\.current;/.test(page));
  });
  check('a touch swipe does not open the stage on release', () => {
    assert.ok(/imageSwipedRef\.current = true;/.test(page));
    assert.ok(/if \(imageSwipedRef\.current\) \{ imageSwipedRef\.current = false; return; \}/.test(page));
  });
  check('changing product closes the stage', () => {
    assert.ok(/setImgIdx\(0\);\s*setZoomOpen\(false\);/.test(page));
  });
}

console.log('[2] the lightbox itself is modal, navigable and zoomable');
{
  check('it portals to the body with a labelled dialog', () => {
    assert.ok(/createPortal\(/.test(lightbox));
    assert.ok(/document\.body/.test(lightbox));
    assert.ok(/role="dialog"/.test(lightbox));
    assert.ok(/aria-modal="true"/.test(lightbox));
    assert.ok(/aria-label=\{`\$\{name \|\| 'Product'\} photo/.test(lightbox));
  });
  check('focus is trapped, restored, and the page behind is locked', () => {
    assert.ok(/focusFirstElement\(dialogRef\.current\)/.test(lightbox));
    assert.ok(/trapTabKey\(event, dialogRef\.current\)/.test(lightbox));
    assert.ok(/redirectOutsideFocus\(event, dialogRef\.current\)/.test(lightbox));
    assert.ok(/document\.addEventListener\('focusin', onFocusIn, true\)/.test(lightbox));
    assert.ok(/body\.style\.position = 'fixed'/.test(lightbox));
    assert.ok(/if \(opener && document\.contains\(opener\)\) opener\.focus\(\{ preventScroll: true \}\)/.test(lightbox));
    assert.ok(/onCloseRef\.current\(\)/.test(lightbox));
  });
  check('Escape, arrows and the keyboard zoom keys are handled', () => {
    assert.ok(/event\.key === 'Escape'/.test(lightbox));
    assert.ok(/event\.key === 'ArrowLeft' \|\| event\.key === 'ArrowRight'/.test(lightbox));
    assert.ok(/event\.key === '\+' \|\| event\.key === '='/.test(lightbox));
    assert.ok(/event\.key === '-' \|\| event\.key === '_'/.test(lightbox));
  });
  check('zoom is bounded and a new photo starts at 100%', () => {
    assert.ok(/from '\.\.\/\.\.\/lib\/zoomGesture\.mjs'/.test(lightbox));
    assert.ok(/useEffect\(\(\) => \{ resetView\(\); \}, \[current\]\);/.test(lightbox));
  });
  check('panning is clamped and double click toggles', () => {
    assert.ok(/setPointerCapture/.test(lightbox));
    assert.ok(/Math\.max\(-limit, Math\.min\(limit/.test(lightbox));
    assert.ok(/onDoubleClick=\{toggleZoom\}/.test(lightbox));
  });
  check('every control has a name and the zoom level is announced', () => {
    for (const label of ['Close image', 'Previous image', 'Next image', 'Zoom out', 'Zoom in']) {
      assert.ok(lightbox.includes(`aria-label="${label}"`), label);
    }
    assert.ok(/className="product-zoom-level" aria-live="polite"/.test(lightbox));
  });
}

console.log('[3] only the two card photos get the top mat');
{
  check('the card still has only the primary and hover photo slots', () => {
    assert.equal((card.match(/className="product-card-img"/g) || []).length, 2);
    assert.ok(!/data-card-photo/.test(card), 'the selector lives in CSS, not in the markup');
  });
  check('the mat targets only those two photos and leaves the badge welded to the corner', () => {
    assert.ok(/--card-headroom: 24px;/.test(css));
    assert.ok(/\.product-card-image > \.product-card-img:nth-of-type\(-n\+2\) \{[^}]*top: var\(--card-headroom/.test(css));
    assert.ok(/\.product-card-image > \.product-card-img:nth-of-type\(-n\+2\) \{[^}]*height: calc\(100% - var\(--card-headroom/.test(css));
    assert.ok(/\.product-card-image > \.product-card-img:nth-of-type\(-n\+2\) \{[^}]*object-position: center top;/.test(css));
    assert.ok(/\.product-card-labels \{[^}]*top:\s*0;[^}]*left:\s*0;[^}]*padding:\s*0;/.test(css));
  });
  check('phones get a smaller mat, never no mat', () => {
    assert.ok(/@media \(max-width: 768px\) \{\s*\.product-card-image \{ --card-headroom: 20px; \}/.test(css));
    assert.ok(/@media \(max-width: 360px\) \{\s*\.product-card-image \{ --card-headroom: 18px; \}/.test(css));
  });
}

console.log('[4] the zoom chrome fits the brand and stays below floating actions');
{
  check('the trigger and toolbar keep 44px touch targets and gold focus', () => {
    assert.ok(/\.product-zoom-trigger \{[^}]*width: 44px;[^}]*height: 44px;/.test(css));
    assert.ok(/\.product-zoom-toolbar button \{[^}]*width: 44px;[^}]*height: 44px;/.test(css));
    assert.ok(/\.product-zoom-trigger:focus-visible/.test(css));
    assert.ok(/\.product-zoom-toolbar button:focus-visible/.test(css));
  });
  check('the stage shares the existing dark lightbox ground', () => {
    assert.ok(/className=\{`photo-lightbox product-zoom-lightbox/.test(lightbox));
    assert.ok(/\.photo-lightbox \{[^}]*z-index: 12000;/.test(css));
  });
  check('reduced motion drops the easing but not the zoom', () => {
    assert.ok(/\.product-zoom-img \{ transition: none !important; \}/.test(css));
  });
}

console.log('[5] shared pinch maths are bounded and anchored');
{
  check('the range is 1x to 3x and never accepts NaN', () => {
    assert.ok(!/^\s*import\s/m.test(gesture), 'the gesture module stays dependency-free');
    assert.equal(MIN_ZOOM, 1);
    assert.equal(MAX_ZOOM, 3);
    assert.equal(clampZoom(2.4), 2.4);
    assert.equal(clampZoom(9), 3);
    assert.equal(clampZoom(-2), 1);
    assert.equal(clampZoom(Number.NaN), 1);
  });
  check('distance and midpoint anchor the gesture between two fingers', () => {
    assert.equal(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    assert.deepEqual(pointMidpoint({ x: 10, y: 20 }, { x: 30, y: 40 }), { x: 20, y: 30 });
  });
  check('pan cannot drag a zoomed print out of its frame', () => {
    assert.deepEqual(clampPan({ x: 40, y: 40 }, 1, 100, 100), { x: 0, y: 0 });
    assert.deepEqual(clampPan({ x: 40, y: -40 }, 2, 100, 100), { x: 40, y: -40 });
    assert.deepEqual(clampPan({ x: 400, y: -400 }, 2, 100, 100), { x: 50, y: -50 });
    assert.deepEqual(clampPan({ x: Number.NaN, y: Number.NaN }, 2, 100, 100), { x: 0, y: 0 });
  });
  check('a tiny pinch settles back to a sharp 1x', () => {
    assert.deepEqual(settleZoom({ scale: 1.03, x: 2, y: -1 }), { scale: 1, x: 0, y: 0 });
    assert.deepEqual(settleZoom({ scale: 1.6, x: 12, y: -8 }), { scale: 1.6, x: 12, y: -8 });
  });
}

console.log('[6] the gallery stays calm: zoom belongs to the full-screen stage');
{
  check('no in-place zoom or browser page-zoom listeners remain', () => {
    assert.ok(!/galleryZoom|galleryMainRef|pinchRef/.test(page));
    assert.ok(!/zoomGesture/.test(page));
    assert.ok(!/addEventListener\(['"]touch/.test(page));
    assert.ok(/touchAction: 'pan-y'/.test(page), 'one finger can still scroll the page');
  });
  check('one finger swipes the strip while a vertical scroll still wins', () => {
    assert.ok(/if \(!start \|\| start\.pointerId !== event\.pointerId\) return;/.test(page));
    assert.ok(/Math\.abs\(deltaX\) < 8 \|\| Math\.abs\(deltaX\) <= Math\.abs\(deltaY\)/.test(page));
    assert.ok(/if \(productImages\.length < 2\) return;/.test(page));
    assert.ok(/cursor: 'zoom-in'/.test(page));
  });
  check('a tap on the photo or the + button opens the same viewer', () => {
    assert.ok(/if \(imageSwipedRef\.current\) \{ imageSwipedRef\.current = false; return; \}/.test(page));
    assert.ok(/openZoom\(\);/.test(page));
    assert.ok(/aria-label="Zoom image"/.test(page));
  });
  check('the zoom indicator now belongs to the stage, not the gallery', () => {
    assert.ok(/data-zoomed=\{scale > MIN_ZOOM \? 'true' : 'false'\}/.test(lightbox));
    assert.ok(!/data-zoomed/.test(page));
  });
}

console.log('[7] the lightbox also accepts a two-finger pinch');
{
  check('all active pointers are tracked on the touch-action:none stage', () => {
    assert.ok(/const pointersRef = useRef\(new Map\(\)\)/.test(lightbox));
    assert.ok(/pointersRef\.current\.set\(event\.pointerId, \{[\s\S]{0,120}?x: event\.clientX,[\s\S]{0,80}?y: event\.clientY,/.test(lightbox));
    assert.ok(/touch-action: none;/.test(css));
  });
  check('the second finger anchors a pinch instead of panning', () => {
    assert.ok(/if \(pointersRef\.current\.size === 2\) \{/.test(lightbox));
    assert.ok(/pinchRef\.current = \{/.test(lightbox));
    assert.ok(/dragRef\.current = null;/.test(lightbox));
    assert.ok(/if \(pinch && pointersRef\.current\.size >= 2\) \{/.test(lightbox));
  });
  check('pinch output is clamped and settles on release', () => {
    assert.ok(/const nextScale = clampZoom\(pinch\.startScale \* \(pointDistance\(a, b\) \/ pinch\.startDist\)\)/.test(lightbox));
    assert.ok(/const nextPan = clampPan\(\{/.test(lightbox));
    assert.ok(/const settled = settleZoom\(\{ scale: scaleRef\.current, x: pan\.x, y: pan\.y \}\)/.test(lightbox));
    assert.ok(/pointersRef\.current\.delete\(event\.pointerId\)/.test(lightbox));
  });
  check('the viewer eases in and out instead of blinking', () => {
    assert.ok(/\.product-zoom-lightbox \{[^}]*opacity: 0;[^}]*transition: opacity 260ms/.test(css));
    assert.ok(/\.product-zoom-lightbox\.is-entered \{ opacity: 1; \}/.test(css));
    assert.ok(/\.product-zoom-lightbox\.is-closing/.test(css));
    assert.ok(/\.product-zoom-frame \{[^}]*transform: translateY\(14px\) scale\(0\.965\)/.test(css));
    assert.ok(/const CLOSE_MS = 220/.test(lightbox));
    assert.ok(/is-entered/.test(lightbox) && /is-closing/.test(lightbox));
    assert.ok(/closeRequestRef\.current\(\)/.test(lightbox));
  });
  check('photos crossfade and zoom eases, but never while a finger moves it', () => {
    assert.ok(/\.product-zoom-img \{[^}]*opacity: 0;/.test(css));
    assert.ok(/\.product-zoom-img\.is-visible \{ opacity: 1; \}/.test(css));
    assert.ok(/key=\{current\}/.test(lightbox));
    assert.ok(/className=\{`product-zoom-img\$\{photoVisible \? ' is-visible' : ''\}`\}/.test(lightbox));
    assert.ok(/transition: opacity 280ms ease-out, transform 320ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(css));
    assert.ok(/\.product-zoom-img\[data-interacting='true'\] \{ transition: none; \}/.test(css));
    assert.ok(/data-interacting=\{interacting \? 'true' : 'false'\}/.test(lightbox));
    assert.ok(/setInteracting\(true\)/.test(lightbox) && /setInteracting\(false\)/.test(lightbox));
  });
  check('double-tap zooms about the tapped point', () => {
    assert.ok(/const DOUBLE_TAP_ZOOM = 2\.4/.test(lightbox));
    assert.ok(/toggleZoomAt\(event\.clientX, event\.clientY\)/.test(lightbox));
    assert.ok(/zoomTo\(DOUBLE_TAP_ZOOM, \{ x, y \}\)/.test(lightbox));
    assert.ok(/ignoreDblClickRef/.test(lightbox));
  });
  check('no runtime dependency was added for the gesture', () => {
    for (const name of ['react', 'react-dom', 'framer-motion', 'lucide-react', 'zustand', '@supabase/supabase-js', 'papaparse', 'recharts']) {
      assert.ok(pkg.dependencies[name], name);
    }
    assert.equal(Object.keys(pkg.dependencies).length, 8);
  });
}

console.log(`product-zoom: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
