// Shared, dependency-free maths for the two product-photo zoom stages: the
// in-place gallery pinch and the full-screen lightbox. Keeping it pure makes the
// gesture testable in plain Node and guarantees both stages feel identical.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;

/** Clamp any proposed scale into the readable range. */
export const clampZoom = (value) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(value) ? value : MIN_ZOOM));

/** Straight-line distance between two touch/pointer points. */
export const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Midpoint between two touch/pointer points — the pinch anchor. */
export const pointMidpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Keep a zoomed photo from being dragged completely out of its frame. The
 * allowed travel grows with the scale, so at 1x the photo is locked centred and
 * at 3x it can be panned across the whole enlarged surface.
 */
export const clampPan = (pan, scale, width, height) => {
  const safeScale = clampZoom(scale);
  const maxX = (Math.max(0, width) * (safeScale - 1)) / 2;
  const maxY = (Math.max(0, height) * (safeScale - 1)) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, Number.isFinite(pan.x) ? pan.x : 0)),
    y: Math.max(-maxY, Math.min(maxY, Number.isFinite(pan.y) ? pan.y : 0)),
  };
};

/** Snap tiny residual zoom back to 1x so a pinch cannot leave a 1.03x blur. */
export const settleZoom = (view) =>
  view.scale <= 1.05 ? { scale: MIN_ZOOM, x: 0, y: 0 } : view;
