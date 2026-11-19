import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { api } from '../lib/api';
import { Search, Package, MapPin, Calendar, ArrowRight } from 'lucide-react';
import SafeImage from '../components/ui/SafeImage';

const STATUS_COLORS = {
  Pending: '#f39c12',
  Confirmed: '#3498db',
  Processing: '#9b59b6',
  Shipped: '#c9a84c',
  Delivered: '#2ecc71',
  Cancelled: '#e74c3c'
};

const STATUS_FLOW = ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered'];

export default function TrackOrder() {
  const [inputOrderId, setInputOrderId] = useState('');
  const [activeOrderId, setActiveOrderId] = useState('');
  const [currentOrder, setCurrentOrder] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [missingToken, setMissingToken] = useState(false);
  const [loadingTrack, setLoadingTrack] = useState(false);
  // 🎯 لقط الأوردر أوتوماتيكياً: رابط التتبع الآمن (?track=...&tk=...) هو المصدر
  // الوحيد. نص بحث المنتجات في الـ store ليس رقم طلب ويجب ألا يملأ هذا الحقل.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get('track');
    const id = (idFromUrl || '').trim();
    if (id) {
      setActiveOrderId(id);
      setInputOrderId(id);
    }
  }, []);

  // البحث عن الطلب عبر السيرفر (لا يوجد نسخ محلية من الطلبات لضمان الخصوصية)
  useEffect(() => {
    if (!activeOrderId) {
      setCurrentOrder(null);
      setNotFound(false);
      setMissingToken(false);
      return;
    }
    const id = activeOrderId.trim();
    // SEC-16: the token in the secure link (?tk=...) is the credential. An
    // order id on its own is never enough to look anything up.
    const tk = (new URLSearchParams(window.location.search).get('tk') || '').trim();
    if (!tk) {
      setCurrentOrder(null);
      setNotFound(false);
      setMissingToken(true);
      setLoadingTrack(false);
      return;
    }
    let cancelled = false;
    setLoadingTrack(true);
    setNotFound(false);
    setMissingToken(false);
    setCurrentOrder(null);

    (async () => {
      try {
        const qs = `/orders?track=${encodeURIComponent(id)}&tk=${encodeURIComponent(tk)}`;
        const payload = await api.get(qs);
        if (cancelled) return;
        if (payload && payload.found && payload.order) {
          setCurrentOrder({ ...payload.order, access: payload.access || 'full' });
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

  const shippingAmount = currentOrder
    ? Math.max(0, (currentOrder.total || 0) - (currentOrder.subtotal || 0) + (currentOrder.discount || 0))
    : 0;

  const handleSearchSubmit = (e) => {
    e.preventDefault(); // 🎯 منع تحديث الصفحة أو الاتصال الخارجي نهائياً
    const id = inputOrderId.trim();
    if (!id) return;
    setActiveOrderId(id);
    // حافظ على رقم الطلب في الرابط حتى لا يضيع عند التحديث (الـ tk يظل كما هو).
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('track', id);
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (err) {
      /* history may be unavailable in some embedded browsers */
    }
  };

  const statusColor = STATUS_COLORS[currentOrder?.status] || 'var(--gold)';

  return (
    <div className="track-page">
      {/* ─── الهيدر والبحث ─── */}
      <header className="track-hero">
        <p className="track-eyebrow">Order tracking</p>
        <h1 className="track-title">Track Your Order</h1>

        <form onSubmit={handleSearchSubmit} className="track-form">
          <div className="track-input-wrap">
            <Search size={16} className="track-input-icon" aria-hidden="true" />
            <input
              value={inputOrderId}
              onChange={e => setInputOrderId(e.target.value)}
              placeholder="Order ID from your secure link"
              aria-label="Order ID"
              autoComplete="off"
              className="track-input"
            />
          </div>
          <button type="submit" className="track-submit">
            Track <ArrowRight size={14} aria-hidden="true" />
          </button>
        </form>
      </header>

      {/* ─── حالة عدم إدخال طلب أو طلب غير موجود ─── */}
      {!currentOrder && activeOrderId && (
        <motion.div
          className="track-card track-notice"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          {loadingTrack ? (
            <p className="track-notice-copy">Loading your order...</p>
          ) : missingToken ? (
            <>
              <p className="track-notice-title">A secure tracking link is required.</p>
              <p className="track-notice-copy">
                For your privacy, orders can only be tracked through the secure link sent with your order confirmation.
              </p>
            </>
          ) : notFound ? (
            <>
              <p className="track-notice-title">
                We couldn&apos;t find an order with ID:{' '}
                <span className="track-notice-id">{activeOrderId}</span>
              </p>
              <p className="track-notice-copy">
                The link may be incomplete or no longer valid. Please contact support.
              </p>
            </>
          ) : (
            <p className="track-notice-copy">Open the secure tracking link from your order confirmation.</p>
          )}
        </motion.div>
      )}

      {/* ─── تفاصيل الطلب والتايم لاين ─── */}
      {currentOrder && (
        <motion.div
          className="track-stack"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* كارت الحالة السريعة */}
          <section className="track-card" aria-label="Order status">
            <div className="track-status-head">
              <div className="track-ref">
                <p className="track-label">Order reference</p>
                <h2 className="track-ref-value">{currentOrder.id}</h2>
              </div>
              <div className="track-status-side">
                <p className="track-label">Current status</p>
                <span
                  className="track-status-pill"
                  style={{
                    background: `${statusColor}1a`,
                    color: statusColor,
                  }}
                >
                  {currentOrder.status}
                </span>
              </div>
            </div>

            {currentOrder.status === 'Cancelled' ? (
              <p className="track-cancelled">This order has been cancelled.</p>
            ) : (
              <ol className="track-timeline" aria-label="Delivery progress">
                {STATUS_FLOW.map((step, index) => {
                  const currentIndex = STATUS_FLOW.indexOf(currentOrder.status);
                  const reached = currentIndex >= index;
                  const isCurrent = currentOrder.status === step;

                  return (
                    <li
                      key={step}
                      className={[
                        'track-step',
                        reached ? 'is-reached' : '',
                        isCurrent ? 'is-current' : '',
                      ].filter(Boolean).join(' ')}
                      aria-current={isCurrent ? 'step' : undefined}
                    >
                      <span className="track-node" aria-hidden="true">
                        {reached ? '✓' : index + 1}
                      </span>
                      <span className="track-step-label">{step}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {/* معلومات الشحن والتوصيل */}
          <section className="track-card" aria-label="Shipping details">
            <div className="track-card-head">
              <MapPin size={14} aria-hidden="true" />
              <span>Shipping details</span>
            </div>
            <div className="track-shipping-grid">
              <div style={{ minWidth: 0 }}>
                <p className="track-customer">{currentOrder.customer || 'Valued Gentlemen'}</p>
                <p className="track-address">
                  {currentOrder.address || 'Address provided upon confirmation'}
                  {currentOrder.city ? `, ${currentOrder.city}` : ''}
                </p>
              </div>
              <div style={{ minWidth: 0 }}>
                <p className="track-date-label">
                  <Calendar size={10} aria-hidden="true" /> Order date
                </p>
                <p className="track-date">{currentOrder.date || '—'}</p>
              </div>
            </div>
          </section>

          {/* ملخص المنتجات والأسعار */}
          <section className="track-card" aria-label="Package items">
            <div className="track-card-head">
              <Package size={14} aria-hidden="true" />
              <span>Package items</span>
            </div>

            {Array.isArray(currentOrder.items) ? (
              currentOrder.items.map((item, i) => (
                <div
                  key={i}
                  className="track-line"
                  style={{ borderBottom: i < currentOrder.items.length - 1 ? '1px dashed rgba(255,255,255,0.08)' : 'none' }}
                >
                  {item.image && (
                    <SafeImage
                      src={item.image}
                      alt={item.name}
                      fallback={'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="50"%3E%3Crect fill="%23222" width="40" height="50"/%3E%3C/svg%3E'}
                      className="track-line-thumb"
                      style={{ width: 40, height: 50, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                    />
                  )}
                  <div className="track-line-copy">
                    <p className="track-line-name">{item.name}</p>
                    <p className="track-line-meta">
                      {[item.size, item.color].filter(Boolean).join(' · ')} · Qty: {item.qty || item.quantity || 1}
                    </p>
                  </div>
                  <p className="track-line-price">EGP {Number(item.price || 0).toLocaleString()}</p>
                </div>
              ))
            ) : (
              <p className="track-notice-copy">{String(currentOrder.items || 'Standard Package')}</p>
            )}

            {/* تفاصيل الحسابات النهائية */}
            <div className="track-totals">
              {Number(currentOrder.subtotal) > 0 && (
                <div className="track-total-row">
                  <span>Subtotal</span>
                  <span>EGP {Number(currentOrder.subtotal).toLocaleString()}</span>
                </div>
              )}

              {Number(currentOrder.discount) > 0 && (
                <div className="track-total-row track-discount">
                  <span>Discount applied</span>
                  <span>-EGP {Number(currentOrder.discount).toLocaleString()}</span>
                </div>
              )}

              {shippingAmount > 0 && (
                <div className="track-total-row">
                  <span>Shipping</span>
                  <span>EGP {shippingAmount.toLocaleString()}</span>
                </div>
              )}

              <div className="track-grand-row">
                <span>Total amount</span>
                <strong>EGP {Number(currentOrder.total || currentOrder.subtotal || 0).toLocaleString()}</strong>
              </div>
            </div>
          </section>
        </motion.div>
      )}
    </div>
  );
}
