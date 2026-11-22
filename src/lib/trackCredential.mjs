// The signed tracking token is a credential: it must never return to the URL
// (history, screenshots and referrers). Keep it in sessionStorage, keyed by the
// order id, so a refresh of the secure link — or a manual search in the same
// tab — still works. Closing the tab forgets it; nothing is persisted long term.

const PREFIX = 'zshm_track:';

function getSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch (error) {
    return null;
  }
}

function credentialKey(orderId) {
  return `${PREFIX}${String(orderId).trim()}`;
}

export function saveTrackCredential(orderId, token) {
  const id = String(orderId || '').trim();
  const value = String(token || '').trim();
  if (!id || !value) return false;
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(credentialKey(id), value);
    return true;
  } catch (error) {
    return false;
  }
}

export function readTrackCredential(orderId) {
  const id = String(orderId || '').trim();
  if (!id) return '';
  const storage = getSessionStorage();
  if (!storage) return '';
  try {
    return storage.getItem(credentialKey(id)) || '';
  } catch (error) {
    return '';
  }
}
