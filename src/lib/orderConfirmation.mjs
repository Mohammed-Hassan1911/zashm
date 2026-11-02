const STORAGE_KEY = 'zashm_order_confirmation';

function getSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch (error) {
    return null;
  }
}

function toAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeConfirmation(order) {
  if (!order || typeof order !== 'object' || !order.id || !Array.isArray(order.items)) {
    return null;
  }

  return {
    id: String(order.id),
    total: toAmount(order.total),
    subtotal: toAmount(order.subtotal),
    discount: toAmount(order.discount),
    shippingCost: toAmount(order.shippingCost),
    city: typeof order.city === 'string' ? order.city : '',
    tracking_url: typeof order.tracking_url === 'string' ? order.tracking_url : '',
    items: order.items.map((item) => ({
      productId: item?.productId ?? '',
      name: typeof item?.name === 'string' ? item.name : '',
      size: typeof item?.size === 'string' ? item.size : '',
      color: typeof item?.color === 'string' ? item.color : '',
      qty: toAmount(item?.qty),
      price: toAmount(item?.price),
    })),
  };
}

export function saveOrderConfirmation(order) {
  const storage = getSessionStorage();
  const confirmation = normalizeConfirmation(order);
  if (!storage || !confirmation) return false;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(confirmation));
    return true;
  } catch (error) {
    console.error('Could not save order confirmation for this session:', error);
    return false;
  }
}

export function readOrderConfirmation() {
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const confirmation = normalizeConfirmation(JSON.parse(raw));
    if (!confirmation) storage.removeItem(STORAGE_KEY);
    return confirmation;
  } catch (error) {
    console.error('Could not read the saved order confirmation:', error);
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (removeError) {
      console.error('Could not clear the invalid saved order confirmation:', removeError);
    }
    return null;
  }
}

export function clearOrderConfirmation() {
  const storage = getSessionStorage();
  if (!storage) return;

  try {
    storage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Could not clear the saved order confirmation:', error);
  }
}
