'use strict';

const crypto = require('crypto');
const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimit,
  tooMany,
  requirePerm,
  supabaseAdmin,
  detectImageType,
  sanitizeStoragePath,
} = require('../_lib');

const MAX_BODY = 4 * 1024 * 1024; // ~3MB image after base64 expansion (Vercel caps at 4.5MB)
const MAX_DECODED = 3 * 1024 * 1024;

// ─── POST /api/admin/upload — store an image in the public products bucket ───

async function uploadImage(req, res) {
  const session = requirePerm(req, res, 'products.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminupload:${ip}`, 30, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (e) {
    if (e.status === 413) return json(res, 413, { error: 'Image is too large. Please upload an image under 3MB.' });
    return json(res, e.status || 400, { error: e.message });
  }

  const file = body && body.file;
  if (typeof file !== 'string' || !file.startsWith('data:')) {
    return json(res, 400, { error: 'A base64 data URL is required' });
  }

  const match = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(file);
  if (!match) return json(res, 400, { error: 'Invalid image data' });

  const declaredMime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return json(res, 400, { error: 'Empty image data' });
  if (buffer.length > MAX_DECODED) {
    return json(res, 413, { error: 'Image is too large. Please upload an image under 3MB.' });
  }

  // Trust magic bytes over the declared MIME type (content sniffing).
  const detected = detectImageType(buffer);
  if (!detected) return json(res, 415, { error: 'Only JPEG, PNG, WebP, GIF or AVIF images are allowed' });
  if (declaredMime.startsWith('image/') && declaredMime !== detected && detected !== 'image/avif') {
    console.warn(`Upload MIME mismatch: declared ${declaredMime}, detected ${detected}`);
  }

  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[detected];
  const filename = `${crypto.randomBytes(12).toString('hex')}.${ext}`;

  try {
    const sb = supabaseAdmin();
    const { error } = await sb.storage
      .from('products')
      .upload(filename, buffer, { contentType: detected, cacheControl: '31536000', upsert: false });
    if (error) throw error;

    const { data: pub } = sb.storage.from('products').getPublicUrl(filename);
    return json(res, 200, { success: true, url: pub.publicUrl, path: filename });
  } catch (err) {
    console.error('Upload failed:', err && err.message);
    return json(res, 500, { error: 'Could not upload image' });
  }
}

// ─── DELETE /api/admin/upload?path=<file> — remove an image ──────────────────

async function deleteImage(req, res) {
  const session = requirePerm(req, res, 'products.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminupload:${ip}`, 30, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    /* tolerated */
  }

  const raw = (body && body.path) || (req.query && req.query.path) || '';
  const path = sanitizeStoragePath(raw);
  if (!path) return json(res, 400, { error: 'Invalid file path' });

  try {
    const sb = supabaseAdmin();
    const { error } = await sb.storage.from('products').remove([path]);
    if (error) throw error;
    return json(res, 200, { success: true });
  } catch (err) {
    console.error('Upload delete failed:', err && err.message);
    return json(res, 500, { error: 'Could not delete image' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'POST') return uploadImage(req, res);
  if (req.method === 'DELETE') return deleteImage(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};
