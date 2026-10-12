import React from 'react';
import { motion } from 'framer-motion';

const WHATSAPP_NUMBER = '201013380313'; // store support line (01013380313)
const MESSAGE = 'Hello ZASHM, I would like to know more about your collection.';

export default function WhatsAppButton() {
  const href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(MESSAGE)}`;
  return (
    <motion.a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with ZASHM on WhatsApp"
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 1, type: 'spring', stiffness: 200 }}
      whileHover={{ scale: 1.08, backgroundColor: 'var(--gold)', color: 'var(--bg)' }}
      whileTap={{ scale: 0.92 }}
      className="whatsapp-fab"
      style={{
        position: 'fixed', bottom: 88, left: 20, width: 52, height: 52, borderRadius: '50%',
        background: 'var(--bg)', color: 'var(--gold)', border: '1px solid var(--gold)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 800,
        boxShadow: '0 6px 24px rgba(201,168,76,0.3)',
      }}
    >
      <svg viewBox="0 0 32 32" width="28" height="28" fill="currentColor" aria-hidden="true">
        <path d="M16.001 3C9.383 3 4 8.383 4 15.001c0 2.114.553 4.18 1.6 6.002L4 29l8.19-1.567a11.94 11.94 0 0 0 3.81.622h.001C22.618 28.055 28 22.672 28 16.054 28 8.383 22.618 3 16.001 3zm0 21.867h-.001a9.9 9.9 0 0 1-5.045-1.382l-.362-.215-4.86.93.93-4.74-.236-.388a9.86 9.86 0 0 1-1.51-5.07c0-5.457 4.44-9.897 9.9-9.897 2.644 0 5.129 1.03 6.998 2.9a9.83 9.83 0 0 1 2.898 6.999c0 5.457-4.44 9.863-9.712 9.863zm5.43-7.394c-.297-.149-1.758-.868-2.031-.967-.273-.099-.471-.149-.67.149-.198.297-.767.967-.94 1.164-.174.199-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.174-.297-.019-.458.13-.606.134-.133.298-.347.446-.521.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.074-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.273.297-1.04 1.016-1.04 2.479 0 1.463 1.065 2.876 1.213 3.074.149.198 2.095 3.2 5.076 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.247-.694.247-1.289.173-1.413-.074-.124-.268-.199-.566-.347z" />
      </svg>
    </motion.a>
  );
}
