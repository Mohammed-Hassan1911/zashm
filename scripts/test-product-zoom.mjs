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
const css = await read('src/index.css');

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
    assert.ok(/const MIN_ZOOM = 1;/.test(lightbox));
    assert.ok(/const MAX_ZOOM = 3;/.test(lightbox));
    assert.ok(/Math\.min\(MAX_ZOOM, Math\.max\(MIN_ZOOM/.test(lightbox));
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
    assert.ok(/className="photo-lightbox product-zoom-lightbox"/.test(lightbox));
    assert.ok(/\.photo-lightbox \{[^}]*z-index: 12000;/.test(css));
  });
  check('reduced motion drops the easing but not the zoom', () => {
    assert.ok(/\.product-zoom-img \{ transition: none !important; \}/.test(css));
  });
}

console.log(`product-zoom: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
