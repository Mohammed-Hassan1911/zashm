import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initGA } from './lib/ga';
import { reloadForChunkError } from './lib/chunkRecovery';
import { installErrorReporting } from './lib/errorReporting';

initGA();

// Client errors go to /api/errors (log line + one Telegram alert per distinct
// error). Installed before the first render so a mount failure is reported too.
installErrorReporting();

// Vite fires this when a modulepreload or dynamic chunk fails (typically a
// stale build after a deployment). Recover with a single guarded reload
// instead of showing a black screen or the error fallback.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadForChunkError();
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
