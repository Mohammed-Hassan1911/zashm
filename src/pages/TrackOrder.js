import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store'; 
import { api } from '../lib/api';
import { Search, Package, MapPin, Phone, Calendar, ArrowRight } from 'lucide-react';

const STATUS_COLORS = {
  Pending: '#f39c12',
  Confirmed: '#3498db',
  Processing: '#9b59b6',
  Shipped: '#1abc9c',
  Delivered: '#2ecc71',
  Cancelled: '#e74c3c'
};

const STATUS_FLOW = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered'];

export default function TrackOrder() {
  const storeSearchQuery = useStore((state) => state.searchQuery); // 🎯 استدعاء الـ ID المحقون من الـ Store
  const [inputOrderId, setInputOrderId] = useState('');
  const [activeOrderId, setActiveOrderId] = useState('');
  const [currentOrder, setCurrentOrder] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loadingTrack, setLoadingTrack] = useState(false);
  const trackTokenRef = useRef('');

  // 🎯 لقط الـ tk (رمز التتبع) من رابط المتصفح للوصول الكامل للطلب
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    trackTokenRef.current = params.get('tk') || '';
  }, []);

  // 🎯 لقط الأوردر أوتوماتيكياً سواء من الـ Store أو من رابط المتصفح مباشرة
  useEffect(() => {
    if (storeSearchQuery) {
      setActiveOrderId(storeSearchQuery.trim());
      setInputOrderId(storeSearchQuery.trim());
    } else {
      const params = new URLSearchParams(window.location.search);
      const idFromUrl = params.get('track');
      if (idFromUrl) {
        setActiveOrderId(idFromUrl.trim());
        setInputOrderId(idFromUrl.trim());
      }
    }
  }, [storeSearchQuery]);

  // البحث عن الطلب عبر السيرفر (لا يوجد نسخ محلية من الطلبات لضمان الخصوصية)
  useEffect(() => {
    if (!activeOrderId) {
      setCurrentOrder(null);
      setNotFound(false);
      return;
    }
    const id = activeOrderId.trim();
    let cancelled = false;
    setLoadingTrack(true);
    setNotFound(false);
    setCurrentOrder(null);

    (async () => {
      try {
        const tk = trackTokenRef.current;
        const qs = `/orders?track=${encodeURIComponent(id)}${tk ? `&tk=${encodeURIComponent(tk)}` : ''}`;
        const payload = await api.get(qs);
        if (cancelled) return;
        if (payload && payload.found && payload.order) {
          setCurrentOrder(payload.order);
        } else {
          setNotFound(true);
        }
      } catch (err) {
        if (cancelled) return;
        setNotFound(true);
      } finally {
        if (!cancelled) setLoadingTrack(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeOrderId]);

  const handleSearchSubmit = (e) => {
    e.preventDefault(); // 🎯 منع تحديث الصفحة أو الاتصال الخارجي نهائياً
    if (inputOrderId.trim()) {
      setActiveOrderId(inputOrderId.trim());
    }
  };

  return (
    <div style={{ 
      maxWidth: 600, 
      margin: '0 auto', // 🎯 تم التعديل ليكون التباعد معتمد كلياً على الـ paddingTop في الأعلى والأسفل
      padding: '150px 16px 60px', // 🎯 تم رفع الـ paddingTop لـ 150px لإعطاء مساحة تنفس تحت الـ Navbar الثابت
      minHeight: '80vh',
      fontFamily: 'sans-serif',
      color: 'var(--text1)' 
    }}>
      {/* ─── الهيدر والبحث ─── */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <h1 style={{ fontFamily: 'var(--font-display, serif)', fontSize: 28, color: 'var(--gold)', marginBottom: 8, letterSpacing: 1 }}>
          Track Your Order
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 24 }}>
          Enter your Order ID received via WhatsApp to follow your live shipment status.
        </p>

        <form onSubmit={handleSearchSubmit} style={{ position: 'relative', display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)' }} />
            <input 
              value={inputOrderId} 
              onChange={e => setInputOrderId(e.target.value)} 
              placeholder="e.g. ZSH-MQZUYMH6-HAD6" 
              style={{ 
                width: '100%', 
                padding: '12px 14px 12px 40px', 
                background: 'var(--bg2)', 
                border: '1px solid var(--border)', 
                borderRadius: 8,
                color: 'var(--text1)',
                fontSize: 14,
                outline: 'none'
              }} 
            />
          </div>
          <button type="submit" style={{
            padding: '0 20px',
            background: 'var(--gold)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 8,
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4
          }}>
            Track <ArrowRight size={14} />
          </button>
        </form>
      </div>

      {/* ─── حالة عدم إدخال طلب أو طلب غير موجود ─── */}
      {!currentOrder && activeOrderId && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ textAlign: 'center', padding: '30px 16px', background: 'var(--bg2)', borderRadius: 8, border: '1px solid var(--border)' }}>
{loadingTrack ? (
            <p style={{ color: 'var(--text3)', fontSize: 14 }}>Loading your order...</p>
          ) : notFound ? (
            <>
              <p style={{ color: 'var(--text2)', fontSize: 14, fontWeight: 500 }}>⚠️ We couldn't find an order with ID: <span style={{ color: 'var(--gold)', fontFamily: 'monospace' }}>{activeOrderId}</span></p>
              <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 4 }}>Please double check the ID from your invoice or contact support.</p>
            </>
          ) : (
            <p style={{ color: 'var(--text3)', fontSize: 13 }}>Enter your order ID above to track it.</p>
          )}
        </motion.div>
      )}

      {/* ─── تفاصيل الطلب والتايم لاين ─── */}
      {currentOrder && (
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          
          {/* كارت الحالة السريعة */}
          <div style={{ 
            background: 'var(--bg2)', 
            border: '1px solid var(--border)', 
            borderRadius: 12, 
            padding: 20, 
            marginBottom: 20,
            boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
              <div>
                <p style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>Order reference</p>
                <h2 style={{ fontSize: 16, color: 'var(--gold)', fontFamily: 'monospace', fontWeight: 700, marginTop: 2 }}>{currentOrder.id}</h2>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>Current Status</p>
                <span style={{ 
                  display: 'inline-block',
                  fontSize: 12, 
                  padding: '4px 12px', 
                  borderRadius: 20, 
                  background: `${STATUS_COLORS[currentOrder.status] || 'var(--gold)'}1a`, 
                  color: STATUS_COLORS[currentOrder.status] || 'var(--gold)', 
                  fontWeight: 700,
                  marginTop: 4
                }}>
                  {currentOrder.status}
                </span>
              </div>
            </div>

            {/* التايم لاين الملون */}
            <div style={{ overflowX: 'auto', paddingBottom: 10, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 460, padding: '10px 5px' }}>
                {currentOrder.status === 'Cancelled' ? (
                  <div style={{ width: '100%', textAlign: 'center', padding: '10px', background: 'rgba(231, 76, 60, 0.1)', border: '1px dashed #e74c3c', borderRadius: 6, color: '#e74c3c', fontSize: 13, fontWeight: 600 }}>
                    ❌ This order has been cancelled.
                  </div>
                ) : (
                  STATUS_FLOW.map((s, i) => {
                    const indexCurrent = STATUS_FLOW.indexOf(currentOrder.status);
                    const reached = indexCurrent >= i;
                    const isCurrent = currentOrder.status === s;

                    return (
                      <React.Fragment key={s}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
                          <motion.div 
                            animate={isCurrent ? { scale: [1, 1.15, 1] } : {}}
                            transition={isCurrent ? { repeat: Infinity, duration: 2 } : {}}
                            style={{ 
                              width: 26, 
                              height: 26, 
                              borderRadius: '50%', 
                              background: reached ? STATUS_COLORS[s] : 'var(--bg)', 
                              border: `2px solid ${reached ? STATUS_COLORS[s] : 'var(--border)'}`, 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'center',
                              boxShadow: isCurrent ? `0 0 10px ${STATUS_COLORS[s]}` : 'none'
                            }}
                          >
                            {reached ? (
                              <span style={{ fontSize: 10, color: 'white', fontWeight: 'bold' }}>✓</span>
                            ) : (
                              <span style={{ fontSize: 9, color: 'var(--text3)' }}>{i + 1}</span>
                            )}
                          </motion.div>
                          <p style={{ 
                            fontSize: 10, 
                            color: reached ? 'var(--text1)' : 'var(--text3)', 
                            fontWeight: isCurrent ? 700 : 500,
                            textAlign: 'center', 
                            whiteSpace: 'nowrap' 
                          }}>
                            {s}
                          </p>
                        </div>
                        {i < STATUS_FLOW.length - 1 && (
                          <div style={{ 
                            flex: 1, 
                            height: 2, 
                            background: indexCurrent > i ? 'var(--gold)' : 'var(--border)', 
                            marginBottom: 16,
                            marginLeft: 4,
                            marginRight: 4
                          }} />
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* معلومات الشحن والتوصيل */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ gridColumn: 'span 2', borderBottom: '1px solid var(--border)', paddingBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <MapPin size={14} style={{ color: 'var(--gold)' }} />
              <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Shipping Details</span>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <p style={{ fontSize: 13, fontWeight: 500 }}>{currentOrder.customer || 'Valued Gentlemen'}</p>
              <p style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4, lineHeight: '1.4' }}>{currentOrder.address || 'Address provided upon confirmation'}{currentOrder.city ? `, ${currentOrder.city}` : ''}</p>
            </div>
            <div>
              <p style={{ fontSize: 10, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 4 }}><Phone size={10} /> Contact Phone</p>
              <p style={{ fontSize: 12, fontWeight: 500, marginTop: 2 }}>{currentOrder.phone || '—'}</p>
            </div>
            <div>
              <p style={{ fontSize: 10, color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: 4 }}><Calendar size={10} /> Order Date</p>
              <p style={{ fontSize: 12, fontWeight: 500, marginTop: 2 }}>{currentOrder.date || '—'}</p>
            </div>
          </div>

          {/* ملخص المنتجات والأسعار */}
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Package size={14} style={{ color: 'var(--gold)' }} />
              <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Package Items</span>
            </div>
            
            {Array.isArray(currentOrder.items) ? (
              currentOrder.items.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: i < currentOrder.items.length - 1 ? '1px dashed var(--border)' : 'none' }}>
                  {item.image && <img src={item.image} alt={item.name} style={{ width: 40, height: 50, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</p>
                    <p style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                      {[item.size, item.color].filter(Boolean).join(' · ')} · Qty: {item.qty || item.quantity || 1}
                    </p>
                  </div>
                  <p style={{ color: 'var(--text2)', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>EGP {item.price?.toLocaleString()}</p>
                </div>
              ))
            ) : (
              <div style={{ padding: '10px 0', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
                {String(currentOrder.items || 'Standard Package')}
              </div>
            )}

            {/* تفاصيل الحسابات النهائية */}
            <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              {currentOrder.subtotal && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text3)', fontSize: 12 }}>Subtotal</span>
                  <span style={{ fontSize: 12, color: 'var(--text1)' }}>EGP {currentOrder.subtotal.toLocaleString()}</span>
                </div>
              )}
              
              {currentOrder.discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: '#27ae60', fontSize: 12 }}>Discount Applied</span>
                  <span style={{ color: '#27ae60', fontSize: 12 }}>-EGP {currentOrder.discount.toLocaleString()}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--border)' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Total Amount</span>
                <span style={{ color: 'var(--gold)', fontSize: 16, fontWeight: 700 }}>
                  EGP {(currentOrder.total || currentOrder.subtotal || 0).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

        </motion.div>
      )}
    </div>
  );
}