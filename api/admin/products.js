'use strict';

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
  validateProductPayload,
  pathsFromProductImageFields,
  storagePathsUsedByOtherProducts,
  removeStorageFiles,
} = require('../_lib');

// Columns proven to exist (insert path). `label`/`tags`/`active` are sent when
// provided but stripped and retried if the column turns out to be missing.
const OPTIONAL_COLUMNS = ['label', 'tags', 'active'];

function isUnknownColumn(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return (
    msg.includes('does not exist') ||
    msg.includes('could not find') ||
    msg.includes('unknown column') ||
    (error && error.code === 'PGRST204')
  );
}

async function insertProduct(sb, row) {
  let { data, error } = await sb.from('products').insert([row]).select().single();
  if (error && isUnknownColumn(error)) {
    const stripped = { ...row };
    for (const col of OPTIONAL_COLUMNS) delete stripped[col];
    ({ data, error } = await sb.from('products').insert([stripped]).select().single());
  }
  if (error) throw error;
  return data;
}

function generateProductId() {
  return Number(`${Date.now()}${Math.floor(100 + Math.random() * 900)}`);
}

function buildInsertRow(p, id) {
  return {
    id,
    name: p.name,
    category: p.category,
    price: Number(p.price),
    salePrice: p.salePrice === null || p.salePrice === undefined ? null : Number(p.salePrice),
    description: p.description || '',
    stock: Number(p.stock),
    variantStock: p.variantStock || {},
    sku: p.sku || '',
    label: p.label || '',
    tags: p.tags || null,
    active: p.active === undefined ? true : Boolean(p.active),
    colors: p.colors || [],
    sizes: p.sizes || [],
    images: p.images || [],
    image: p.image || (Array.isArray(p.images) && p.images.length > 0 ? p.images[0] : ''),
    sizeGuide: p.sizeGuide || null,
  };
}

// ─── POST /api/admin/products — create one product or bulk import ────────────

async function createProducts(req, res) {
  const session = requirePerm(req, res, 'products.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 2 * 1024 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const isBulk = body && Array.isArray(body.items);
  const inputs = isBulk ? body.items.slice(0, 500) : [body && body.product ? body.product : body];
  if (!inputs.length || !inputs[0]) return json(res, 400, { error: 'Product data is required' });

  const cleaned = [];
  for (const input of inputs) {
    const p = validateProductPayload(input || {});
    if (!p) return json(res, 422, { error: 'Invalid product data' });
    // import rows and form rows may carry tags (not part of the core validator)
    p.tags = input && input.tags ? String(input.tags).replace(/[<>]/g, '').slice(0, 300) : null;
    cleaned.push({ input, p });
  }

  try {
    const sb = supabaseAdmin();
    const created = [];
    for (const { input, p } of cleaned) {
      const id = input && Number.isFinite(Number(input.id)) && String(input.id).trim() !== ''
        ? Number(input.id)
        : generateProductId();
      const row = buildInsertRow(p, id);
      if (input && input.image && !row.image) row.image = String(input.image).slice(0, 2000);
      const data = await insertProduct(sb, row);
      created.push({
        ...data,
        reservedStock: 0,
        rating: 0,
        reviews: 0,
        active: data.active ?? true,
        createdAt: data.created_at || new Date().toISOString(),
        updatedAt: data.updated_at || new Date().toISOString(),
      });
    }

    if (isBulk) return json(res, 200, { success: true, count: created.length, products: created });
    return json(res, 200, { success: true, product: created[0] });
  } catch (err) {
    console.error('Product create failed:', err && err.message);
    return json(res, 500, { error: 'Could not save product', detail: err && err.message });
  }
}

// ─── PATCH /api/admin/products — partial update ──────────────────────────────

async function updateProduct(req, res) {
  const session = requirePerm(req, res, 'products.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try {
    body = await readBody(req, 512 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }

  const id = body && body.id !== undefined ? body.id : (req.query && req.query.id);
  const updates = (body && body.updates) || {};
  if (id === undefined || id === null || id === '') return json(res, 400, { error: 'Product id is required' });

  try {
    const sb = supabaseAdmin();
    const { data: existing, error } = await sb.from('products').select('*').eq('id', id).maybeSingle();
    if (error) return json(res, 500, { error: 'Could not load product' });
    if (!existing) return json(res, 404, { error: 'Product not found' });

    const merged = { ...existing, ...updates };
    const normalized = validateProductPayload(merged);
    if (!normalized) return json(res, 422, { error: 'Invalid product data' });
    normalized.tags = updates.tags !== undefined ? String(updates.tags || '').replace(/[<>]/g, '').slice(0, 300) : existing.tags;

    // Only write fields the client actually sent (mirrors previous behaviour).
    const allowedKeys = [
      'name', 'category', 'price', 'salePrice', 'description', 'stock', 'variantStock',
      'sku', 'colors', 'sizes', 'images', 'image', 'sizeGuide', 'label', 'tags', 'active',
    ];
    const write = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(updates, key) && normalized[key] !== undefined) {
        write[key] = normalized[key];
      }
    }
    if (updates.image !== undefined && !write.image && updates.images && updates.images.length) {
      write.image = updates.images[0];
    }
    if (Object.keys(write).length === 0) return json(res, 400, { error: 'Nothing to update' });

    let { error: updErr } = await sb.from('products').update(write).eq('id', id);
    if (updErr && isUnknownColumn(updErr)) {
      // `active` (and similar) may not exist as a column in older schemas.
      delete write.active;
      ({ error: updErr } = await sb.from('products').update(write).eq('id', id));
    }
    if (updErr) throw updErr;

    const { data: fresh } = await sb.from('products').select('*').eq('id', id).maybeSingle();
    return json(res, 200, { success: true, product: fresh });
  } catch (err) {
    console.error('Product update failed:', err && err.message);
    return json(res, 500, { error: 'Could not update product', detail: err && err.message });
  }
}

