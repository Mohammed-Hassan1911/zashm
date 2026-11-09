// Admin-side helpers for opening a WhatsApp chat with a customer.
// The link only carries the customer phone and a text body; no secrets and no
// customer data are sent anywhere until the admin chooses to open the chat.

/**
 * Normalise an Egyptian mobile number to the international form used by wa.me.
 * Accepts 01xxxxxxxxx, +20 1xxxxxxxxx, 0020 1xxxxxxxxx and 1xxxxxxxxx.
 * Returns '' when the value is not a plausible Egyptian mobile number.
 */
export function normalizeEgyptPhoneForWhatsApp(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';

  let normalized = digits;
  if (normalized.startsWith('0020')) normalized = normalized.slice(2);
  else if (normalized.startsWith('01') && normalized.length === 11) normalized = `20${normalized.slice(1)}`;
  else if (normalized.startsWith('1') && normalized.length === 10) normalized = `20${normalized}`;

  // Egyptian mobiles become 20 + 10 digits beginning with 1 (201012345678).
  return /^201\d{9}$/.test(normalized) ? normalized : '';
}

function formatEGP(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `EGP ${Math.round(amount).toLocaleString('en-US')}`
    : 'EGP 0';
}

/**
 * Build the pre-filled confirmation message the admin sends before shipping.
 * It repeats the order back to the customer so a wrong size, colour, address or
 * phone number is caught before the courier is booked.
 */
export function buildOrderConfirmationMessage(order) {
  if (!order || typeof order !== 'object') return '';

  const id = String(order.id || '').trim();
  const name = String(order.customer || '').trim();
  const items = Array.isArray(order.items) ? order.items : [];
  const itemLines = items.map((item) => {
    const label = String(item?.name || 'Item').trim();
    const size = String(item?.size || '').trim();
    const color = String(item?.color || '').trim();
    const qty = Math.max(1, Number(item?.qty) || 1);
    const variant = [size, color].filter(Boolean).join(' / ');
    return `• ${label}${variant ? ` (${variant})` : ''} × ${qty}`;
  });
  const address = [order.address, order.city]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
  const total = formatEGP(order.total);
  const greeting = name ? `مرحبًا ${name}،` : 'مرحبًا،';
  const itemBlock = itemLines.length ? `\n${itemLines.join('\n')}` : '';
  const addressLine = address ? `\nالعنوان: ${address}` : '';

  return `${greeting} معك ZASHM.\n${id ? `وصلنا طلبك ${id}:` : 'وصلنا طلبك:'}${itemBlock}\nالإجمالي عند الاستلام: ${total}${addressLine}\n\nمن فضلك أكّد الطلب والمقاس واللون والعنوان قبل الشحن. رد بكلمة "تأكيد" لو كل حاجة صح، أو اكتب لنا أي تعديل.\n\nHello${name ? ` ${name}` : ''}, this is ZASHM. Please confirm order${id ? ` ${id}` : ''}, the size/colour and the delivery address before we ship. Reply CONFIRM if everything is correct, or tell us what to change.`;
}

/** Build a wa.me URL for a customer, or '' when the phone is unusable. */
export function customerWhatsAppUrl(phone, message) {
  const number = normalizeEgyptPhoneForWhatsApp(phone);
  if (!number) return '';
  const text = String(message || '').trim();
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
