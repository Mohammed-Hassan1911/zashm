import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { SlidersHorizontal, RotateCcw, ChevronDown } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';
import { effectivePrice } from '../lib/pricing';

const SORT_OPTIONS = [
  'Newest',
  'Price: Low to High',
  'Price: High to Low',
  'Best Seller'
];

const LABELS = [
  'All',
  'New Arrival',
  'Best Seller',
  'Featured',
  'Limited Edition'
];

const normalize = (value) =>
  String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const getPrice = (product) => effectivePrice(product);

export default function ShopPage() {
  const {
    products = [],
    productsLoadStatus,
    refreshProducts,
    searchQuery,
    filterCategory,
    setFilterCategory
  } = useStore();

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
      // `sales` is not a product column (the storefront view never exposed it),
      // so the old sort always compared 0 to 0. Sort by the editorial
      // "Best Seller" label instead; ties keep the incoming order.
      list.sort(
        (a, b) => (normalize(b.label) === 'best seller' ? 1 : 0)
          - (normalize(a.label) === 'best seller' ? 1 : 0)
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
    padding: '10px 12px',
    background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.045) 0%, rgba(255, 255, 255, 0.012) 100%), rgba(18, 17, 15, 0.72)',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 8,
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
    color: 'var(--text)',
    outline: 'none'
  };

  // Size, tracking and padding live in .shop-chip so a phone media query can
  // shrink the whole row without fighting an inline style. Only the
  // state-dependent paint stays here.
  const filterButtonStyle = (selected) => ({
    border: selected
      ? '1px solid rgba(255, 240, 202, 0.3)'
      : '1px solid rgba(255, 255, 255, 0.11)',
    background: selected
      ? 'linear-gradient(135deg, #9a7a2e 0%, #c9a84c 46%, #e8c870 100%)'
      : 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01))',
    color: selected ? '#14110b' : 'var(--text2)',
    cursor: 'pointer',
    borderRadius: 2,
    boxShadow: selected ? 'inset 0 1px 0 rgba(255, 255, 255, 0.22)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
    transition: 'background 0.22s ease, color 0.22s ease, border-color 0.22s ease, box-shadow 0.22s ease',
    whiteSpace: 'nowrap'
  });

  return (
    <div
      className="shop-page"
      style={{
        minHeight: '100vh',
        color: 'var(--text)'
      }}
    >
      {/* HEADER */}
      <header className="shop-hero">
        <span className="shop-hero-glow" aria-hidden="true" />
        <motion.p
          className="shop-hero-eyebrow"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          Our Collection
        </motion.p>

        <motion.h1
          className="shop-hero-title"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.06 }}
        >
          {activeCategory}
        </motion.h1>

        <motion.span
          className="shop-hero-rule"
          aria-hidden="true"
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.18 }}
        />

        <motion.p
          className="shop-hero-count"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.24 }}
        >
          <span className="shop-hero-count-dot" aria-hidden="true" />
          {filtered.length}{' '}
          {filtered.length === 1 ? 'Piece' : 'Pieces'} Available
        </motion.p>
      </header>

      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '0 24px'
        }}
      >
        {/* MAIN FILTER BAR */}
        <div
          className="shop-toolbar"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            margin: '8px 0 26px',
            border: '1px solid rgba(255, 255, 255, 0.09)',
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.008))',
            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 14px 34px rgba(0, 0, 0, 0.18)'
          }}
        >
          {/* CATEGORIES */}
          <div
            className="shop-chip-row"
            style={{ minWidth: 0 }}
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
                  className="shop-chip"
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
            className="shop-filter-toggle"
            data-open={filterOpen ? 'true' : 'false'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              background: filterOpen
                ? 'linear-gradient(135deg, #9a7a2e 0%, #c9a84c 46%, #e8c870 100%)'
                : 'linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01))',
              border: filterOpen
                ? '1px solid rgba(255, 240, 202, 0.3)'
                : '1px solid rgba(255, 255, 255, 0.11)',
              color: filterOpen ? '#14110b' : 'var(--text2)',
              fontWeight: 600,
              textTransform: 'uppercase',
              cursor: 'pointer',
              borderRadius: 2,
              whiteSpace: 'nowrap',
              boxShadow: filterOpen
                ? 'inset 0 1px 0 rgba(255, 255, 255, 0.22)'
                : 'inset 0 1px 0 rgba(255, 255, 255, 0.05)'
            }}
          >
            <SlidersHorizontal size={14} />
            {filterOpen ? 'Close Filters' : 'Filter'}
          </button>

          {/* SORT */}
          <div className="shop-sort-wrap">
            <select
              aria-label="Sort products"
              className="shop-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              style={{
                background: 'var(--bg3)',
                border: '1px solid rgba(255, 255, 255, 0.11)',
                color: 'var(--text2)',
                fontWeight: 600,
                borderRadius: 8,
                cursor: 'pointer',
                maxWidth: '100%',
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                backgroundImage: 'linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.012) 100%)'
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <ChevronDown className="shop-sort-chevron" size={14} aria-hidden="true" />
          </div>
        </div>

        {/* FILTER PANEL */}
        {filterOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="shop-filter-panel"
            style={{
              padding: '22px clamp(16px, 2.4vw, 24px)',
              margin: '0 0 26px',
              border: '1px solid rgba(255, 255, 255, 0.09)',
              borderRadius: 14,
              background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.006))',
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
              overflow: 'hidden'
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
                    color: 'var(--gold-3)',
                    fontSize: 9,
                    letterSpacing: 3,
                    textTransform: 'uppercase'
                  }}
                >
                  Refine Your Selection
                </p>

                <h2
                  style={{
                    margin: '8px 0 0',
                    fontFamily: 'var(--font-display)',
                    fontSize: 24,
                    fontWeight: 400,
                    color: 'var(--gold-1)'
                  }}
                >
                  Shop Filters
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
                  minHeight: 44,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--gold)',
                  fontSize: 11,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  cursor: 'pointer'
                }}
              >
                <RotateCcw size={12} />
                Reset All
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
                  color: 'var(--gold-2)'
                }}
              >
                Shop by Label
              </h3>

              <div className="shop-label-chip-row">
                {LABELS.map((label) => {
                  const selected =
                    normalize(labelFilter) === normalize(label);

                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setLabelFilter(label)}
                      className="shop-chip shop-label-chip"
                      style={filterButtonStyle(selected)}
                    >
                      {label}
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
                  color: 'var(--gold-2)'
                }}
              >
                Price Range
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
                    fontSize: 9.5,
                    letterSpacing: 1.1,
                    textTransform: 'uppercase',
                    color: 'var(--text3)'
                  }}
                >
                  Minimum

                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    placeholder="No minimum"
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
                    className="price-input"
                  />
                </label>

                {/* MAX PRICE */}
                <label
                  style={{
                    display: 'block',
                    minWidth: 0,
                    fontSize: 9.5,
                    letterSpacing: 1.1,
                    textTransform: 'uppercase',
                    color: 'var(--text3)'
                  }}
                >
                  Maximum

                  <input
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    placeholder="No maximum"
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
                    className="price-input"
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
                  Minimum price cannot exceed maximum price.
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
                Leave either field empty to remove that price limit.
              </p>
            </div>
          </motion.div>
        )}

        {/* PRODUCT GRID */}
        {productsLoadStatus === 'error' && (
          <div
            role="alert"
            style={{
              marginTop: 24,
              border: '1px solid rgba(217,119,119,0.35)',
              background: 'rgba(217,119,119,0.07)',
              borderRadius: 4,
              padding: '12px 16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap'
            }}
          >
            <p style={{ fontSize: 12, color: '#d97777' }}>
              Could not load products.
            </p>
            <button
              type="button"
              onClick={refreshProducts}
              style={{
                padding: '7px 14px',
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                color: 'var(--text2)',
                cursor: 'pointer',
                fontSize: 11
              }}
            >
              Retry
            </button>
          </div>
        )}

        <div style={{ paddingBottom: 80 }}>
          {filtered.length === 0 && productsLoadStatus === 'error' && products.length === 0 ? null : filtered.length === 0 ? (
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
                No Products Found
              </p>

              <p style={{ fontSize: 12, lineHeight: 1.8 }}>
                Try adjusting your search or filters to discover more pieces.
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
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="product-collection-grid">
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