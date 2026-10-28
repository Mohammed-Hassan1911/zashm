import React, { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import { getLanguage, t } from '../lib/i18n';

const SORT_KEYS = [
  { key: 'Newest', en: 'Newest', ar: 'الأحدث' },
  { key: 'Price: Low to High', en: 'Price: Low to High', ar: 'السعر: من الأقل للأعلى' },
  { key: 'Price: High to Low', en: 'Price: High to Low', ar: 'السعر: من الأعلى للأقل' },
  { key: 'Best Seller', en: 'Best Seller', ar: 'الأكثر مبيعًا' }
];

const LABEL_KEYS = [
  { key: 'All', en: 'All', ar: 'الكل' },
  { key: 'New Arrival', en: 'New Arrival', ar: 'وصل حديثًا' },
  { key: 'Best Seller', en: 'Best Seller', ar: 'الأكثر مبيعًا' },
  { key: 'Featured', en: 'Featured', ar: 'مميز' },
  { key: 'Limited Edition', en: 'Limited Edition', ar: 'إصدار محدود' }
];

const normalize = (value) =>
  String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const getPrice = (product) => {
  const salePrice = Number(product.salePrice);
  const regularPrice = Number(product.price);

  if (
    product.salePrice !== null &&
    product.salePrice !== undefined &&
    product.salePrice !== '' &&
    Number.isFinite(salePrice) &&
    salePrice >= 0
  ) {
    return salePrice;
  }

  return Number.isFinite(regularPrice) && regularPrice >= 0
    ? regularPrice
    : 0;
};

export default function ShopPage() {
  const {
    products = [],
    searchQuery,
    filterCategory,
    setFilterCategory
  } = useStore();

  const [lang, setLang] = useState(getLanguage());
  useEffect(() => {
    const handler = () => setLang(getLanguage());
    window.addEventListener('languagechange', handler);
    return () => window.removeEventListener('languagechange', handler);
  }, []);

  const [sort, setSort] = useState('Newest');
  const [priceRange, setPriceRange] = useState({
    min: '',
    max: ''
  });
  const [filterOpen, setFilterOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState('All');

  // PRODUCT CATEGORIES (only from products visible in the storefront, so a
  // category with no active products never shows up as an empty grid).
  const categories = useMemo(() => {
    const seen = new Map();

    products.forEach((product) => {
      if (product.active === false) return;

      const category = String(product.category ?? '').trim();

      if (!category) return;

      const key = normalize(category);

      if (!seen.has(key)) {
        seen.set(key, category);
      }
    });

    return [
      'ALL',
      ...[...seen.values()].sort((a, b) => a.localeCompare(b))
    ];
  }, [products]);

  // FILTER AND SORT PRODUCTS
  const filtered = useMemo(() => {
    // Hide inactive products from the storefront.
    let list = products.filter(
      (product) => product.active !== false
    );

    // SEARCH
    const query = normalize(searchQuery);

    if (query) {
      list = list.filter((product) =>
        normalize(product.name).includes(query) ||
        normalize(product.category).includes(query)
      );
    }

    // CATEGORY FILTER
    if (filterCategory && normalize(filterCategory) !== 'all') {
      const selectedCategory = normalize(filterCategory);

      list = list.filter(
        (product) => normalize(product.category) === selectedCategory
      );
    }

    // MANUAL LABEL FILTER
    if (labelFilter && normalize(labelFilter) !== 'all') {
      const selectedLabel = normalize(labelFilter);

      list = list.filter(
        (product) => normalize(product.label) === selectedLabel
      );
    }

    // PRICE FILTER
    const minPrice =
      priceRange.min.trim() === ''
        ? 0
        : Number(priceRange.min);

    const maxPrice =
      priceRange.max.trim() === ''
        ? Infinity
        : Number(priceRange.max);

    const validMin = Number.isFinite(minPrice) ? minPrice : 0;
    const validMax = Number.isFinite(maxPrice) ? maxPrice : Infinity;

    // Avoid showing misleading results if the range is invalid.
    if (validMin <= validMax) {
      list = list.filter((product) => {
        const price = getPrice(product);

        return price >= validMin && price <= validMax;
      });
    } else {
      list = [];
    }

    // SORT A COPY; DO NOT MUTATE THE ORIGINAL PRODUCTS ARRAY.
    list = [...list];

    if (sort === 'Price: Low to High') {
      list.sort((a, b) => getPrice(a) - getPrice(b));
    } else if (sort === 'Price: High to Low') {
      list.sort((a, b) => getPrice(b) - getPrice(a));
    } else if (sort === 'Best Seller') {
      list.sort(
        (a, b) => (Number(b.sales) || 0) - (Number(a.sales) || 0)
      );
    }

    return list;
  }, [
    products,
    searchQuery,
    filterCategory,
    labelFilter,
    priceRange,
    sort
  ]);

  // RESET FILTERS
  const resetFilters = () => {
    setFilterCategory('ALL');
    setLabelFilter('All');
    setPriceRange({
      min: '',
      max: ''
    });
    setSort('Newest');
  };

  const activeCategory =
    !filterCategory || normalize(filterCategory) === 'all'
      ? 'All Products'
      : filterCategory;

  const selectedPriceRangeIsInvalid =
    priceRange.min.trim() !== '' &&
    priceRange.max.trim() !== '' &&
    Number(priceRange.min) > Number(priceRange.max);

  const inputStyle = {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    marginTop: 8,
    padding: '12px 14px',
    background: 'var(--bg3)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none'
  };

  const filterButtonStyle = (selected) => ({
    padding: '10px 15px',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: 'uppercase',
    border: selected
      ? '1px solid var(--gold)'
      : '1px solid var(--border)',
    background: selected ? 'var(--gold)' : 'transparent',
    color: selected ? 'var(--bg)' : 'var(--text2)',
    cursor: 'pointer',
    borderRadius: 3,
    transition: 'background 0.2s ease, color 0.2s ease',
    whiteSpace: 'nowrap'
  });

  return (
    <div
      style={{
        paddingTop: 90,
        minHeight: '100vh',
        color: 'var(--text)'
      }}
    >
      {/* HEADER */}
      <div
        style={{
          textAlign: 'center',
          padding: '40px 24px 32px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            fontSize: 10,
            letterSpacing: 4,
            color: 'var(--gold)',
            textTransform: 'uppercase'
          }}
        >
          {lang === 'ar' ? 'مجموعتنا' : 'Our Collection'}
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 5vw, 64px)',
            fontWeight: 400,
            margin: '12px 0'
          }}
        >
          {activeCategory}
        </motion.h1>

        <motion.p
          style={{
            color: 'var(--text3)',
            fontSize: 12,
            marginTop: 8,
            letterSpacing: 1
          }}
        >
          {filtered.length}{' '}
          {lang === 'ar' ? (filtered.length === 1 ? 'قطعة' : 'قطع') : (filtered.length === 1 ? 'PIECE' : 'PIECES')} {lang === 'ar' ? 'متاحة' : 'AVAILABLE'}
        </motion.p>
      </div>

      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '0 24px'
        }}
      >
        {/* MAIN FILTER BAR */}
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '24px 0',
            borderBottom: '1px solid var(--border)'
          }}
        >
          {/* CATEGORIES */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              flex: '1 1 300px'
            }}
          >
            {categories.map((category) => {
              const selected =
                normalize(filterCategory || 'ALL') === normalize(category);

              return (
                <button
                  key={category}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilterCategory(category)}
                  style={filterButtonStyle(selected)}
                >
                  {category}
                </button>
              );
            })}
          </div>

          {/* FILTER TOGGLE */}
          <button
            type="button"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '11px 15px',
              background: filterOpen ? 'var(--gold)' : 'var(--bg3)',
              border: '1px solid var(--border)',
              color: filterOpen ? 'var(--bg)' : 'var(--text2)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: 1,
              cursor: 'pointer',
              borderRadius: 3,
              whiteSpace: 'nowrap'
            }}
          >
            <SlidersHorizontal size={14} />
            {filterOpen ? (lang === 'ar' ? 'إغلاق الفلاتر' : 'Close Filters') : (lang === 'ar' ? 'فلتر' : 'Filter')}
          </button>

          {/* SORT */}
          <select
            aria-label={lang === 'ar' ? 'ترتيب المنتجات' : 'Sort products'}
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            style={{
              padding: '11px 12px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text2)',
              fontSize: 10,
              borderRadius: 3,
              cursor: 'pointer',
              maxWidth: '100%'
            }}
          >
            {SORT_KEYS.map((option) => (
              <option key={option.key} value={option.key}>
                {lang === 'ar' ? option.ar : option.en}
              </option>
            ))}
          </select>
        </div>

        {/* FILTER PANEL */}
        {filterOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            style={{
              padding: '24px 0',
              borderBottom: '1px solid var(--border)'
            }}
          >
            {/* PANEL HEADER */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 18
              }}
            >
              <div>
                <p
                  style={{
                    margin: 0,
                    color: 'var(--gold)',
                    fontSize: 9,
                    letterSpacing: 3,
                    textTransform: 'uppercase'
                  }}
                >
                  {lang === 'ar' ? 'تحسين التحديد' : 'Refine Your Selection'}
                </p>

                <h2
                  style={{
                    margin: '8px 0 0',
                    fontFamily: 'var(--font-display)',
                    fontSize: 24,
                    fontWeight: 400
                  }}
                >
                  {lang === 'ar' ? 'فلاتر المتجر' : 'Shop Filters'}
                </h2>
              </div>

              <button
                type="button"
                onClick={resetFilters}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '9px 0',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--gold)',
                  fontSize: 10,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  cursor: 'pointer'
                }}
              >
                <RotateCcw size={12} />
                {lang === 'ar' ? 'إعادة تعيين الكل' : 'Reset All'}
              </button>
            </div>

            {/* LABEL FILTER */}
            <div>
              <h3
                style={{
                  margin: '0 0 12px',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: 'var(--text2)'
                }}
              >
                {lang === 'ar' ? 'تسوق حسب التصنيف' : 'Shop by Label'}
              </h3>

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap'
                }}
              >
                {LABEL_KEYS.map((label) => {
                  const selected =
                    normalize(labelFilter) === normalize(label.key);

                  return (
                    <button
                      key={label.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setLabelFilter(label.key)}
                      style={filterButtonStyle(selected)}
                    >
                      {lang === 'ar' ? label.ar : label.en}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* PRICE FILTER */}
            <div style={{ marginTop: 28 }}>
              <h3
                style={{
                  margin: '0 0 14px',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: 'var(--text2)'
                }}
              >
                {lang === 'ar' ? 'نطاق السعر' : 'Price Range'}
              </h3>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 150px))',
                  gap: 14,
                  maxWidth: 320
                }}
              >
                {/* MIN PRICE */}
                <label
                  style={{
                    display: 'block',
                    minWidth: 0,
                    fontSize: 10,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    color: 'var(--text3)'
                  }}
                >
                  {lang === 'ar' ? 'الحد الأدنى' : 'Minimum'}

                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    placeholder={lang === 'ar' ? 'بدون حد أدنى' : 'No minimum'}
                    value={priceRange.min}
                    onChange={(event) => {
                      const value = event.target.value;

                      if (value !== '' && Number(value) < 0) return;

                      setPriceRange((previous) => ({
                        ...previous,
                        min: value
                      }));
                    }}
                    style={inputStyle}
                  />
                </label>

                {/* MAX PRICE */}
                <label
                  style={{
                    display: 'block',
                    minWidth: 0,
                    fontSize: 10,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    color: 'var(--text3)'
                  }}
                >
                  {lang === 'ar' ? 'الحد الأقصى' : 'Maximum'}

                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    placeholder={lang === 'ar' ? 'بدون حد أقصى' : 'No maximum'}
                    value={priceRange.max}
                    onChange={(event) => {
                      const value = event.target.value;

                      if (value !== '' && Number(value) < 0) return;

                      setPriceRange((previous) => ({
                        ...previous,
                        max: value
                      }));
                    }}
                    style={inputStyle}
                  />
                </label>
              </div>

              {selectedPriceRangeIsInvalid && (
                <p
                  role="alert"
                  style={{
                    marginTop: 10,
                    color: '#d97777',
                    fontSize: 12
                  }}
                >
                  {lang === 'ar' ? 'يجب أن يكون السعر الأدنى أقل من السعر الأقصى.' : 'Minimum price cannot exceed maximum price.'}
                </p>
              )}

              <p
                style={{
                  marginTop: 12,
                  color: 'var(--text3)',
                  fontSize: 11,
                  lineHeight: 1.6
                }}
              >
                {lang === 'ar' ? 'اترك أحد الحقول فارغًا لإزالة حد السعر.' : 'Leave either field empty to remove that price limit.'}
              </p>
            </div>
          </motion.div>
        )}

        {/* PRODUCT GRID */}
        <div style={{ paddingBottom: 80 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '100px 20px',
                color: 'var(--text3)'
              }}
            >
              <p
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 26,
                  color: 'var(--text2)',
                  marginBottom: 10
                }}
              >
                {lang === 'ar' ? 'لا توجد منتجات' : 'No Products Found'}
              </p>

              <p style={{ fontSize: 12, lineHeight: 1.8 }}>
                {lang === 'ar' ? 'جرب تعديل البحث أو الفلاتر لاكتشاف المزيد.' : 'Try adjusting your search or filters to discover more pieces.'}
              </p>

              <button
                type="button"
                onClick={resetFilters}
                style={{
                  marginTop: 18,
                  padding: '12px 20px',
                  background: 'var(--gold)',
                  color: 'var(--bg)',
                  border: '1px solid var(--gold)',
                  cursor: 'pointer',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 1,
                  textTransform: 'uppercase'
                }}
              >
                {lang === 'ar' ? 'إعادة تعيين الفلاتر' : 'Reset Filters'}
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
                gap: 24,
                paddingTop: 32
              }}
            >
              {filtered.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  index={index}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}