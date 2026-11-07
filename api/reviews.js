'use strict';

/**
 * /api/reviews — public product reviews.
 *
 *   GET  /api/reviews?productId=123[&limit=20]
 *        Approved reviews only. The summary comes from the aggregate columns
 *        kept in sync by the database trigger, so it is correct even when the
 *        page shows only the latest 20 rows.
 *
 *   POST /api/reviews  { productId, name, rating, comment }
 *        Stores a review as `pending`. Nothing is published until an admin
 *        approves it in the dashboard (api/admin/reviews.js).
 *
 * The product_reviews table is service-role only. The browser never reads or
 * writes it directly, so a forged request cannot publish a review or read the
 * submitter's ipHash.
 */

const crypto = require('node:crypto');

const {
  env,
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  tooMany,
  supabaseAdmin,
} = require('./_lib');

const RATE_MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const REVIEWS_DEFAULT_LIMIT = 20;
const REVIEWS_MAX_LIMIT = 50;
const NAME_MAX = 40;
const COMMENT_MAX = 600;

/** Collapse control characters/whitespace and neutralise angle brackets. React
 * already escapes the rendered text; this keeps stored data clean and prevents
 * a future plain-text consumer (Telegram, CSV, e-mail) from being injected. */
function cleanReviewText(value, maxChars) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function readProductId(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** Validate the POST body. Returns { ok, value } or { ok: false, error }. */
function readReviewPayload(body) {
  const source = body && typeof body === 'object' ? body : {};

  // Bots fill hidden fields. Answer 201 without writing so the bot has no
  // signal that it was rejected.
  if (typeof source.website === 'string' && source.website.trim()) {
    return { ok: true, honeypot: true };
  }

  const productId = readProductId(source.productId);
  if (productId === null) return { ok: false, error: 'A valid product is required.' };

  const name = cleanReviewText(source.name, NAME_MAX);
  if (name.length < 2) return { ok: false, error: 'Please enter your name (at least 2 characters).' };

  const rating = Number(source.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'Please choose a rating from 1 to 5 stars.' };
  }

  const comment = cleanReviewText(source.comment, COMMENT_MAX);
  if (comment.length < 2) return { ok: false, error: 'Please write a short review (at least 2 characters).' };

  return { ok: true, honeypot: false, value: { productId, name, rating, comment } };
}

/** Salted, truncated IP hash for abuse investigation only. Never displayed. */
function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(`${ip || ''}|${env('SESSION_SECRET') || ''}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── GET — approved reviews ─────────────────────────────────────────────────

async function listReviews(req, res) {
  const productId = readProductId(req.query && req.query.productId);
  if (productId === null) {
    return json(res, 400, { error: 'A valid productId is required.' });
  }

  const requestedLimit = Number((req.query && req.query.limit) || REVIEWS_DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(REVIEWS_MAX_LIMIT, Math.trunc(requestedLimit)))
    : REVIEWS_DEFAULT_LIMIT;

  // Reviews are public and change rarely; a short shared cache absorbs bursts
  // without ever exposing a pending review (the query filters them out). The
  // header is only set on success so a 500 is never cached.
  try {
    const sb = supabaseAdmin();

    const { data: product, error: productError } = await sb
      .from('products')
      .select('id, active, rating, reviews')
      .eq('id', productId)
      .maybeSingle();
    if (productError) throw productError;

    if (!product || product.active !== true) {
      return json(res, 404, { error: 'Product not found.' });
    }

    const { data, error } = await sb
      .from('product_reviews')
      .select('id, name, rating, comment, "createdAt", "publishedAt"')
      .eq('productId', productId)
      .eq('status', 'approved')
      .order('createdAt', { ascending: false })
      .limit(limit);
    if (error) throw error;

    const reviews = (Array.isArray(data) ? data : []).map((row) => ({
      id: Number(row.id),
      name: String(row.name || ''),
      rating: Number(row.rating) || 0,
      comment: String(row.comment || ''),
      createdAt: row.publishedAt || row.createdAt || null,
    }));

    const average = Number(product.rating);
    const count = Number(product.reviews);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    return json(res, 200, {
      summary: {
        average: Number.isFinite(average) ? average : 0,
        count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
      },
      reviews,
    });
  } catch (err) {
    // Log the driver code only: the message can embed review text.
    console.error('Review list failed:', (err && err.code) || 'unknown');
    return json(res, 500, { error: 'Could not load reviews.' });
  }
}

// ─── POST — submit a pending review ─────────────────────────────────────────

async function submitReview(req, res) {
  const ip = clientIp(req);
  const check = await rateLimitShared(`reviewsubmit:${ip}`, RATE_MAX_ATTEMPTS, RATE_WINDOW_MS);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: 'Invalid request body.' });
  }

  const parsed = readReviewPayload(body);
  if (!parsed.ok) return json(res, 400, { error: parsed.error });

  if (parsed.honeypot) {
    return json(res, 201, { success: true, pending: true });
  }

  const { productId, name, rating, comment } = parsed.value;

  try {
    const sb = supabaseAdmin();

    const { data: product, error: productError } = await sb
      .from('products')
      .select('id, active')
      .eq('id', productId)
      .maybeSingle();
    if (productError) throw productError;
    if (!product || product.active !== true) {
      return json(res, 404, { error: 'Product not found.' });
    }

    const { error } = await sb.from('product_reviews').insert([{
      productId,
      name,
      rating,
      comment,
      status: 'pending',
      ipHash: hashIp(ip),
    }]);
    if (error) throw error;

    return json(res, 201, {
      success: true,
      pending: true,
      message: 'Thanks! Your review was received and will appear once approved.',
    });
  } catch (err) {
    console.error('Review submit failed:', (err && err.code) || 'unknown');
    return json(res, 500, { error: 'Could not save your review. Please try again.' });
  }
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);

  if (req.method === 'GET') return listReviews(req, res);
  if (req.method === 'POST') return submitReview(req, res);

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return json(res, 405, { error: 'Method not allowed' });
}

module.exports = handler;
module.exports._test = {
  cleanReviewText,
  readReviewPayload,
  hashIp,
  RATE_MAX_ATTEMPTS,
  RATE_WINDOW_MS,
  REVIEWS_MAX_LIMIT,
};
