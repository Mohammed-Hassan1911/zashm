import React, { useEffect, useMemo, useState } from 'react';
import { mirrorCandidates } from '../../lib/resilience';

/**
 * Try the live Supabase image first, then the R2 mirror, then the placeholder.
 * The step is keyed by `src` so switching gallery images resets the fallback
 * without an extra render loop.
 */
export function useImageFallback(src, fallback = '') {
  const candidates = useMemo(() => mirrorCandidates(src), [src]);
  const [state, setState] = useState({ key: src, step: 0 });

  useEffect(() => {
    setState((prev) => (prev.key === src ? prev : { key: src, step: 0 }));
  }, [src]);

  const step = state.key === src ? state.step : 0;
  const resolved = step < candidates.length ? candidates[step] : fallback;

  const onError = () => {
    setState((prev) => {
      const current = prev.key === src ? prev.step : 0;
      if (current >= candidates.length) return { key: src, step: current };
      return { key: src, step: current + 1 };
    });
  };

  return { src: resolved || '', onError };
}

/**
 * <img> with an automatic R2 mirror fallback and a final placeholder.
 * Extra props (style, loading, className, …) pass straight through.
 */
export default function SafeImage({ src, alt = '', fallback = '', onError, ...rest }) {
  const image = useImageFallback(src, fallback);

  const handleError = (event) => {
    // Once the placeholder is showing, stop the browser from retrying forever.
    if (!image.src || image.src === fallback) {
      event.currentTarget.onerror = null;
    }
    image.onError();
    if (typeof onError === 'function') onError(event);
  };

  return <img {...rest} src={image.src} alt={alt} onError={handleError} />;
}
