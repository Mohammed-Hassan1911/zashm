import React from 'react';
import { useStore } from '../../store';
import { cartWhatsAppMessage, whatsappUrl } from '../../lib/resilience';

/**
 * Slim, non-blocking notice shown only after a live catalogue fetch failed and
 * the backup catalogue is serving the page. Browsing stays available; ordering
 * moves to WhatsApp because /api/orders needs the database that is down.
 */
export default function OutageNotice() {
  const degraded = useStore((s) => s.productsDegraded);
  const hasProducts = useStore((s) => s.products.length > 0);
  const cart = useStore((s) => s.cart);

  if (!degraded) return null;

  return (
    <div className="outage-notice" role="status" aria-live="polite">
      <span className="outage-notice-text">
        {hasProducts ? (
          <>
            <strong>الموقع شغّال من نسخة احتياطية مؤقتًا.</strong>{' '}
            تقدر تتصفح، والطلب متاح عبر واتساب.
            <span className="outage-notice-en"> You&apos;re browsing a backup — ordering is available on WhatsApp.</span>
          </>
        ) : (
          <>
            <strong>المتجر متوقف مؤقتًا.</strong>{' '}
            التواصل والطلب متاحين عبر واتساب.
            <span className="outage-notice-en"> The store is temporarily unavailable — ordering is available on WhatsApp.</span>
          </>
        )}
      </span>
      <a
        className="outage-notice-action"
        href={whatsappUrl(cartWhatsAppMessage(cart))}
        target="_blank"
        rel="noopener noreferrer"
      >
        اطلب عبر واتساب / Order on WhatsApp
      </a>
    </div>
  );
}
