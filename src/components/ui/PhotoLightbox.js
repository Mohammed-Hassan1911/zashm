import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * One customer photo, opened in place. A dark stage over the page, the photo at
 * its own aspect ratio, and three ways out: the close button, Escape, or a tap
 * outside the photo. Focus moves to the close button and returns to whatever
 * opened it, and the page behind is locked so it cannot scroll underneath.
 *
 * `photo` is `{ src, alt, caption, returnTo }`; pass `null` to keep it closed.
 */
export default function PhotoLightbox({ photo, onClose }) {
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!photo) return undefined;

    const opener = photo.returnTo instanceof HTMLElement
      ? photo.returnTo
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
    // `overflow: hidden` alone does not lock the page on iOS Safari: fix the
    // body in place and put the page back exactly where it was on close.
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = `${lockedWidth}px`;
    body.style.overflow = 'hidden';

    closeRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      // Only one control lives in here, so Tab must not wander into the page.
      if (event.key === 'Tab') {
        event.preventDefault();
        closeRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      html.style.overflow = previous.htmlOverflow;
      html.style.scrollBehavior = 'auto';
      body.style.overflow = previous.bodyOverflow;
      body.style.position = previous.bodyPosition;
      body.style.top = previous.bodyTop;
      body.style.left = previous.bodyLeft;
      body.style.right = previous.bodyRight;
      body.style.width = previous.bodyWidth;
      window.scrollTo(0, scrollY);
      // Un-fixing the body can clamp the offset for a frame; re-assert it.
      window.requestAnimationFrame?.(() => window.scrollTo(0, scrollY));
      html.style.scrollBehavior = previous.htmlScrollBehavior;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [photo]);

  if (!photo) return null;

  return createPortal(
    <div
      className="photo-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        className="photo-lightbox-frame"
        role="dialog"
        aria-modal="true"
        aria-label={photo.alt}
      >
        <button
          ref={closeRef}
          type="button"
          className="photo-lightbox-close"
          onClick={() => onCloseRef.current()}
          aria-label="Close photo"
        >
          <X size={18} aria-hidden="true" />
        </button>
        <img className="photo-lightbox-img" src={photo.src} alt={photo.alt} />
        {photo.caption && <p className="photo-lightbox-caption">{photo.caption}</p>}
      </div>
    </div>,
    document.body
  );
}
