import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Older payloads and cached server responses can still carry a bilingual
// "English / Arabic" message. The storefront is English-only, so keep the
// English segment and drop anything Arabic instead of rendering it.
function englishText(value) {
  const raw = String(value ?? '');
  const lines = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/[\u0600-\u06FF]/.test(line));
  if (lines.length === 0) return 'There was a problem with your order.';
  return lines.join(' ');
}

// Stock feedback for checkout. It is rendered on the form AND on the
// "empty bag" screen: when every line was removed automatically after a
// server-side stock rejection, the shopper must still see why the bag emptied.
export default function StockFeedback({ notice = [], errors = [], title = 'Stock availability issue:' }) {
  const notices = Array.isArray(notice) ? notice : [];
  const problems = Array.isArray(errors) ? errors : [];
  if (notices.length === 0 && problems.length === 0) return null;

  return (
    <div style={{ textAlign: 'left' }}>
      <AnimatePresence>
        {notices.length > 0 && (
          <motion.div key="stock-notice" initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }}
            role="status" aria-live="polite"
            style={{ background:'rgba(201,168,76,0.10)', border:'1px solid var(--border-gold)', borderRadius:6, padding:'14px 18px', marginBottom:16 }}>
            <p style={{ color:'var(--gold)', fontWeight:600, marginBottom:8, fontSize:13 }}>
              Your bag has been updated automatically.
            </p>
            {notices.map((entry, index) => (
              <div key={index} style={{ color:'var(--text)', fontSize:12, marginBottom:10, lineHeight:1.7 }}>
                {englishText(entry)}
              </div>
            ))}
          </motion.div>
        )}

        {problems.length > 0 && (
          <motion.div key="stock-errors" initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }} exit={{ opacity:0, height:0 }}
            role="alert" aria-live="assertive"
            style={{ background:'rgba(192,57,43,0.08)', border:'1px solid rgba(192,57,43,0.3)', borderRadius:6, padding:'14px 18px', marginBottom:24 }}>
            <p style={{ color:'var(--red)', fontWeight:600, marginBottom:8, fontSize:13 }}>
              {title}
            </p>
            {problems.map((entry, index) => (
              <div key={index} style={{ color:'var(--red)', fontSize:12, marginBottom:4, lineHeight:1.6 }}>
                • {englishText(entry)}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
