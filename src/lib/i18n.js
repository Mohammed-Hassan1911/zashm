// ─── CENTRAL TRANSLATION SYSTEM ──────────────────────────────────────────────
// English is default for new visitors

const STORAGE_KEY = 'zashm_lang';

const translations = {
  en: {
    // Common UI
    home: 'Home',
    shop: 'Shop',
    search: 'Search',
    wishlist: 'Wishlist',
    bag: 'Bag',
    cart: 'Cart',
    products: 'Products',
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    required: 'Required',
    optional: 'Optional',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    close: 'Close',
    back: 'Back',
    next: 'Next',
    previous: 'Previous',
    viewAll: 'View All',
    showMore: 'Show More',
    showLess: 'Show Less',
    
    // Header/Nav
    backToProducts: 'Back to Products',
    backToShop: 'Back to Shop',
    continueShopping: 'Continue Shopping',
    
    // Product
    color: 'Color',
    size: 'Size',
    quantity: 'Quantity',
    addToBag: 'ADD TO BAG',
    addToCart: 'Add to Cart',
    outOfStockBtn: 'OUT OF STOCK',
    outOfStock: 'Out of Stock',
    inStock: 'In Stock',
    sizeGuide: 'Size Guide',
    sizeGuideBtn: 'Size Guide',
    youMayAlsoLike: 'You May Also Like',
    productDetails: 'Product Details',
    description: 'Description',
    details: 'Details',
    care: 'Care',
    noProductSelected: 'No product selected.',
    backToProductsBtn: 'Back to Products',
    
    // Cart
    yourBag: 'Your Bag',
    shoppingBag: 'Shopping Bag',
    emptyBag: 'Your bag is empty',
    emptyBagDesc: 'Start shopping to add items to your bag',
    subtotal: 'Subtotal',
    shipping: 'Shipping',
    total: 'Total',
    proceedToCheckout: 'PROCEED TO CHECKOUT',
    remove: 'Remove',
    updateCart: 'Update Cart',
    items: 'items',
    item: 'item',
    
    // Checkout
    checkout: 'Checkout',
    contactInformation: 'Contact Information',
    shippingAddress: 'Shipping Address',
    paymentMethod: 'Payment Method',
    orderSummary: 'Order Summary',
    fullName: 'Full Name',
    firstName: 'First Name',
    lastName: 'Last Name',
    email: 'Email',
    phone: 'Phone Number',
    address: 'Address',
    city: 'City',
    governorate: 'Governorate',
    postalCode: 'Postal Code',
    cashOnDelivery: 'Cash on Delivery',
    placeOrder: 'PLACE ORDER',
    orderPlaced: 'Order Placed',
    processing: 'Processing...',
    pleaseSelectSize: 'Please select a size',
    pleaseSelectColor: 'Please select a color',
    selectSize: 'Select a size',
    selectColor: 'Select a color',
    
    // Messages
    addedToBag: 'added to your bag!',
    itemAdded: 'Item added to cart',
    tryAgain: 'Try Again',
    somethingWentWrong: 'Something went wrong',
    pleaseEnterValidInfo: 'Please enter valid information',
    
    // Footer
    aboutUs: 'About Us',
    contact: 'Contact',
    policies: 'Policies',
    followUs: 'Follow Us',
    allRightsReserved: 'All rights reserved',
    
    // Home
    exploreCollection: 'Explore Collection',
    featuredProducts: 'Featured Products',
    newArrivals: 'New Arrivals',
    viewAllProducts: 'View All Products',
    
    // Shop
    allProducts: 'All Products',
    filter: 'Filter',
    filters: 'Filters',
    sortBy: 'Sort By',
    sort: 'Sort',
    newest: 'Newest',
    priceLowToHigh: 'Price: Low to High',
    priceHighToLow: 'Price: High to Low',
    bestSeller: 'Best Seller',
    noProductsFound: 'No Products Found',
    tryAdjusting: 'Try adjusting your search or filters to discover more pieces.',
    resetFilters: 'Reset Filters',
    pieces: 'PIECES',
    piece: 'PIECE',
    available: 'AVAILABLE',
    categories: 'Categories',
    priceRange: 'Price Range',
    min: 'Min',
    max: 'Max',
    apply: 'Apply',
    clear: 'Clear',
    
    // Track Order
    trackOrder: 'Track Your Order',
    trackYourOrder: 'Track Your Order',
    orderNumber: 'Order Number',
    enterOrderNumber: 'Enter order number',
    track: 'Track',
    orderNotFound: 'Order not found',
    
    // Auth
    login: 'Login',
    signUp: 'Sign Up',
    signIn: 'Sign In',
    logout: 'Logout',
    account: 'Account',
    myOrders: 'My Orders',
    
    // Language
    language: 'Language',
    english: 'English',
    arabic: 'العربية',
    
    // Common
    loading: 'Loading...',
    error: 'Error',
    success: 'Success',
    
    // Navigation
    backToProducts: 'Back to Products',
    backToShop: 'Back to Shop',
    continueShopping: 'Continue Shopping',
    
    // Product
    color: 'Color',
    size: 'Size',
    quantity: 'Quantity',
    addToBag: 'ADD TO BAG',
    outOfStockBtn: 'OUT OF STOCK',
    sizeGuide: 'Size Guide',
    sizeGuideBtn: 'Size Guide',
    youMayAlsoLike: 'You May Also Like',
    
    // Cart
    yourBag: 'Your Bag',
    emptyBag: 'Your bag is empty',
    emptyBagDesc: 'Start shopping to add items to your bag',
    subtotal: 'Subtotal',
    shipping: 'Shipping',
    total: 'Total',
    proceedToCheckout: 'PROCEED TO CHECKOUT',
    remove: 'Remove',
    
    // Checkout
    checkout: 'Checkout',
    contactInformation: 'Contact Information',
    shippingAddress: 'Shipping Address',
    paymentMethod: 'Payment Method',
    orderSummary: 'Order Summary',
    fullName: 'Full Name',
    email: 'Email',
    phone: 'Phone Number',
    address: 'Address',
    city: 'City',
    governorate: 'Governorate',
    postalCode: 'Postal Code',
    cashOnDelivery: 'Cash on Delivery',
    placeOrder: 'PLACE ORDER',
    orderPlaced: 'Order Placed',
    
    // Forms
    required: 'Required',
    pleaseSelectSize: 'Please select a size',
    pleaseSelectColor: 'Please select a color',
    
    // Messages
    addedToBag: 'added to your bag!',
    itemAdded: 'Item added to cart',
    tryAgain: 'Try Again',
    
    // Footer
    aboutUs: 'About Us',
    contact: 'Contact',
    policies: 'Policies',
    followUs: 'Follow Us',
    
    // Home
    exploreCollection: 'Explore Collection',
    featuredProducts: 'Featured Products',
    newArrivals: 'New Arrivals',
    
    // Shop
    allProducts: 'All Products',
    filter: 'Filter',
    sortBy: 'Sort By',
    newest: 'Newest',
    priceLowToHigh: 'Price: Low to High',
    priceHighToLow: 'Price: High to Low',
    bestSeller: 'Best Seller',
    noProductsFound: 'No Products Found',
    tryAdjusting: 'Try adjusting your search or filters',
    resetFilters: 'Reset Filters',
    pieces: 'PIECES',
    piece: 'PIECE',
    
    // Track Order
    trackOrder: 'Track Your Order',
    orderNumber: 'Order Number',
    track: 'Track',
    
    // Auth
    login: 'Login',
    signUp: 'Sign Up',
    logout: 'Logout',
    
    // Language
    language: 'Language',
    english: 'English',
    arabic: 'العربية',
    
    // Common
    loading: 'Loading...',
    error: 'Error',
    success: 'Success'
  },
  ar: {
    // Header
    home: 'الرئيسية',
    shop: 'المتجر',
    search: 'بحث',
    wishlist: 'قائمة الرغبات',
    bag: 'السلة',
    cart: 'السلة',
    
    // Navigation
    backToProducts: 'العودة للمنتجات',
    backToShop: 'العودة للمتجر',
    continueShopping: 'متابعة التسوق',
    
    // Product
    color: 'اللون',
    size: 'المقاس',
    quantity: 'الكمية',
    addToBag: 'أضف إلى السلة',
    outOfStockBtn: 'نفذ المخزون',
    sizeGuide: 'دليل المقاسات',
    sizeGuideBtn: 'دليل المقاسات',
    youMayAlsoLike: 'قد يعجبك أيضًا',
    
    // Cart
    yourBag: 'سلتك',
    emptyBag: 'سلتك فارغة',
    emptyBagDesc: 'ابدأ التسوق لإضافة منتجات إلى سلتك',
    subtotal: 'المجموع الفرعي',
    shipping: 'الشحن',
    total: 'الإجمالي',
    proceedToCheckout: 'إتمام الطلب',
    remove: 'إزالة',
    
    // Checkout
    checkout: 'إتمام الطلب',
    contactInformation: 'معلومات الاتصال',
    shippingAddress: 'عنوان الشحن',
    paymentMethod: 'طريقة الدفع',
    orderSummary: 'ملخص الطلب',
    fullName: 'الاسم الكامل',
    email: 'البريد الإلكتروني',
    phone: 'رقم الهاتف',
    address: 'العنوان',
    city: 'المدينة',
    governorate: 'المحافظة',
    postalCode: 'الرمز البريدي',
    cashOnDelivery: 'الدفع عند الاستلام',
    placeOrder: 'تأكيد الطلب',
    orderPlaced: 'تم تأكيد الطلب',
    
    // Forms
    required: 'مطلوب',
    pleaseSelectSize: 'يرجى اختيار المقاس',
    pleaseSelectColor: 'يرجى اختيار اللون',
    
    // Messages
    addedToBag: 'تمت إضافته إلى سلتك!',
    itemAdded: 'تم إضافة المنتج',
    tryAgain: 'حاول مرة أخرى',
    
    // Footer
    aboutUs: 'من نحن',
    contact: 'اتصل بنا',
    policies: 'السياسات',
    followUs: 'تابعنا',
    
    // Home
    exploreCollection: 'استكشف المجموعة',
    featuredProducts: 'منتجات مميزة',
    newArrivals: 'وصل حديثًا',
    
    // Shop
    allProducts: 'جميع المنتجات',
    filter: 'فلتر',
    sortBy: 'ترتيب حسب',
    newest: 'الأحدث',
    priceLowToHigh: 'السعر: من الأقل للأعلى',
    priceHighToLow: 'السعر: من الأعلى للأقل',
    bestSeller: 'الأكثر مبيعًا',
    noProductsFound: 'لا توجد منتجات',
    tryAdjusting: 'جرب تعديل البحث أو الفلاتر',
    resetFilters: 'إعادة تعيين الفلاتر',
    pieces: 'قطع',
    piece: 'قطعة',
    
    // Track Order
    trackOrder: 'تتبع طلبك',
    orderNumber: 'رقم الطلب',
    track: 'تتبع',
    
    // Auth
    login: 'تسجيل الدخول',
    signUp: 'إنشاء حساب',
    logout: 'تسجيل الخروج',
    
    // Language
    language: 'اللغة',
    english: 'English',
    arabic: 'العربية',
    
    // Common
    loading: 'جارٍ التحميل...',
    error: 'خطأ',
    success: 'نجح'
  }
};

export function getLanguage() {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ar' || stored === 'en') return stored;
    localStorage.setItem(STORAGE_KEY, 'en');
    return 'en';
  } catch (e) {
    return 'en';
  }
}

export function setLanguage(lang) {
  const normalized = lang === 'ar' ? 'ar' : 'en';
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, normalized);
    } catch (e) {}
    try {
      document.documentElement.lang = normalized === 'ar' ? 'ar' : 'en';
      document.documentElement.dir = normalized === 'ar' ? 'rtl' : 'ltr';
    } catch (e) {}
  }
  return normalized;
}

export function t(key, lang) {
  const l = lang || getLanguage();
  return translations[l]?.[key] || translations.en?.[key] || key;
}

export function applyDocumentLanguage(lang) {
  const normalized = lang === 'ar' ? 'ar' : 'en';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = normalized === 'ar' ? 'ar' : 'en';
    document.documentElement.dir = normalized === 'ar' ? 'rtl' : 'ltr';
  }
}

export default { getLanguage, setLanguage, t, applyDocumentLanguage, translations };
