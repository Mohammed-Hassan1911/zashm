import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initGA } from './lib/ga';
import { installErrorReporting } from './lib/errorReporting';

initGA();

// Client errors go to /api/errors (log line + one Telegram alert per distinct
// error). Installed before the first render so a mount failure is reported too.
installErrorReporting();

// No vite:preloadError listener here on purpose. Vite rethrows a failed chunk
// only when that event is not cancelled; cancelling it makes the dynamic import
// resolve with `undefined`, which React.lazy then dereferences as `.default`.
// Every route chunk is already wrapped in lazyWithRetry, which retries once and
// then performs the same guarded reload — without corrupting React's lazy state.

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
