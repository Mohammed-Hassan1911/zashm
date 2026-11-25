import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'framer-motion';
import { X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react';
import SafeImage from './SafeImage';
import { focusFirstElement, redirectOutsideFocus, trapTabKey } from '../../lib/focus-trap';
import {
  MIN_ZOOM, MAX_ZOOM, clampZoom, clampPan,
  pointDistance, pointMidpoint, settleZoom,
} from '../../lib/zoomGesture.mjs';

const ZOOM_STEP = 0.5;
const DOUBLE_TAP_ZOOM = 2.4;
const CLOSE_MS = 220;

/**
 * A quiet, full-screen product viewer — the same shape luxury storefronts use.
 *
 * Tapping the photo (or the + button on the gallery) opens it on a dark stage.
 * The veil fades in while the frame eases up, photos crossfade as you step
 * through them, and zoom is always animated — except while a finger is actually
 * moving the image, where the transform follows it with no easing to chase.
 * Pinch, double-tap, drag, keyboard and buttons all share the same bounded
 * maths, so the view can never stray outside the frame. Escape, the close
 * button and a tap outside dismiss it, focus stays inside, and the page behind
 * is put back exactly where it was.
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
  const reduceMotion = useReducedMotion();

  const dialogRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  // Every active pointer is tracked so a two-finger pinch can zoom and pan the
  // stage with the same maths as the gallery used to. touch-action: none on the
  // stage means the browser never steals the gesture for its own page zoom.
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(null);
  const lastTapRef = useRef(null);
  const ignoreDblClickRef = useRef(0);
  const scaleRef = useRef(MIN_ZOOM);
  const onCloseRef = useRef(onClose);
  const onIndexChangeRef = useRef(onIndexChange);
  onCloseRef.current = onClose;
  onIndexChangeRef.current = onIndexChange;

  const [scale, setScale] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [interacting, setInteracting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const [photoVisible, setPhotoVisible] = useState(false);
  scaleRef.current = scale;

  const resetView = () => {
    setScale(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  };

  const move = (direction) => {
    if (count < 2) return;
    resetView();
    onIndexChangeRef.current((current + direction + count) % count);
  };

  // Zoom about a screen point: the pixel under that point stays put, which is
  // what makes button, double-tap and pinch zoom feel anchored instead of
  // jumping. Without an anchor the stage centre owns the zoom.
  const zoomTo = (value, anchor) => {
    const target = clampZoom(value);
    if (target === MIN_ZOOM) {
      resetView();
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    if (!anchor || !rect) {
      setScale(target);
      return;
    }
    const from = scaleRef.current;
    const ratio = target / from;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const nextPan = clampPan({
      x: (anchor.x - cx) * (1 - ratio) + ratio * pan.x,
      y: (anchor.y - cy) * (1 - ratio) + ratio * pan.y,
    }, target, rect.width, rect.height);
    setScale(target);
    setPan(nextPan);
  };

  const zoomBy = (delta) => {
    const next = clampZoom(Math.round((scale + delta) * 10) / 10);
    const rect = stageRef.current?.getBoundingClientRect();
    zoomTo(next, rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null);
  };

  const toggleZoomAt = (x, y) => {
    ignoreDblClickRef.current = Date.now();
    if (scaleRef.current > MIN_ZOOM + 0.05) resetView();
    else zoomTo(DOUBLE_TAP_ZOOM, { x, y });
  };

  // Kept for the explicit double-click affordance on pointer devices. A touch
  // double-tap is handled below and marks itself so the follow-up dblclick does
  // not toggle the view straight back again.
  const toggleZoom = () => {
    if (Date.now() - ignoreDblClickRef.current < 500) return;
    if (scaleRef.current > MIN_ZOOM) resetView();
    else zoomTo(DOUBLE_TAP_ZOOM);
  };

  // An unmount is the real close; this only gives the exit easing time to run.
  const closeTimerRef = useRef(null);
  const requestClose = () => {
    if (closing) return;
    if (reduceMotion) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), CLOSE_MS);
  };
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  // Keep the key handlers fed with the latest actions without rebinding the
  // document listener (and re-locking the page) on every state change.
  const moveRef = useRef(move);
  const zoomRef = useRef(zoomBy);
  const closeRequestRef = useRef(requestClose);
  moveRef.current = move;
  zoomRef.current = zoomBy;
  closeRequestRef.current = requestClose;

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
        closeRequestRef.current();
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

  // Flip the entrance classes one task after mount so the browser paints the
  // resting frame first and the transition has something to ease from. With
  // reduced motion the flip is immediate; the stylesheet drops the easing.
  useEffect(() => {
    const timer = window.setTimeout(() => setEntered(true), reduceMotion ? 0 : 20);
    return () => window.clearTimeout(timer);
  }, [reduceMotion]);
  useEffect(() => {
    setPhotoVisible(false);
    const timer = window.setTimeout(() => setPhotoVisible(true), reduceMotion ? 0 : 20);
    return () => window.clearTimeout(timer);
  }, [current, reduceMotion]);

  if (!count) return null;

  const limit = 180 * (scale - 1);
  const onPointerDown = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setInteracting(true);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    });
    // The second finger turns the drag into a pinch, anchored on the midpoint
    // between the two fingers. A new photo always starts this at 100%.
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        startDist: Math.max(1, pointDistance(a, b)),
        startMid: pointMidpoint(a, b),
        startScale: scaleRef.current,
        startPan: { ...pan },
      };
      dragRef.current = null;
      lastTapRef.current = null;
      return;
    }
    if (scale <= MIN_ZOOM) return;
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  };
  const onPointerMove = (event) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      ...pointersRef.current.get(event.pointerId),
      x: event.clientX,
      y: event.clientY,
    });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      const nextScale = clampZoom(pinch.startScale * (pointDistance(a, b) / pinch.startDist));
      const mid = pointMidpoint(a, b);
      const rect = event.currentTarget.getBoundingClientRect();
      const nextPan = clampPan({
        x: pinch.startPan.x + (mid.x - pinch.startMid.x),
        y: pinch.startPan.y + (mid.y - pinch.startMid.y),
      }, nextScale, rect.width, rect.height);
      setScale(nextScale);
      setPan(nextPan);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    setPan({
      x: Math.max(-limit, Math.min(limit, drag.panX + event.clientX - drag.x)),
      y: Math.max(-limit, Math.min(limit, drag.panY + event.clientY - drag.y)),
    });
  };
  const onPointerUp = (event) => {
    const wasPinching = Boolean(pinchRef.current);
    const pointer = pointersRef.current.get(event.pointerId);
    pointersRef.current.delete(event.pointerId);
    if (pinchRef.current && pointersRef.current.size < 2) {
      pinchRef.current = null;
      const settled = settleZoom({ scale: scaleRef.current, x: pan.x, y: pan.y });
      if (settled.scale === MIN_ZOOM) {
        setScale(MIN_ZOOM);
        setPan({ x: 0, y: 0 });
      }
    }
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
    if (pointersRef.current.size === 0) setInteracting(false);

    // A short, still touch is a tap. Two of them inside one gesture zoom about
    // the tapped point — the familiar luxury-storefront double-tap.
    if (!pointer || wasPinching || event.pointerType === 'mouse' || pointersRef.current.size) return;
    const travel = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
    if (travel > 12) return;
    const now = Date.now();
    const previousTap = lastTapRef.current;
    if (previousTap && now - previousTap.time < 320 &&
        Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) < 32) {
      lastTapRef.current = null;
      toggleZoomAt(event.clientX, event.clientY);
    } else {
      lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
    }
  };

  return createPortal(
    <div
      className={`photo-lightbox product-zoom-lightbox${entered ? ' is-entered' : ''}${closing ? ' is-closing' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
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
          onClick={() => requestClose()}
          aria-label="Close image"
        >
          <X size={18} aria-hidden="true" />
        </button>

        <div
          ref={stageRef}
          className="product-zoom-stage"
          data-zoomed={scale > MIN_ZOOM ? 'true' : 'false'}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={toggleZoom}
        >
          <SafeImage
            key={current}
            src={photos[current]}
            data-image-width="detail"
            alt={`${name || 'Product'} — view ${current + 1}`}
            fallback={fallback}
            draggable={false}
            className={`product-zoom-img${photoVisible ? ' is-visible' : ''}`}
            data-interacting={interacting ? 'true' : 'false'}
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
