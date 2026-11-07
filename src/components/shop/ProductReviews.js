import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquare, Send, Star, X } from 'lucide-react';
import { api } from '../../lib/api';
import StarRating from './StarRating';

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg2)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text)',
  padding: '10px 12px',
  outline: 'none',
};

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/**
 * Product reviews: summary stars, approved comments and a moderated submission
 * form. Nothing typed here appears publicly until an admin approves it.
 */
export default function ProductReviews({ product }) {
  const productId = product && product.id;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [summary, setSummary] = useState({ average: 0, count: 0 });
  const [reviews, setReviews] = useState([]);

  const [formOpen, setFormOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ name: '', rating: 0, comment: '', website: '' });
  const [hoverStar, setHoverStar] = useState(0);

  const load = useCallback(async (signal) => {
    if (!productId) return;
    setLoading(true);
    setLoadError('');
    try {
      const payload = await api.get(
        `/reviews?productId=${encodeURIComponent(productId)}`,
        signal ? { signal } : undefined
      );
      setSummary({
        average: Number(payload && payload.summary && payload.summary.average) || 0,
        count: Number(payload && payload.summary && payload.summary.count) || 0,
      });
      setReviews(Array.isArray(payload && payload.reviews) ? payload.reviews : []);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setLoadError('Could not load reviews right now.');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    load(controller ? controller.signal : undefined);
    return () => { if (controller) controller.abort(); };
  }, [load]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setFormError('');
    setSent(false);

    const name = form.name.trim();
    const comment = form.comment.trim();
    if (name.length < 2) { setFormError('Please enter your name (at least 2 characters).'); return; }
    if (!form.rating) { setFormError('Please choose a rating from 1 to 5 stars.'); return; }
    if (comment.length < 2) { setFormError('Please write a short review (at least 2 characters).'); return; }
    if (comment.length > 600) { setFormError('Please keep your review under 600 characters.'); return; }

    setSending(true);
    try {
      await api.post('/reviews', {
        productId,
        name,
        rating: form.rating,
        comment,
        website: form.website,
      });
      setSent(true);
      setForm({ name: '', rating: 0, comment: '', website: '' });
      setFormOpen(false);
    } catch (err) {
      setFormError((err && err.message) || 'Could not send your review. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const heading = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
      <MessageSquare size={18} color="var(--gold)" aria-hidden="true" />
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 400, letterSpacing: 1, margin: 0 }}>
        Customer Reviews
      </h2>
    </div>
  );

  return (
    <section
      aria-labelledby="product-reviews-title"
      data-product-reviews="true"
      style={{
        marginTop: 64,
        paddingTop: 32,
        borderTop: '1px solid var(--border)',
      }}
    >
      <div id="product-reviews-title">{heading}</div>

      {/* Summary */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 34, lineHeight: 1, color: 'var(--gold)' }}>
            {summary.count > 0 ? summary.average.toFixed(1) : '0.0'}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <StarRating rating={summary.average} size={16} />
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>
              {summary.count > 0
                ? `${summary.count} review${summary.count === 1 ? '' : 's'}`
                : 'No reviews yet'}
            </span>
          </div>
        </div>

        {!formOpen && (
          <button
            type="button"
            onClick={() => { setFormOpen(true); setSent(false); setFormError(''); }}
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '9px 16px',
              background: 'transparent',
              color: 'var(--gold)',
              border: '1px solid var(--border-gold, rgba(201,168,76,0.5))',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            <Star size={13} /> Write a review
          </button>
        )}
      </div>

      {sent && (
        <p role="status" style={{ background: 'rgba(39,174,96,0.10)', border: '1px solid rgba(39,174,96,0.35)', color: '#8fe0b0', borderRadius: 4, padding: '10px 12px', fontSize: 12, marginBottom: 18 }}>
          Thanks! Your review was received and will appear here once approved.
        </p>
      )}

      {/* Form */}
      {formOpen && (
        <form
          onSubmit={submit}
          className="review-form"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 18, marginBottom: 24 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <strong style={{ fontSize: 13, letterSpacing: 0.5 }}>Share your opinion</strong>
            <button
              type="button"
              aria-label="Close review form"
              onClick={() => { setFormOpen(false); setFormError(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', padding: 4 }}
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label htmlFor="review-name" style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginBottom: 5 }}>Your name</label>
              <input
                id="review-name"
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                maxLength={40}
                autoComplete="name"
                style={inputStyle}
              />
            </div>

            <div role="radiogroup" aria-label="Your rating">
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginBottom: 5 }}>Your rating</span>
              <div style={{ display: 'flex', gap: 4 }} onMouseLeave={() => setHoverStar(0)}>
                {[1, 2, 3, 4, 5].map((star) => {
                  const active = star <= (hoverStar || form.rating);
                  return (
                    <button
                      key={star}
                      type="button"
                      role="radio"
                      aria-checked={form.rating === star}
                      aria-label={`${star} star${star === 1 ? '' : 's'}`}
                      onClick={() => update('rating', star)}
                      onMouseEnter={() => setHoverStar(star)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, lineHeight: 0 }}
                    >
                      <Star
                        size={24}
                        aria-hidden="true"
                        color={active ? 'var(--gold)' : 'var(--text3)'}
                        fill={active ? 'var(--gold)' : 'none'}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="review-comment" style={{ display: 'block', fontSize: 11, color: 'var(--text3)', marginBottom: 5 }}>Your review</label>
              <textarea
                id="review-comment"
                value={form.comment}
                onChange={(e) => update('comment', e.target.value)}
                maxLength={600}
                rows={4}
                placeholder="How is the fabric, the fit and the finishing?"
                style={{ ...inputStyle, resize: 'vertical', minHeight: 90, fontFamily: 'inherit' }}
              />
              <span style={{ display: 'block', textAlign: 'right', fontSize: 10, color: 'var(--text3)', marginTop: 3 }}>
                {form.comment.length}/600
              </span>
            </div>

            {/* Honeypot: hidden from people, tempting for bots. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor="review-website">Website</label>
              <input
                id="review-website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={form.website}
                onChange={(e) => update('website', e.target.value)}
              />
            </div>

            {formError && (
              <p role="alert" style={{ color: '#e74c3c', fontSize: 12, margin: 0 }}>{formError}</p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="submit"
                disabled={sending}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 18px',
                  background: sending ? '#8a7430' : 'var(--gold)',
                  color: 'white',
                  border: '1px solid var(--gold)',
                  borderRadius: 4,
                  cursor: sending ? 'wait' : 'pointer',
                  fontSize: 11,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}
              >
                <Send size={13} /> {sending ? 'Sending…' : 'Submit review'}
              </button>
              <span style={{ fontSize: 10, color: 'var(--text3)' }}>
                Reviews are published after a quick check.
              </span>
            </div>
          </div>
        </form>
      )}

      {/* List */}
      {loading && (
        <p style={{ fontSize: 12, color: 'var(--text3)' }}>Loading reviews…</p>
      )}

      {!loading && loadError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p style={{ fontSize: 12, color: '#e74c3c', margin: 0 }}>{loadError}</p>
          <button
            type="button"
            onClick={() => load()}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text2)', padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && reviews.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>
          No reviews yet — be the first to share your thoughts.
        </p>
      )}

      {!loading && !loadError && reviews.length > 0 && (
        <div style={{ display: 'grid', gap: 14 }}>
          {reviews.map((review) => (
            <article
              key={review.id}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 14 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>{review.name}</strong>
                <StarRating rating={review.rating} size={12} />
                {formatDate(review.createdAt) && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
                    {formatDate(review.createdAt)}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12.5, lineHeight: 1.7, color: 'var(--text2)', margin: 0, overflowWrap: 'anywhere' }}>
                {review.comment}
              </p>
            </article>
          ))}
          {summary.count > reviews.length && (
            <p style={{ fontSize: 10.5, color: 'var(--text3)', margin: 0 }}>
              Showing the latest {reviews.length} of {summary.count} reviews.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
