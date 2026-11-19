import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, MessageSquare, Send, Star, X } from 'lucide-react';
import { api } from '../../lib/api';
import { prepareImage } from '../../lib/imagePrep';
import PhotoLightbox from '../ui/PhotoLightbox';
import StarRating from './StarRating';

// A phone photo is shrunk on the device before it is sent: the server caps the
// decoded image at 1.5MB, and this keeps the base64 body far below that.
const PHOTO_MAX_FILE = 12 * 1024 * 1024;

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: 8,
  color: 'var(--text)',
  padding: '12px 14px',
  outline: 'none',
};

/** Rough size of the prepared data URL, for the "ready" line. */
function dataUrlKb(value) {
  if (typeof value !== 'string' || !value) return 0;
  const comma = value.indexOf(',');
  const chars = comma >= 0 ? value.length - comma - 1 : value.length;
  return Math.max(1, Math.round((chars * 0.75) / 1024));
}

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
 * Normalise an Egyptian mobile number to the local 11-digit form, mirroring the
 * server rule. Returns null for empty input and undefined when invalid.
 */
function normalizeEgyptPhone(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+20')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0020')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('20') && digits.length === 12) digits = `0${digits.slice(2)}`;
  return /^01[0125][0-9]{8}$/.test(digits) ? digits : undefined;
}

/**
 * Small in-memory cache so returning to a product (or remounting the section)
 * paints the last known reviews immediately instead of a bare "Loading" line.
 * Every read is revalidated in the background, so an approved review still
 * appears without a manual reload.
 */
const reviewsCache = new Map(); // productId -> { summary, reviews, photosEnabled, at }

function readReviewsCache(productId) {
  if (!productId) return null;
  const hit = reviewsCache.get(String(productId));
  if (!hit) return null;
  return hit;
}

function writeReviewsCache(productId, summary, reviews, photosEnabled) {
  if (!productId) return;
  reviewsCache.set(String(productId), { summary, reviews, photosEnabled: Boolean(photosEnabled), at: Date.now() });
}

/**
 * Product reviews: summary stars, approved comments and a moderated submission
 * form. Nothing typed here appears publicly until an admin approves it.
 */
