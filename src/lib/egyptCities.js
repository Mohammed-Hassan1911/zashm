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
  return EGYPT_GOVERNORATES.filter(city => city.toLowerCase().includes(q));
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