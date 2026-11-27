// A single lazily-created AudioContext. Creating a fresh context for every
// notification exhausts the browser's context limit after a handful of order
// alerts; reusing one (and resuming it before each chime) does not.
const STORAGE_KEY = 'zshm.admin.orderSoundEnabled';
let audioContext = null;

export function getOrderSoundEnabled() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'boolean') return parsed;
    return parsed && typeof parsed === 'object' && parsed.enabled !== false;
  } catch (error) {
    return true;
  }
}

export function setOrderSoundEnabled(enabled) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Boolean(enabled)));
  } catch (error) {
    // Private browsing: keep the in-memory toggle even when storage is blocked.
  }
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const Ctor = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
  } catch (error) {
    audioContext = null;
  }
  return audioContext;
}

export async function playOrderChime() {
  if (!getOrderSoundEnabled()) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') await ctx.resume();
    if (!audioContext || audioContext !== ctx || ctx.state === 'closed') return;
    [880, 1100, 1320].forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.1;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.2, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.start(start);
      osc.stop(start + 0.3);
    });
  } catch (error) {
    // Audio is decorative: a blocked context must never break the admin UI.
  }
}

export function closeOrderChime() {
  if (audioContext && typeof audioContext.close === 'function') {
    try {
      const closing = audioContext.close();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    } catch (error) {
      // Already closed by the browser.
    }
  }
  audioContext = null;
}
