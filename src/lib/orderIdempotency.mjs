const STORAGE_KEY = 'zashm_checkout_idempotency';
const KEY_RE = /^[a-f0-9]{64}$/;

function getStorageCandidates() {
  const candidates = [];
  try {
    if (globalThis.localStorage) candidates.push(globalThis.localStorage);
  } catch (e) {
    // Try session storage if persistent storage is blocked.
  }
  try {
    if (globalThis.sessionStorage) candidates.push(globalThis.sessionStorage);
  } catch (e) {
    // The caller receives a visible error if neither store is available.
  }
  return candidates;
}

function cartSignature(items) {
  return items
    .map((item) => [
      item?.product?.id ?? item?.productId ?? '',
      item?.qty ?? 0,
      item?.size ?? '',
      item?.color ?? '',
    ].map((value) => String(value).replace(/[|\\]/g, '\\$&')).join('|'))
    .sort()
    .join('\n');
}

function createKey() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure checkout is unavailable in this browser. Please use an updated browser.');
  }
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getCheckoutIdempotencyKey(items, storageCandidates = getStorageCandidates()) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Your bag is empty. Add a piece before placing an order.');
  }

  const signature = cartSignature(items);
  if (!signature) throw new Error('Could not verify the items in your bag. Please refresh and try again.');

  for (const storage of storageCandidates) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.signature === signature && KEY_RE.test(saved.key || '')) return saved.key;
      }

      const key = createKey();
      storage.setItem(STORAGE_KEY, JSON.stringify({ signature, key }));
      return key;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Secure checkout')) throw error;
    }
  }

  throw new Error('Secure checkout requires browser storage. Please enable site storage and try again.');
}

export function clearCheckoutIdempotencyKey(key, storageCandidates = getStorageCandidates()) {
  if (!KEY_RE.test(String(key || ''))) return;
  for (const storage of storageCandidates) {
    try {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (saved?.key === key) storage.removeItem(STORAGE_KEY);
    } catch (e) {
      // Other available storage candidates are still checked.
    }
  }
}
