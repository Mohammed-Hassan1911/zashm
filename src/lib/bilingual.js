// Bilingual message utility - English first, Arabic below
export function b(en, ar) {
  return { en, ar };
}

export function formatBilingual(en, ar) {
  return `${en}\n${ar}`;
}

// Common bilingual messages
export const BILINGUAL = {
  // Order
  ORDER_PLACED_SUCCESS_EN: 'Order Placed Successfully!\nThank you for your order. You can track your shipment using the link below.',
  ORDER_PLACED_SUCCESS_AR: 'تم تأكيد طلبك بنجاح!\nشكرًا لطلبك. يمكنك تتبّع شحنتك من خلال الرابط الموضح أدناه.',
  ORDER_NUMBER_EN: (orderNumber) => `Order Number: ${orderNumber}`,
  ORDER_NUMBER_AR: (orderNumber) => `رقم الطلب: ${orderNumber}`,
  
  // Cart/Stock
  CART_UPDATED_AUTO_EN: 'Your bag has been updated automatically.',
  CART_UPDATED_AUTO_AR: 'تم تحديث سلة التسوق تلقائيًا.',
  ITEM_REMOVED_OUT_OF_STOCK_EN: (name) => `• "${name}" was removed because it is out of stock.`,
  ITEM_REMOVED_OUT_OF_STOCK_AR: (name) => `• تمت إزالة المنتج "${name}" من سلة التسوق لنفاد الكمية المتاحة منه.`,
  
  // Stock issues
  STOCK_ISSUE_EN: 'Stock availability issue:',
  STOCK_ISSUE_AR: 'مشكلة في توفر المخزون:',
  UNAVAILABLE_VARIATION_EN: (name, size, color) => `• ${name} is currently unavailable in the selected variation (${size} - ${color}).`,
  UNAVAILABLE_VARIATION_AR: (name, size, color) => `• ${name} غير متوفر حاليًا بالمقاس واللون المحددين (${size} - ${color}).`,
  
  // Validation
  REQUIRED_FIELD_EN: 'This field is required.',
  REQUIRED_FIELD_AR: 'هذا الحقل مطلوب.',
  SELECT_SIZE_EN: 'Please select a size.',
  SELECT_SIZE_AR: 'يرجى اختيار المقاس.',
  SELECT_COLOR_EN: 'Please select a color.',
  SELECT_COLOR_AR: 'يرجى اختيار اللون.',
  
  // Fallback
  SOMETHING_WENT_WRONG_EN: 'Something went wrong. Please try again.',
  SOMETHING_WENT_WRONG_AR: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};
