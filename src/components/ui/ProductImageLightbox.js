import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react';
import SafeImage from './SafeImage';
import { focusFirstElement, redirectOutsideFocus, trapTabKey } from '../../lib/focus-trap';

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.5;

/**
 * The product photo opened on a dark stage. One place to zoom in, pan around,
 * and step through the gallery without losing the page underneath.
 *
 * `images` keeps the storefront order; `index` is owned by ProductPage so the
 * gallery and the lightbox always land on the same photo. Escape, the close
 * button and a tap outside all dismiss it, focus stays inside, and the page
 * behind is put back exactly where it was.
 */
export default function ProductImageLightbox({
  images,
  index,
  name,
  fallback,
  onIndexChange,
  onClose,
  returnTo,
}) {
  const photos = (images || []).filter(Boolean);
  const count = photos.length;
  const current = Math.min(Math.max(index || 0, 0), Math.max(count - 1, 0));

  const dialogRef = useRef(null);
  const dragRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const onIndexChangeRef = useRef(onIndexChange);
  onCloseRef.current = onClose;
  onIndexChangeRef.current = onIndexChange;

  const [scale, setScale] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const resetView = () => {
    setScale(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  };

  const move = (direction) => {
    if (count < 2) return;
    resetView();
    onIndexChangeRef.current((current + direction + count) % count);
  };

  const zoomBy = (delta) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((scale + delta) * 10) / 10));
    setScale(next);
    if (next === MIN_ZOOM) setPan({ x: 0, y: 0 });
  };

  const toggleZoom = () => {
    if (scale > MIN_ZOOM) resetView();
    else setScale(2);
  };

  // Keep the key handlers fed with the latest index and zoom without rebinding
  // the document listener (and re-locking the page) on every state change.
  const moveRef = useRef(move);
  const zoomRef = useRef(zoomBy);
  moveRef.current = move;
  zoomRef.current = zoomBy;

  useEffect(() => {
    if (!count) return undefined;

    const opener = returnTo instanceof HTMLElement
      ? returnTo
      : (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    const html = document.documentElement;
    const body = document.body;
    const liveY = typeof window.scrollY === 'number' ? window.scrollY : window.pageYOffset;
    const scrollY = Number.isFinite(liveY) ? liveY : 0;
    const lockedWidth = html.clientWidth;
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
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = `${lockedWidth}px`;
    body.style.overflow = 'hidden';

    focusFirstElement(dialogRef.current);

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (count < 2) return;
        event.preventDefault();
        moveRef.current(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomRef.current(ZOOM_STEP);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomRef.current(-ZOOM_STEP);
        return;
      }
      trapTabKey(event, dialogRef.current);
    };
    const onFocusIn = (event) => redirectOutsideFocus(event, dialogRef.current);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      html.style.overflow = previous.htmlOverflow;
      html.style.scrollBehavior = previous.htmlScrollBehavior;
      body.style.overflow = previous.bodyOverflow;
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
      window.requestAnimationFrame?.(() => window.scrollTo(0, scrollY));
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [count, returnTo]);

  // A new photo always opens at 100% instead of inheriting the previous pan.
  useEffect(() => { resetView(); }, [current]);

  if (!count) return null;

  const limit = 180 * (scale - 1);
  const onPointerDown = (event) => {
    if (scale <= MIN_ZOOM) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    setPan({
      x: Math.max(-limit, Math.min(limit, drag.panX + event.clientX - drag.x)),
      y: Math.max(-limit, Math.min(limit, drag.panY + event.clientY - drag.y)),
    });
  };
  const onPointerUp = (event) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  return createPortal(
    <div
      className="photo-lightbox product-zoom-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="photo-lightbox-frame product-zoom-frame"
        role="dialog"
        aria-modal="true"
        aria-label={`${name || 'Product'} photo ${current + 1} of ${count}`}
        tabIndex={-1}
      >
        <button
          type="button"
          className="photo-lightbox-close"
          onClick={() => onCloseRef.current()}
          aria-label="Close image"
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div
          className="product-zoom-stage"
          data-zoomed={scale > MIN_ZOOM ? 'true' : 'false'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={toggleZoom}
        >
          <SafeImage
            src={photos[current]}
            alt={`${name || 'Product'} — view ${current + 1}`}
            fallback={fallback}
            draggable={false}
            className="product-zoom-img"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
          />
        </div>

        <div className="product-zoom-toolbar" role="group" aria-label="Image controls">
          {count > 1 && (
            <button type="button" onClick={() => move(-1)} aria-label="Previous image">
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} disabled={scale <= MIN_ZOOM} aria-label="Zoom out">
            <ZoomOut size={18} aria-hidden="true" />
          </button>
          <span className="product-zoom-level" aria-live="polite">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={scale >= MAX_ZOOM} aria-label="Zoom in">
            <ZoomIn size={18} aria-hidden="true" />
          </button>
          {count > 1 && (
            <button type="button" onClick={() => move(1)} aria-label="Next image">
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          )}
          {count > 1 && <span className="product-zoom-counter">{current + 1} / {count}</span>}
        </div>
      </div>
    </div>,
    document.body
  );
}
