export const EGYPT_GOVERNORATES = [
  'Cairo',
  'Giza',
  'Alexandria',
  'Dakahlia',
  'Sharqia',
  'Qalyubia',
  'Monufia',
  'Beheira',
  'Kafr El Sheikh',
  'Gharbia',
  'Fayoum',
  'Beni Suef',
  'Minya',
  'Assiut',
  'Sohag',
  'Qena',
  'Luxor',
  'Aswan',
  'Red Sea',
  'North Sinai',
  'South Sinai',
  'Ismailia',
  'Suez',
  'Port Said',
  'Damietta',
  'Matrouh',       // 🎯 تم إضافة مطروح هنا
  'New Valley',    // 🎯 تم إضافة الوادي الجديد هنا
];

export function filterGovernorates(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return EGYPT_GOVERNORATES;
  return EGYPT_GOVERNORATES.filter(city =>
    city.toLowerCase().includes(q) || (GOVERNORATE_AR[city] || '').includes(query.trim())
  );
}

// خريطة أسماء المحافظات بالعربي (للعرض والبحث والتحويل).
export const GOVERNORATE_AR = {
  'Cairo': 'القاهرة',
  'Giza': 'الجيزة',
  'Alexandria': 'الإسكندرية',
  'Dakahlia': 'الدقهلية',
  'Sharqia': 'الشرقية',
  'Qalyubia': 'القليوبية',
  'Monufia': 'المنوفية',
  'Beheira': 'البحيرة',
  'Kafr El Sheikh': 'كفر الشيخ',
  'Gharbia': 'الغربية',
  'Fayoum': 'الفيوم',
  'Beni Suef': 'بني سويف',
  'Minya': 'المنيا',
  'Assiut': 'أسيوط',
  'Sohag': 'سوهاج',
  'Qena': 'قنا',
  'Luxor': 'الأقصر',
  'Aswan': 'أسوان',
  'Red Sea': 'البحر الأحمر',
  'North Sinai': 'شمال سيناء',
  'South Sinai': 'جنوب سيناء',
  'Ismailia': 'الإسماعيلية',
  'Suez': 'السويس',
  'Port Said': 'بورسعيد',
  'Damietta': 'دمياط',
  'Matrouh': 'مطروح',
  'New Valley': 'الوادي الجديد',
};

// يحوّل أي مدخل (إنجليزي/عربي، بأي حالة أحرف) للاسم الرسمي الإنجليزي،
// أو '' لو مفيش تطابق — نستخدمه قبل الإرسال للسيرفر.
export function toCanonicalGovernorate(value) {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const en = EGYPT_GOVERNORATES.find(g => g.toLowerCase() === raw.toLowerCase());
  if (en) return en;
  const fold = (s) => s.replace(/[إأآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/ة/g, 'ه');
  const ar = Object.keys(GOVERNORATE_AR).find(k => GOVERNORATE_AR[k] === raw || fold(GOVERNORATE_AR[k]) === fold(raw));
  return ar || '';
}

// دالة حساب الشحن الذكية المحدثة
export function getShippingCost(city) {
  if (!city) return 0;

  // المحافظات البعيدة والصعيد شاملة مطروح والوادي الجديد
  const remoteCities = [
    'Assiut',
    'Sohag',
    'Qena',
    'Luxor',
    'Aswan',
    'Red Sea',
    'North Sinai',
    'South Sinai',
    'Matrouh',     // 🎯 شحنها 100 جنيه
    'New Valley'   // 🎯 شحنها 100 جنيه
  ];

  return remoteCities.includes(city) ? 100 : 65;
}