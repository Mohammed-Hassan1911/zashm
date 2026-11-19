// ─── Client error reporting ──────────────────────────────────────────────────
// Three small hooks that post a bounded, de-identified report to /api/errors:
// window.onerror, unhandledrejection, and the React error boundary.
//
// Rules that keep this from becoming a problem of its own:
//   - never throws and never awaits; a report can never break a render or hold
//     up navigation
//   - at most 5 reports per page load, and one per identical message, so a
//     render loop cannot flood the endpoint (the server caps it again)
//   - skipped on localhost and in dev builds, where the console is enough
//   - sends only message, stack, route, user agent and a fixed app tag: no
//     cookies, no ids, no form values, no query strings
//   - navigator.sendBeacon when available (survives a closing tab), otherwise
//     fetch with keepalive

const ENDPOINT = '/api/errors';
const APP = 'zashm-web';
const MAX_REPORTS = 5;
const MAX_MESSAGE = 300;
const MAX_STACK = 1200;

let installed = false;
let sent = 0;
const seen = new Set();

function isEnabled() {
  if (typeof window === 'undefined') return false;
  if (import.meta.env && import.meta.env.DEV) return false;
  const host = window.location && window.location.hostname;
  if (!host) return false;
  return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local'));
}

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function currentRoute() {
  try {
    return clean(window.location.pathname, 160) || '/';
  } catch (e) {
    return '/';
  }
}

function fingerprint(kind, message) {
  return `${kind}|${message}`.slice(0, 240);
}

/**
 * Report one client error. Safe to call from anywhere: it validates, de-dupes,
 * caps and swallows every failure.
 */
export function reportError(kind, error, extra) {
  try {
    if (!isEnabled()) return false;
    if (sent >= MAX_REPORTS) return false;

    const message = clean(
      (error && (error.message || error.reason || error)) || 'Unknown error',
      MAX_MESSAGE
    );
    if (!message) return false;

    const key = fingerprint(kind, message);
    if (seen.has(key)) return false;
    seen.add(key);

    const stackSource = (error && (error.stack || (error.reason && error.reason.stack))) || '';
    const payload = {
      kind,
      message,
      route: currentRoute(),
      stack: clean(stackSource, MAX_STACK),
      app: APP,
      userAgent: clean(typeof navigator !== 'undefined' ? navigator.userAgent : '', 220),
    };

    sent += 1;
    const body = JSON.stringify(payload);

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(ENDPOINT, blob)) return true;
    }

    if (typeof fetch === 'function') {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'omit',
      }).catch(() => {});
    }
    return true;
  } catch (e) {
    // Reporting must never be the thing that breaks the page.
    return false;
  }
}

/** Attach the global hooks once, from the entry point. */
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (!isEnabled()) return;

  window.addEventListener('error', (event) => {
    // Resource failures (a missing image) bubble here without an Error object.
    const target = event && event.target;
    if (target && target !== window && target.tagName) return;
    reportError('error', (event && event.error) || (event && event.message) || 'Unknown error');
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError('unhandledrejection', (event && event.reason) || 'Unhandled rejection');
  });
}

// Exported for the regression suite.
export const __test = { clean, fingerprint, isEnabled, MAX_REPORTS, MAX_MESSAGE, MAX_STACK };
