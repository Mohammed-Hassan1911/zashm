import React, { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { SlidersHorizontal } from 'lucide-react';
import { useStore } from '../store';
import ProductCard from '../components/shop/ProductCard';

const SORT_OPTIONS = [
  'Newest',
  'Price: Low to High',
  'Price: High to Low',
  'Best Rated',
  'Best Seller'
];

const LABELS = [
  'All',
  'New Arrival',
  'Best Seller',
  'Featured',
  'Limited Edition'
];

export default function ShopPage() {
  const { products, searchQuery, filterCategory, setFilterCategory } = useStore();

  const [sort, setSort] = useState('Newest');
  const [priceRange, setPriceRange] = useState([0, 3000]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState('All');

  const categories = useMemo(() => {
    const seen = new Map();
    products.forEach(p => {
      const c = (p.category || '').trim();
      if (!c) return;
      const key = c.toUpperCase();
      if (!seen.has(key)) seen.set(key, c);
    });
    return ['ALL', ...[...seen.values()].sort((a, b) => a.localeCompare(b))];
  }, [products]);

  const filtered = useMemo(() => {
    // 🎯 إخفاء المنتجات غير النشطة عن العملاء (تُفلتر في الـ storefront فقط؛ الأدمن يظل يرى الكل)
    let list = products.filter(p => p.active !== false);

    // SEARCH
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
      );
    }

    // CATEGORY FILTER (FIXED STRONG)
    if (filterCategory && filterCategory !== 'ALL') {
      list = list.filter(p =>
        (p.category || '').toUpperCase() === filterCategory.toUpperCase()
      );
    }

    // LABEL FILTER
    if (labelFilter && labelFilter !== 'All') {
      list = list.filter(p =>
        (p.label || '').toLowerCase() === labelFilter.toLowerCase()
      );
    }

    // PRICE FILTER
    list = list.filter(p => {
      const price = p.salePrice ?? p.price ?? 0;
      return price >= priceRange[0] && price <= priceRange[1];
    });

    // SORT
    if (sort === 'Price: Low to High') {
      list.sort((a, b) => (a.salePrice ?? a.price) - (b.salePrice ?? b.price));
    } else if (sort === 'Price: High to Low') {
      list.sort((a, b) => (b.salePrice ?? b.price) - (a.salePrice ?? a.price));
    } else if (sort === 'Best Rated') {
      list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    }

    return list;
  }, [products, searchQuery, filterCategory, labelFilter, priceRange, sort]);

  return (
    <div style={{ paddingTop: 90, minHeight: '100vh' }}>

      {/* HEADER */}
      <div style={{ textAlign: 'center', padding: '40px 24px 32px', borderBottom: '1px solid var(--border)' }}>
        <motion.p style={{ fontSize: 10, letterSpacing: 4, color: 'var(--gold)', textTransform: 'uppercase' }}>
          Our Collection
        </motion.p>

        <motion.h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(32px, 5vw, 64px)' }}>
          {(filterCategory || 'ALL') === 'ALL' ? 'All Products' : filterCategory}
        </motion.h1>

        <motion.p style={{ color: 'var(--text3)', fontSize: 13, marginTop: 8 }}>
          {filtered.length} pieces available
        </motion.p>
      </div>

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '0 24px' }}>

        {/* FILTER BAR */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '24px 0', borderBottom: '1px solid var(--border)' }}>

          {/* CATEGORIES */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                style={{
                  padding: '6px 14px',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  borderRadius: 2,
                  cursor: 'pointer',
                  background: filterCategory === cat ? 'var(--gold)' : 'transparent',
                  color: filterCategory === cat ? 'var(--bg)' : 'var(--text2)',
                  border: filterCategory === cat ? '1px solid var(--gold)' : '1px solid var(--border)'
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* FILTER BUTTON */}
          <button
            onClick={() => setFilterOpen(v => !v)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text2)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              borderRadius: 4
            }}
          >
            <SlidersHorizontal size={14} />
            Filter
          </button>

          {/* SORT */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            style={{
              padding: '7px 14px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              color: 'var(--text2)'
            }}
          >
            {SORT_OPTIONS.map(o => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>

        {/* FILTER PANEL */}
{filterOpen && (
  <div style={{ padding: '20px 0', borderBottom: '1px solid var(--border)' }}>

    {/* LABELS */}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      {LABELS.map(l => (
        <button
          key={l}
          onClick={() => setLabelFilter(l)}
          style={{
            // 🎯 زيادة الـ padding الرأسي والأفقي ليعطي مساحة فخمة للنص
            padding: '10px 16px', 
            fontSize: 11,
            letterSpacing: '1px', // زيادة المسافة بين الحروف لتليق ببراند Luxury
            textTransform: 'uppercase', // تأكيد الحروف الكبيرة
            lineHeight: 1, // 🎯 تضمن توطين النص بالملي رأسياً
            border: '1px solid var(--border)',
            background: labelFilter === l ? 'var(--gold)' : 'transparent',
            color: labelFilter === l ? 'var(--bg)' : 'var(--text2)',
            cursor: 'pointer',
            transition: 'all 0.2s ease', // حركة ناعمة عند الضغط
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {l}
        </button>
      ))}
    </div>

  </div>
)}

        {/* PRODUCTS */}
        <div style={{ paddingBottom: 80 }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '100px 0', color: 'var(--text3)' }}>
              No products found
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 24,
              paddingTop: 32
            }}>
              {filtered.map((p, i) => (
                <ProductCard key={p.id} product={p} index={i} />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}