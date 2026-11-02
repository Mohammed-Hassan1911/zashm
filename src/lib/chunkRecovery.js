import React from 'react';

// Recovery for stale dynamic-import chunks after a redeploy.
//
// A tab that is already open keeps the old index.html and module graph in
// memory. When a later navigation lazy-loads a page after a new deployment,
// the old hashed chunk no longer exists on the CDN and the import rejects.
// Visually that is either a black startup screen (Suspense fallback) or the
// "Something went wrong" fallback. Reloading once fetches a coherent
// index.html + chunk set.

const RELOAD_KEY = 'zashm:chunk-reload-at';
const RELOAD_WINDOW_MS = 10000;
const RETRY_DELAY_MS = 400;

function readLastReload() {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    return 0;
  }
}

function markReload() {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    // Without storage a reload loop cannot be detected, so do not reload.
    return false;
  }
}

/**
 * Reload the current tab to pick up a new deployment, at most once per
 * 10 seconds. Returns true when a reload was scheduled.
 */
export function reloadForChunkError() {
  if (typeof window === 'undefined') return false;
  if (Date.now() - readLastReload() < RELOAD_WINDOW_MS) return false;
  if (!markReload()) return false;
  window.location.reload();
  return true;
}

const delay = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/**
 * React.lazy with one retry for transient network failures, then a guarded
 * reload for stale chunks. If a reload is not safe (attempted recently, or
 * storage is blocked) the original error is rethrown so the ErrorBoundary can
 * show a manual "Reload" action instead of looping.
 */
export function lazyWithRetry(importer) {
  return React.lazy(async () => {
    try {
      return await importer();
    } catch (firstError) {
      await delay(RETRY_DELAY_MS);
      try {
        return await importer();
      } catch (error) {
        if (reloadForChunkError()) {
          // Keep the Suspense fallback on screen while the browser navigates.
          return new Promise(() => {});
        }
        throw error;
      }
    }
  });
}
