import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initGA } from './lib/ga';
import { reloadForChunkError } from './lib/chunkRecovery';

initGA();

// Vite fires this when a modulepreload or dynamic chunk fails (typically a
// stale build after a deployment). Recover with a single guarded reload
// instead of showing a black screen or the error fallback.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadForChunkError();
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);

// Fetch the optional display fonts after the first storefront paint. Keeping
// the stylesheet out of the document head's render-blocking path lets the
// system fallbacks paint immediately while font-display=swap loads the brand
// faces in the background.
//
// Both families are requested as variable fonts (`300..700`) rather than as
// nine static weights: the browser then downloads three latin files instead of
// eleven, which on a phone removes eight round-trips and roughly a third of the
// font payload. Keep this URL byte-identical to the preload in index.html or
// the preload is wasted.
const BRAND_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300..700;1,300..700&family=Montserrat:wght@300..700&display=swap';

const loadBrandFonts = () => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = BRAND_FONTS_HREF;
  document.head.appendChild(link);
};

requestAnimationFrame(() => requestAnimationFrame(loadBrandFonts));