export default function ProductReviews({ product }) {
  const productId = product && product.id;
  const initialCache = readReviewsCache(productId);

  const [loading, setLoading] = useState(!initialCache);
  const [loadError, setLoadError] = useState('');
  const [summary, setSummary] = useState(() => (
    initialCache
      ? initialCache.summary
      : { average: Number(product && product.rating) || 0, count: Number(product && product.reviews) || 0 }
  ));
  const [reviews, setReviews] = useState(() => (initialCache ? initialCache.reviews : []));
  // The photo picker is part of the form. It only disappears when the server
  // says outright that it cannot store a photo (`photosEnabled: false`, i.e.
  // the optional `photoPath` column is missing). A failed or slow reviews
  // request must never hide it — that used to make the field vanish for
  // shoppers on a flaky connection.
  const [photosEnabled, setPhotosEnabled] = useState(() => !initialCache || initialCache.photosEnabled !== false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const [photoSaved, setPhotoSaved] = useState(null);
  const [dragActive, setDragActive] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState('');
  const [errorField, setErrorField] = useState(null);
  const [sent, setSent] = useState(false);
  // A customer photo opened full size, with the thumbnail it came from so focus
  // can go back there when the visitor closes it.
  const [lightboxPhoto, setLightboxPhoto] = useState(null);

  const formRef = useRef(null);
  const nameRef = useRef(null);
  const phoneRef = useRef(null);
  const ratingRef = useRef(null);
  const commentRef = useRef(null);
  const successRef = useRef(null);
  const photoInputRef = useRef(null);
  const [form, setForm] = useState({ name: '', rating: 0, comment: '', website: '', phone: '', photo: '' });
  const [hoverStar, setHoverStar] = useState(0);

  const load = useCallback(async (signal) => {
    if (!productId) return;
    // Keep the previous list on screen while refreshing in the background.
    if (!reviewsCache.has(String(productId))) setLoading(true);
    setLoadError('');
    try {
      const payload = await api.get(
        `/reviews?productId=${encodeURIComponent(productId)}`,
        signal ? { signal } : undefined
      );
      const nextSummary = {
        average: Number(payload && payload.summary && payload.summary.average) || 0,
        count: Number(payload && payload.summary && payload.summary.count) || 0,
      };
      const nextReviews = Array.isArray(payload && payload.reviews) ? payload.reviews : [];
      // Only an explicit `false` hides the photo picker; a payload without the
      // flag (older deploy, partial response) keeps it visible.
      const nextPhotosEnabled = !payload || payload.photosEnabled !== false;
      setSummary(nextSummary);
      setReviews(nextReviews);
      setPhotosEnabled(nextPhotosEnabled);
      writeReviewsCache(productId, nextSummary, nextReviews, nextPhotosEnabled);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setLoadError('Could not load reviews right now.');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  // Switching to another product must not show the previous product's reviews.
  useEffect(() => {
    const cached = readReviewsCache(productId);
    if (cached) {
      setSummary(cached.summary);
      setReviews(cached.reviews);
      setPhotosEnabled(cached.photosEnabled !== false);
      setLoading(false);
    } else {
      setSummary({
        average: Number(product && product.rating) || 0,
        count: Number(product && product.reviews) || 0,
      });
      setReviews([]);
      setPhotosEnabled(true);
      setLoading(true);
    }
    setLoadError('');
    // `product` is read only for its aggregate fallback; the id is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    load(controller ? controller.signal : undefined);
    return () => { if (controller) controller.abort(); };
  }, [load]);

  // Auto-scroll to the field that failed validation so the visitor sees the
  // problem instead of a message buried below the fold.
  useEffect(() => {
    if (!formError || !errorField) return;
    const ref = errorField === 'name' ? nameRef
      : errorField === 'phone' ? phoneRef
      : errorField === 'rating' ? ratingRef
      : errorField === 'comment' ? commentRef
      : null;
    const node = ref && ref.current;
    if (!node) return;
    const timer = setTimeout(() => {
      node.scrollIntoView({ block: 'center' });
      if (typeof node.focus === 'function') {
        try { node.focus(); } catch (e) { /* ignore */ }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [formError, errorField]);

  // Auto-scroll to the success note once a review is accepted.
  useEffect(() => {
    if (!sent) return;
    const node = successRef.current;
    if (!node) return;
    const timer = setTimeout(() => {
      node.scrollIntoView({ block: 'center' });
    }, 50);
    return () => clearTimeout(timer);
  }, [sent]);

  const update = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrorField((current) => (current === key ? null : current));
  };

  // Shared by the file picker and drag-and-drop, so both paths validate and
  // compress exactly the same way.
  const processPhotoFile = async (file) => {
    if (!file) return;

    setPhotoError('');
    if (!/^image\//.test(String(file.type || ''))) {
      setPhotoError('Please choose an image file (JPEG, PNG or WebP).');
      return;
    }
    if (file.size > PHOTO_MAX_FILE) {
      setPhotoError('That photo is larger than 12MB. Please choose a smaller one.');
      return;
    }

    setPhotoBusy(true);
    try {
      const dataUrl = await prepareImage(file, { maxFileSize: PHOTO_MAX_FILE });
      update('photo', dataUrl);
    } catch (err) {
      setPhotoError((err && err.message) || 'Could not read that photo. Please try another.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const pickPhoto = async (event) => {
    const input = event && event.target;
    const file = input && input.files && input.files[0];
    // Reset the input so choosing the same file again still fires onChange.
    if (input) input.value = '';
    await processPhotoFile(file);
  };

  const openPhotoPicker = () => {
    if (photoBusy) return;
    if (photoInputRef.current) photoInputRef.current.click();
  };

  const onPhotoDragOver = (event) => {
    if (!event.dataTransfer || photoBusy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };

  const onPhotoDragLeave = (event) => {
    // Ignore the leave events fired while crossing the button's own children.
    if (event.currentTarget && event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setDragActive(false);
  };

  const onPhotoDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    if (photoBusy) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) processPhotoFile(file);
  };

  const removePhoto = () => {
    update('photo', '');
    setPhotoError('');
    setDragActive(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    setFormError('');
    setErrorField(null);
    setSent(false);

    const name = form.name.trim();
    const comment = form.comment.trim();
    if (name.length < 2) { setErrorField('name'); setFormError('Please enter your name (at least 2 characters).'); return; }
    if (!form.rating) { setErrorField('rating'); setFormError('Please choose a rating from 1 to 5 stars.'); return; }
    if (comment.length < 2) { setErrorField('comment'); setFormError('Please write a short review (at least 2 characters).'); return; }
    if (comment.length > 600) { setErrorField('comment'); setFormError('Please keep your review under 600 characters.'); return; }

    const rawPhone = form.phone.trim();
    let phone = '';
    if (rawPhone) {
      const normalized = normalizeEgyptPhone(rawPhone);
      if (!normalized) {
        setErrorField('phone'); setFormError('Please enter a valid Egyptian mobile number (e.g. 01012345678).');
        return;
      }
      phone = normalized;
    }

    setErrorField(null);
    setPhotoSaved(null);

    setSending(true);
    try {
      const payload = await api.post('/reviews', {
        productId,
        name,
        rating: form.rating,
        comment,
        website: form.website,
        phone: phone || undefined,
        // Optional: the server stores it in Storage and keeps only the path.
        photo: form.photo || undefined,
      });
      setSent(true);
      setErrorField(null);
      setPhotoSaved(form.photo ? Boolean(payload && payload.photoSaved) : null);
      setPhotoError('');
      setForm({ name: '', rating: 0, comment: '', website: '', phone: '', photo: '' });
      // Keep the form mounted so the page does not jump when the response
      // arrives; the success note appears in place above the fields.
    } catch (err) {
      setFormError((err && err.message) || 'Could not send your review. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      aria-labelledby="product-reviews-title"
      data-product-reviews="true"
      className="product-reviews"
    >
      <div className="reviews-shell">
        <header className="reviews-head">
          <div className="reviews-heading">
            <span className="reviews-heading-icon" aria-hidden="true">
              <MessageSquare size={17} />
            </span>
            <h2 id="product-reviews-title" className="reviews-title">Customer Reviews</h2>
          </div>

          <div className="reviews-summary">
            <span className="reviews-score">
              {summary.count > 0 ? summary.average.toFixed(1) : '0.0'}
            </span>
            <div className="reviews-summary-meta">
              <StarRating rating={summary.average} size={15} />
              <span className="reviews-count">
                {summary.count > 0
                  ? `${summary.count} review${summary.count === 1 ? '' : 's'}`
                  : 'No reviews yet'}
              </span>
            </div>
          </div>

          {!formOpen && (
            <button
              type="button"
              className="reviews-write-btn"
              onClick={() => { setFormOpen(true); setSent(false); setFormError(''); setErrorField(null); }}
            >
              <Star size={13} aria-hidden="true" /> Write a review
            </button>
          )}
        </header>

        {/* Form */}
        {formOpen && (
          <form onSubmit={submit} noValidate className="review-form">
            <div className="review-form-head">
              <strong className="review-form-title">Share your opinion</strong>
              <button
                type="button"
                aria-label="Close review form"
                className="review-form-close"
                onClick={() => { setFormOpen(false); setFormError(''); setErrorField(null); setSent(false); }}
              >
                <X size={16} />
              </button>
            </div>

            {sent && (
              <div ref={successRef} className="review-success">
                <p role="status" className="review-note is-success">
                  Thanks! Your review was received and will appear here once approved.
                </p>
                {photoSaved === false && (
                  <p role="status" className="review-note is-warn">
                    Your review was saved, but the photo could not be uploaded. You can add it later.
                  </p>
                )}
              </div>
            )}

            <div className="review-grid">
              <div className="review-field review-field--half">
                <label htmlFor="review-name">Your name</label>
                <input
                  id="review-name"
                  ref={nameRef}
                  type="text"
                  className={`review-input${errorField === 'name' ? ' is-invalid' : ''}`}
                  value={form.name}
                  onChange={(e) => update('name', e.target.value)}
                  maxLength={40}
                  autoComplete="name"
                  style={inputStyle}
                />
                {errorField === 'name' && formError && (
                  <p role="alert" className="review-error">{formError}</p>
                )}
              </div>

              <div className="review-field review-field--half">
                <label htmlFor="review-phone">Phone (optional)</label>
                <input
                  id="review-phone"
                  ref={phoneRef}
                  type="tel"
                  className={`review-input${errorField === 'phone' ? ' is-invalid' : ''}`}
                  value={form.phone}
                  onChange={(e) => update('phone', e.target.value)}
                  maxLength={30}
                  autoComplete="tel"
                  placeholder="For follow-up only — not shown publicly"
                  style={inputStyle}
                />
                {errorField === 'phone' && formError && (
                  <p role="alert" className="review-error">{formError}</p>
                )}
              </div>

              <div
                ref={ratingRef}
                className={`review-field review-rating-field${errorField === 'rating' ? ' is-invalid' : ''}`}
                role="radiogroup"
                aria-label="Your rating"
              >
                <span className="review-field-label">Your rating</span>
                <div className="review-rating" onMouseLeave={() => setHoverStar(0)}>
                  {[1, 2, 3, 4, 5].map((star) => {
                    const active = star <= (hoverStar || form.rating);
                    return (
                      <button
                        key={star}
                        type="button"
                        role="radio"
                        aria-checked={form.rating === star}
                        aria-label={`${star} star${star === 1 ? '' : 's'}`}
                        className="review-star"
                        onClick={() => update('rating', star)}
                        onMouseEnter={() => setHoverStar(star)}
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
                {errorField === 'rating' && formError && (
                  <p role="alert" className="review-error">{formError}</p>
                )}
              </div>

              <div className="review-field">
                <label htmlFor="review-comment">Your review</label>
                <textarea
                  id="review-comment"
                  ref={commentRef}
                  className={`review-input${errorField === 'comment' ? ' is-invalid' : ''}`}
                  value={form.comment}
                  onChange={(e) => update('comment', e.target.value)}
                  maxLength={600}
                  rows={4}
                  placeholder="How is the fabric, the fit and the finishing?"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 104, fontFamily: 'inherit', lineHeight: 1.7 }}
                />
                {errorField === 'comment' && formError && (
                  <p role="alert" className="review-error">{formError}</p>
                )}
                <span className="review-counter">{form.comment.length}/600</span>
              </div>

              {/* Optional photo, shaped like every other field but inviting:
                  a full-width dropzone that accepts a click, a drag or a drop.
                  The file is resized in the browser and only its path is stored. */}
              {photosEnabled && (
                <div className="review-field review-photo">
                  <span className="review-field-label" id="review-photo-label">
                    Photo of the piece <span className="review-field-optional">· optional</span>
                  </span>
                  <p className="review-photo-lede" id="review-photo-lede">
                    Upload the product exactly as it arrived — worn by you, or laid flat. Real photos help the next
                    customer judge the fabric, the colour and the fit before they order.
                  </p>
                  <input
                    ref={photoInputRef}
                    id="review-photo"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={pickPhoto}
                    style={{ display: 'none' }}
                    tabIndex={-1}
                    aria-hidden="true"
                  />

                  {form.photo ? (
                    <div className="review-photo-preview">
                      <img src={form.photo} alt="Preview of the photo you chose" />
                      <div className="review-photo-preview-bar">
                        <span className="review-photo-ready">
                          <Check size={13} aria-hidden="true" />
                          {photoBusy ? 'Preparing…' : 'Ready to upload'}
                          <span>· about {dataUrlKb(form.photo)} KB</span>
                        </span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="button" className="review-photo-btn" onClick={openPhotoPicker} disabled={photoBusy}>
                            <ImagePlus size={12} aria-hidden="true" /> Change photo
                          </button>
                          <button type="button" className="review-photo-btn is-quiet" onClick={removePhoto} disabled={photoBusy}>
                            <X size={12} aria-hidden="true" /> Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={`review-photo-drop${dragActive ? ' is-drag' : ''}${photoBusy ? ' is-busy' : ''}`}
                      onClick={openPhotoPicker}
                      onDragEnter={onPhotoDragOver}
                      onDragOver={onPhotoDragOver}
                      onDragLeave={onPhotoDragLeave}
                      onDrop={onPhotoDrop}
                      disabled={photoBusy}
                      aria-busy={photoBusy ? 'true' : 'false'}
                      aria-labelledby="review-photo-label review-photo-title"
                      aria-describedby="review-photo-lede review-photo-meta"
                    >
                      <span className="review-photo-icon" aria-hidden="true">
                        <ImagePlus size={20} />
                      </span>
                      <span className="review-photo-title" id="review-photo-title">
                        {photoBusy ? 'Preparing your photo…' : dragActive ? 'Drop it here' : 'Add a real photo'}
                      </span>
                      <span className="review-photo-cta">
                        {photoBusy ? 'Optimising for upload' : 'Choose a photo'}
                      </span>
                      <span className="review-photo-drop-hint">or drag and drop it here</span>
                    </button>
                  )}

                  <span className="review-photo-meta" id="review-photo-meta">
                    JPEG, PNG or WebP · up to 12MB · resized on your device · shown publicly once the review is approved.
                  </span>
                  {photoError && (
                    <p role="alert" className="review-error">{photoError}</p>
                  )}
                </div>
              )}

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

              {formError && !errorField && (
                <p role="alert" className="review-error">{formError}</p>
              )}

              <div className="review-actions">
                <button
                  type="submit"
                  className="review-submit"
                  disabled={sending}
                >
                  <Send size={13} aria-hidden="true" /> {sending ? 'Sending…' : 'Submit review'}
                </button>
                <span className="review-actions-note">
                  Reviews are published after a quick check.
                </span>
              </div>
            </div>
          </form>
        )}

        {/* List */}
        {loading && (
          <p className="reviews-state">Loading reviews…</p>
        )}

        {!loading && loadError && (
          <div className="reviews-state is-error">
            <p role="alert">{loadError}</p>
            <button
              type="button"
              className="reviews-retry"
              onClick={() => load()}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !loadError && reviews.length === 0 && (
          <div className="reviews-empty">
            <span className="reviews-empty-icon" aria-hidden="true">
              <MessageSquare size={19} />
            </span>
            <p>No reviews yet — be the first to share your thoughts.</p>
          </div>
        )}

        {!loading && !loadError && reviews.length > 0 && (
          <div className="reviews-list">
            {reviews.map((review) => (
              <article key={review.id} className="review-card">
                <div className="review-card-head">
                  <span className="review-card-avatar" aria-hidden="true">
                    {String(review.name || '?').trim().charAt(0).toUpperCase()}
                  </span>
                  <div className="review-card-meta">
                    <strong className="review-card-name">{review.name}</strong>
                    <StarRating rating={review.rating} size={12} />
                  </div>
                  {formatDate(review.createdAt) && (
                    <span className="review-card-date">
                      {formatDate(review.createdAt)}
                    </span>
                  )}
                </div>
                <p className="review-card-body">
                  {review.comment}
                </p>
                {review.photoUrl && (
                  <button
                    type="button"
                    className="review-photo-thumb"
                    aria-haspopup="dialog"
                    aria-label={`Open the photo attached by ${review.name}`}
                    onClick={(event) => setLightboxPhoto({
                      src: review.photoUrl,
                      alt: `Photo attached by ${review.name}`,
                      caption: [review.name, formatDate(review.createdAt)].filter(Boolean).join(' · '),
                      returnTo: event.currentTarget,
                    })}
                  >
                    <img
                      src={review.photoUrl}
                      alt={`Photo attached by ${review.name}`}
                      loading="lazy"
                      decoding="async"
                      style={{ width: 96, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)' }}
                    />
                  </button>
                )}
              </article>
            ))}
            {summary.count > reviews.length && (
              <p className="reviews-more">
                Showing the latest {reviews.length} of {summary.count} reviews.
              </p>
            )}
          </div>
        )}
      </div>

      <PhotoLightbox photo={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />
    </section>
  );
}
