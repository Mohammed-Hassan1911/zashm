import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ShoppingBag, Trash2, Plus, Minus } from 'lucide-react';
import { useStore } from '../../store';

export default function CartDrawer() {
  const { cart, cartOpen, setCartOpen, removeFromCart, updateCartQty, cartTotal, setPage, appliedDiscount, removeAppliedDiscount } = useStore();
  const total = cartTotal() ?? 0;

  return (
    <AnimatePresence>
      {cartOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setCartOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, backdropFilter: 'blur(4px)' }}
          />
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 420, background: 'var(--bg2)', borderLeft: '1px solid var(--border)', zIndex: 2001, display: 'flex', flexDirection: 'column' }}
          >
            {/* Header */}
            <div style={{ padding: '24px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ShoppingBag size={20} color="var(--gold)" />
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600 }}>Shopping Bag</span>
                <span style={{ background: 'var(--gold)', color: 'var(--bg)', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
                  {cart.reduce((s, i) => s + i.qty, 0)}
                </span>
              </div>
              <button onClick={() => setCartOpen(false)} style={{ color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s' }}
                onMouseEnter={e => e.target.style.color = 'var(--gold)'}
                onMouseLeave={e => e.target.style.color = 'var(--text2)'}><X size={20} /></button>
            </div>

            {/* Items */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
              {cart.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                  style={{ textAlign: 'center', padding: '80px 0' }}
                >
                  <ShoppingBag size={64} color="var(--border)" style={{ margin: '0 auto 20px' }} />
                  <p style={{ color: 'var(--text3)', fontSize: 14, marginBottom: 8 }}>Your bag is empty</p>
                  <p style={{ color: 'var(--text3)', fontSize: 12 }}>Add some luxury pieces to get started</p>
                  <button className="gold-btn" style={{ marginTop: 24 }} onClick={() => { setCartOpen(false); setPage('shop'); }}>
                    Explore Collection
                  </button>
                </motion.div>
              ) : (
                <AnimatePresence>
                  {cart.map(item => (
                    <motion.div
                      key={item.key}
                      layout
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20, height: 0, marginBottom: 0 }}
                      style={{ display: 'flex', gap: 14, marginBottom: 16, padding: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 2 }}
                    >
                      <img src={item.product.images[0]} alt={item.product.name}
                        style={{ width: 80, height: 100, objectFit: 'cover', borderRadius: 1, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 500, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.product.name}</p>
                        <p style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 8 }}>{item.size} · {item.color}</p>
                        <p style={{ color: 'var(--gold)', fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
                          EGP {(((item.product?.salePrice || item.product?.price) ?? 0) * (item.qty ?? 0)).toLocaleString()}
                        </p>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 2 }}>
                            <button onClick={() => item.qty > 1 ? updateCartQty(item.key, item.qty - 1) : removeFromCart(item.key)}
                              style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>
                              <Minus size={12} />
                            </button>
                            <span style={{ fontSize: 13, minWidth: 16, textAlign: 'center' }}>{item.qty}</span>
                            <button onClick={() => updateCartQty(item.key, item.qty + 1)}
                              style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', background: 'none', border: 'none', cursor: 'pointer' }}>
                              <Plus size={12} />
                            </button>
                          </div>
                          <button onClick={() => removeFromCart(item.key)}
                            style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', transition: 'color 0.2s' }}
                            onMouseEnter={e => e.target.style.color = 'var(--red)'}
                            onMouseLeave={e => e.target.style.color = 'var(--text3)'}><Trash2 size={14} /></button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>

            {/* Footer */}
            {cart.length > 0 && (
              <div style={{ padding: 24, borderTop: '1px solid var(--border)' }}>
                {appliedDiscount && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '8px 12px', background: 'rgba(201,168,76,0.08)', border: '1px solid var(--border-gold)', borderRadius: 2 }}>
                    <span style={{ color: 'var(--gold)', fontSize: 12 }}>🎉 {appliedDiscount.code} applied</span>
                    <button onClick={removeAppliedDiscount} style={{ color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Remove</button>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                  <span style={{ color: 'var(--text2)', fontSize: 13 }}>Total</span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, color: 'var(--gold)' }}>EGP {total.toLocaleString()}</span>
                </div>
                <button className="gold-btn" style={{ width: '100%', marginBottom: 10 }}
                  onClick={() => { setCartOpen(false); setPage('checkout'); }}>
                  Proceed to Checkout
                </button>
                <button className="outline-btn" style={{ width: '100%' }}
                  onClick={() => { setCartOpen(false); setPage('cart'); }}>
                  View Full Cart
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
