// Clipboard is unavailable on insecure origins and can reject after a user
// permission change. Never report "Copied!" unless a write actually succeeded.
export async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      // Fall through to the legacy selection-based copy below.
    }
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const opener = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(0, value.length);
    copied = Boolean(document.execCommand('copy'));
  } catch (error) {
    copied = false;
  } finally {
    if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  }
  return copied;
}

export default copyText;
