import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { SlidersHorizontal } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

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

  const [sort, setSort] = useState('Newest');
  const [priceRange, setPriceRange] = useState([0, 3000]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState('All');

  // Categories are generated from the actual product data.
  const categories = useMemo(() => {
    const seen = new Map();

    products.forEach((product) => {
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

  const filtered = useMemo(() => {
    // Hide inactive products from customers only.
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
    // Uses the existing product.label field without changing the database.
    if (labelFilter && normalize(labelFilter) !== 'all') {
      const selectedLabel = normalize(labelFilter);

      list = list.filter(
        (product) => normalize(product.label) === selectedLabel
      );
    }

    // PRICE FILTER
    const minPrice = Number(priceRange[0]);
    const maxPrice = Number(priceRange[1]);

    list = list.filter((product) => {
      const price = getPrice(product);
      return price >= minPrice && price <= maxPrice;
    });

    // SORT A COPY, WITHOUT MUTATING THE FILTERED SOURCE ARRAY.
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

  const resetFilters = () => {
    setFilterCategory('ALL');
    setLabelFilter('All');
    setPriceRange([0, 3000]);
    setSort('Newest');
  };

  return (
    <div style={{ paddingTop: 90, minHeight: '100vh' }}>

      {/* HEADER */}
      <div
        style={{
          textAlign: 'center',
          padding: '40px 24px 32px',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <motion.p
          style={{
            fontSize: 10,
            letterSpacing: 4,
            color: 'var(--gold)',
            textTransform: 'uppercase'
          }}
        >
          Our Collection
        </motion.p>

        <motion.h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(32px, 5vw, 64px)'
          }}
        >
          {!filterCategory || normalize(filterCategory) === 'all'
            ? 'All Products'
            : filterCategory}
        </motion.h1>

        <motion.p
          style={{
            color: 'var(--text3)',
            fontSize: 13,
            marginTop: 8
          }}
        >
          {filtered.length} {filtered.length === 1 ? 'piece' : 'pieces'} available
        </motion.p>
      </div>

      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '0 24px'
        }}
      >

        {/* FILTER BAR */}
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
                  style={{
                    padding: '9px 14px',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    borderRadius: 3,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    background: selected ? 'var(--gold)' : 'transparent',
                    color: selected ? 'var(--bg)' : 'var(--text2)',
                    border: selected
                      ? '1px solid var(--gold)'
                      : '1px solid var(--border)'
                  }}
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
              padding: '10px 14px',
              background: filterOpen ? 'var(--gold)' : 'var(--bg3)',
              border: '1px solid var(--border)',
              color: filterOpen ? 'var(--bg)' : 'var(--text2)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              borderRadius: 3,
              whiteSpace: 'nowrap'
            }}
          >
            <SlidersHorizontal size={14} />
            Filter
          </button>

          {/* SORT */}
          <select
            aria-label="Sort products"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            style={{
              padding: '10px 12px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text2)',
              fontSize: 11,
              borderRadius: 3,
              cursor: 'pointer',
              maxWidth: '100%'
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        {/* FILTER PANEL */}
        {filterOpen && (
          <div
            style={{
              padding: '22px 0',
              borderBottom: '1px solid var(--border)'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 14
              }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: 'var(--text2)'
                }}
              >
                Shop by label
              </h2>

              <button
                type="button"
                onClick={resetFilters}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--gold)',
                  fontSize: 11,
                  cursor: 'pointer',
                  textDecoration: 'underline'
                }}
              >
                Reset all filters
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap'
              }}
            >
              {LABELS.map((label) => {
                const selected = normalize(labelFilter) === normalize(label);

                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setLabelFilter(label)}
                    style={{
                      padding: '11px 16px',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: 1,
                      textTransform: 'uppercase',
                      lineHeight: 1.4,
                      border: selected
                        ? '1px solid var(--gold)'
                        : '1px solid var(--border)',
                      background: selected ? 'var(--gold)' : 'transparent',
                      color: selected ? 'var(--bg)' : 'var(--text2)',
                      cursor: 'pointer',
                      borderRadius: 3,
                      transition: 'all 0.2s ease',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* PRICE RANGE */}
            <div style={{ marginTop: 24 }}>
              <h3
                style={{
                  margin: '0 0 12px',
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: 'var(--text2)'
                }}
              >
                Price range
              </h3>

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  flexWrap: 'wrap'
                }}
              >
                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Min
                  <input
                    type="number"
                    min="0"
                    value={priceRange[0]}
                    onChange={(event) => {
                      const value = Math.max(0, Number(event.target.value) || 0);

                      setPriceRange(([_, max]) => [
                        Math.min(value, max),
                        max
                      ]);
                    }}
                    style={{
                      display: 'block',
                      width: 110,
                      marginTop: 6,
                      padding: 9,
                      background: 'var(--bg3)',
                      border: '1px solid var(--border)',
                      color: 'var(--text2)',
                      borderRadius: 3
                    }}
                  />
                </label>

                <label style={{ fontSize: 12, color: 'var(--text3)' }}>
                  Max
                  <input
                    type="number"
                    min={priceRange[0]}
                    value={priceRange[1]}
                    onChange={(event) => {
                      const value = Math.max(
                        priceRange[0],
                        Number(event.target.value) || 0
                      );

                      setPriceRange(([min]) => [min, value]);
                    }}
                    style={{
                      display: 'block',
                      width: 110,
                      marginTop: 6,
                      padding: 9,
                      background: 'var(--bg3)',
                      border: '1px solid var(--border)',
                      color: 'var(--text2)',
                      borderRadius: 3
                    }}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* PRODUCTS */}
        <div style={{ paddingBottom: 80 }}>
          {filtered.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '100px 20px',
                color: 'var(--text3)'
              }}
            >
              <p style={{ fontSize: 16, marginBottom: 8 }}>
                No products found
              </p>

              <p style={{ fontSize: 12 }}>
                Try changing your search or filters.
              </p>

              <button
                type="button"
                onClick={resetFilters}
                style={{
                  marginTop: 12,
                  padding: '10px 16px',
                  background: 'var(--gold)',
                  color: 'var(--bg)',
                  border: '1px solid var(--gold)',
                  cursor: 'pointer',
                  borderRadius: 3
                }}
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 240px), 1fr))',
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