// ─── DELETE /api/admin/products — single (with storage cleanup) or bulk ──────

// Deletes product rows and cleans up their storage files with these rules:
//  1. Rows are deleted FIRST (the operation's source of truth). If the row
//     delete fails nothing in Storage is touched, so a product never loses its
//     images while still existing.
//  2. Storage paths are extracted only from the product's own URL fields and
//     must pass the trusted-host + `products` bucket check. External images
//     (Unsplash/Cloudinary/custom hosts) are never guessed or removed.
//  3. A file still referenced by another remaining product is never removed.
//  4. Every `remove()` result is inspected explicitly; failures are retried a
//     limited number of times, logged safely (paths only, no secrets) and
//     reported back to the client so the UI never claims full success falsely.
function deleteProductRows(sb, ids, rows) {
  const candidates = [...new Set(rows.flatMap((r) => pathsFromProductImageFields(r)))];
  const cleanup = { removed: [], failed: [], shared: [] };

  const run = async () => {
    if (candidates.length > 0) {
      const usedByOthers = await storagePathsUsedByOtherProducts(sb, ids);
      const toRemove = candidates.filter((p) => !usedByOthers.has(p));
      const shared = candidates.filter((p) => usedByOthers.has(p));
      const { error } = await sb.from('products').delete().in('id', ids);
      if (error) throw error;
      if (toRemove.length > 0) {
        const res = await removeStorageFiles(sb, toRemove);
        cleanup.removed = res.removed;
        cleanup.failed = res.failed;
        for (const failed of res.failed) {
          console.error(`Product delete: file still present after retries — ${failed}`);
        }
      }
      cleanup.shared = shared;
      return cleanup;
    }
    const { error } = await sb.from('products').delete().in('id', ids);
    if (error) throw error;
    return cleanup;
  };

  return run();
}

async function deleteProducts(req, res) {
  const session = requirePerm(req, res, 'products.write');
  if (!session) return;

  const ip = clientIp(req);
  const check = rateLimit(`adminwrite:${ip}`, 60, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body = {};
  try {
    body = await readBody(req, 256 * 1024);
  } catch (e) {
    /* GET-style delete without body is tolerated below */
  }

  const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : null;
  const id = ids
    ? ''
    : (body.id !== undefined && body.id !== null ? String(body.id) : String((req.query && req.query.id) || ''));

  try {
    const sb = supabaseAdmin();

    if (ids && ids.length) {
      const { data: rows, error: rowsErr } = await sb
        .from('products')
        .select('id, images, image, sizeGuide')
        .in('id', ids);
      if (rowsErr) throw rowsErr;
      if (!rows || rows.length === 0) {
        return json(res, 200, { success: true, deleted: 0, cleanup: { removed: [], failed: [], shared: [] } });
      }
      const cleanup = await deleteProductRows(sb, ids, rows);
      return json(res, 200, { success: true, deleted: rows.length, cleanup });
    }

    if (!id) return json(res, 400, { error: 'Product id is required' });

    const { data: product, error } = await sb.from('products').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!product) {
      // already gone — treat as done, nothing to clean
      return json(res, 200, { success: true, found: false, deleted: 0, cleanup: { removed: [], failed: [], shared: [] } });
    }

    const cleanup = await deleteProductRows(sb, [id], [product]);
    return json(res, 200, { success: true, found: true, deleted: 1, cleanup });
  } catch (err) {
    console.error('Product delete failed:', err && err.message);
    return json(res, 500, { error: 'Could not delete product' });
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method === 'POST') return createProducts(req, res);
  if (req.method === 'PATCH') return updateProduct(req, res);
  if (req.method === 'DELETE') return deleteProducts(req, res);
  return json(res, 405, { error: 'Method not allowed' });
};

// Export the deletion engine so the storage-cleanup behaviour can be verified
// directly against real Supabase without going through the HTTP layer.
module.exports.deleteProductRows = deleteProductRows;
