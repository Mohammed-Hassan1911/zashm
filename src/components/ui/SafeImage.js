import React, { useEffect, useMemo, useState } from 'react';
import { imageCandidates, mirrorCandidates } from '../../lib/resilience';

/**
 * Try the Cloudflare-optimized image first, then the live Supabase URL, then
 * the R2 mirror, then the placeholder. The step is keyed by `src` so switching
 * gallery images resets the fallback without an extra render loop.
 */
export function useImageFallback(src, fallback = '', options = {}) {
  const config = typeof options === 'object' && options !== null ? options : { width: options };
  const width = config.width || 'card';
  const withSrcSet = Boolean(config.srcSet);
  const sizes = config.sizes || '';
  const candidates = useMemo(
    () => {
      const optimized = imageCandidates(src, { width, srcSet: withSrcSet, sizes });
      const existing = new Set(optimized.map((item) => item.src));
      for (const candidate of mirrorCandidates(src)) {
        if (candidate && !existing.has(candidate)) {
          existing.add(candidate);
          optimized.push({ src: candidate });
        }
      }
      return optimized;
    },
    [src, width, withSrcSet, sizes]
  );
  const [state, setState] = useState({ key: src, step: 0 });

  useEffect(() => {
    setState((prev) => (prev.key === src ? prev : { key: src, step: 0 }));
  }, [src]);

  const step = state.key === src ? state.step : 0;
  const resolved = step < candidates.length ? candidates[step] : { src: fallback };

  const onError = () => {
    setState((prev) => {
      const current = prev.key === src ? prev.step : 0;
      if (current >= candidates.length) return { key: src, step: current };
      return { key: src, step: current + 1 };
    });
  };

  return {
    src: resolved.src || '',
    srcSet: resolved.srcSet || '',
    sizes: resolved.sizes || '',
    onError,
  };
}

/**
 * <img> with an edge-optimized source, live/mirror fallbacks and a final
 * placeholder. Extra props (style, loading, className, …) pass straight
 * through; srcSet/sizes are controlled here so a fallback never keeps a srcSet
 * pointing at the failed proxy.
 */
export default function SafeImage({ src, alt = '', fallback = '', onError, ...rest }) {
  // Width hints travel as data-* props so the rest of the component API stays
  // unchanged: existing callers automatically get the card-size edge image.
  const width = rest['data-image-width'] || 'card';
  const withSrcSet = rest['data-image-srcset'] === 'true';
  const sizes = rest['data-image-sizes'] || '';
  const image = useImageFallback(src, fallback, { width, srcSet: withSrcSet, sizes });

  const handleError = (event) => {
    // Once the placeholder is showing, stop the browser from retrying forever.
    if (!image.src || image.src === fallback) {
      event.currentTarget.onerror = null;
    }
    image.onError();
    if (typeof onError === 'function') onError(event);
  };

  const { ['data-image-width']: _width, ['data-image-srcset']: _srcSet, ['data-image-sizes']: _sizes, ...imgProps } = rest;
  return (
    <img
      {...imgProps}
      src={image.src}
      srcSet={image.srcSet || undefined}
      sizes={image.sizes || undefined}
      alt={alt}
      onError={handleError}
    />
  );
}
