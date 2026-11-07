'use strict';

/**
 * /api/admin/reviews — moderation for customer reviews.
 *
 *   GET    ?status=pending|approved|rejected|all   list reviews (default pending)
 *   PATCH  { id, status }                          approve / reject / re-queue
 *   DELETE { id } | ?id=…                          remove a review permanently
 *
 * The table itself is service-role only. Approving a review flips `status` and
 * `publishedAt`; a database trigger then recomputes products.rating/reviews, so
 * the storefront aggregate updates atomically with the moderation action.
 */

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  tooMany,
  requirePerm,
  supabaseAdmin,
} = require('../_lib');

const REVIEW_STATUSES = ['pending', 'approved', 'rejected'];
const LIST_STATUSES = REVIEW_STATUSES.concat(['all']);

function logReviewError(action, err) {
  // Code only: the driver message can embed the review text.
  console.error(action, (err && err.code) || 'unknown');
}

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function readStatus(value, allowed) {
  const status = String(value || '').trim().toLowerCase();
  return allowed.includes(status) ? status : null;
}

// ─── GET ────────────────────────────────────────────────────────────────────

async function listReviews(req, res) {
  const session = await requirePerm(req, res, 'reviews.read');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminreviewread:${ip}`, 120, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  const rawStatus = (req.query && req.query.status) || 'pending';
  const status = readStatus(rawStatus, LIST_STATUSES);
  if (!status) {
    return json(res, 400, { error: 'Invalid review status.' });
  }

  const requestedLimit = Number((req.query && req.query.limit) || 200);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.trunc(requestedLimit)))
    : 200;

  res.setHeader('Cache-Control', 'no-store');

  try {
    const sb = supabaseAdmin();

    const countFor = async (value) => {
      const { count, error } = await sb
        .from('product_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('status', value);
      if (error) throw error;
      return Number(count) || 0;
    };

    const [pending, approved, rejected] = await Promise.all([
      countFor('pending'),
      countFor('approved'),
      countFor('rejected'),
    ]);

    let query = sb
      .from('product_reviews')
      .select('id, "productId", name, rating, comment, status, "createdAt", "publishedAt", phone')
      .order('createdAt', { ascending: false })
      .limit(limit);
    if (status !== 'all') query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const productIds = [...new Set(rows.map((r) => Number(r.productId)).filter(Number.isFinite))];
    let names = new Map();
    if (productIds.length > 0) {
      const { data: products, error: productError } = await sb
        .from('products')
        .select('id, name, image')
        .in('id', productIds);
      if (productError) throw productError;
      names = new Map((products || []).map((p) => [Number(p.id), p]));
    }

    const reviews = rows.map((row) => {
      const product = names.get(Number(row.productId));
      return {
        id: Number(row.id),
        productId: Number(row.productId),
        productName: product ? String(product.name || '') : '',
        productImage: product ? String(product.image || '') : '',
        name: String(row.name || ''),
        phone: row.phone ? String(row.phone) : null,
        rating: Number(row.rating) || 0,
        comment: String(row.comment || ''),
        status: String(row.status || 'pending'),
        createdAt: row.createdAt || null,
        publishedAt: row.publishedAt || null,
      };
    });

    return json(res, 200, {
      reviews,
      counts: { pending, approved, rejected, total: pending + approved + rejected },
    });
  } catch (err) {
    logReviewError('Review moderation list failed:', err);
    return json(res, 500, { error: 'Could not load reviews.' });
  }
}

// ─── PATCH ──────────────────────────────────────────────────────────────────

async function updateReview(req, res) {
  const session = await requirePerm(req, res, 'reviews.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminreviewwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: 'Invalid request body.' });
  }

  const id = parseId((body && body.id) || (req.query && req.query.id));
  if (id === null) return json(res, 400, { error: 'A valid review id is required.' });

  const status = readStatus(body && body.status, REVIEW_STATUSES);
  if (!status) return json(res, 400, { error: 'Status must be pending, approved or rejected.' });

  try {
    const sb = supabaseAdmin();

    const { data: existing, error } = await sb
      .from('product_reviews')
      .select('id, status, "publishedAt"')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!existing) return json(res, 404, { error: 'Review not found.' });

    const write = {
      status,
      publishedAt: status === 'approved'
        ? (existing.publishedAt || new Date().toISOString())
        : null,
    };

    const { data: fresh, error: updateError } = await sb
      .from('product_reviews')
      .update(write)
      .eq('id', id)
      .select('id, "productId", name, rating, comment, status, "createdAt", "publishedAt", phone')
      .maybeSingle();
    if (updateError) throw updateError;

    return json(res, 200, { success: true, review: fresh });
  } catch (err) {
    logReviewError('Review moderation update failed:', err);
    return json(res, 500, { error: 'Could not update the review.' });
  }
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

async function deleteReview(req, res) {
  const session = await requirePerm(req, res, 'reviews.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = await rateLimitShared(`adminreviewwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    /* body is optional for DELETE */
  }

  const id = parseId((body && body.id) || (req.query && req.query.id));
  if (id === null) return json(res, 400, { error: 'A valid review id is required.' });

  try {
    const sb = supabaseAdmin();
    const { data: deleted, error } = await sb
      .from('product_reviews')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!deleted) return json(res, 404, { error: 'Review not found.' });

    return json(res, 200, { success: true });
  } catch (err) {
    logReviewError('Review moderation delete failed:', err);
    return json(res, 500, { error: 'Could not delete the review.' });
  }
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);

  if (req.method === 'GET') return listReviews(req, res);
  if (req.method === 'PATCH') return updateReview(req, res);
  if (req.method === 'DELETE') return deleteReview(req, res);

  res.setHeader('Allow', 'GET, PATCH, DELETE, OPTIONS');
  return json(res, 405, { error: 'Method not allowed' });
}

module.exports = handler;
module.exports._test = {
  parseId,
  readStatus,
  REVIEW_STATUSES,
  LIST_STATUSES,
};
