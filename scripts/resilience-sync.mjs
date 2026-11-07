#!/usr/bin/env node
// ─── ZASHM resilience sync ───────────────────────────────────────────────────
// Builds the same-origin catalogue snapshot and mirrors product images into
// `public/media/`, where Vercel serves them from the same CDN as the app.
//
//   node scripts/resilience-sync.mjs                 # snapshot + mirror images
//   node scripts/resilience-sync.mjs --dry-run       # plan only, no writes
//   node scripts/resilience-sync.mjs --skip-images   # snapshot only
//   node scripts/resilience-sync.mjs --skip-catalog  # images only
//   node scripts/resilience-sync.mjs --prune         # also delete unreferenced images
//   node scripts/resilience-sync.mjs --force-prune   # allow a prune when the live view is empty
//   node scripts/resilience-sync.mjs --best-effort   # never fail (build-safe)
//
// Products that must stay out of the backup (temporary/test rows, or a product
// kept live but not wanted offline) are listed in scripts/resilience-exclude.json
// by id. They are never modified in Supabase; only the snapshot and mirror skip
// them. Removing a product from Supabase is enough on its own — `--prune` then
// deletes its now-unreferenced images from public/media.
//
// Required for the snapshot:
//   VITE_SUPABASE_URL (or REACT_APP_SUPABASE_URL)
//   VITE_SUPABASE_ANON_KEY (or REACT_APP_SUPABASE_ANON_KEY)
//
// No external storage account, credential, or credit card is involved. The
// mirrored files are committed with the repository and copied into the build by
// Vite. Keep the mirror small: `MIRROR_MAX_MB` (default 200) aborts the run
// before the repository grows past a reasonable size.
//
// The snapshot contains only the public `products_public` columns; no secret
// and no order/customer data is ever written. If Supabase cannot be reached,
// the existing snapshot is kept and the command only fails when --best-effort
// is absent (CI/release runs should surface the problem).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_FILE = resolve(ROOT, 'public/catalog-snapshot.json');
const MIRROR_DIR = resolve(ROOT, 'public/media');
const EXCLUSIONS_FILE = resolve(ROOT, 'scripts/resilience-exclude.json');
const SUPABASE_MARKER = '/storage/v1/object/public/';

const MAX_MIRROR_BYTES = Math.max(1, Number(process.env.MIRROR_MAX_MB) || 200) * 1024 * 1024;
// One oversized file must never eat the mirror budget silently. The default
// matches the admin uploader's compressed output with a little headroom; raise
// it deliberately with MIRROR_MAX_FILE_MB after reviewing the image.
const MAX_FILE_MB = Number(process.env.MIRROR_MAX_FILE_MB) > 0
  ? Number(process.env.MIRROR_MAX_FILE_MB)
  : 1.5;
export const MIRROR_MAX_FILE_BYTES = Math.round(MAX_FILE_MB * 1024 * 1024);
export { MAX_MIRROR_BYTES as MIRROR_MAX_BYTES };

/** True when an image is too large for the committed mirror. */
export function isOversizedImage(bytes, max = MIRROR_MAX_FILE_BYTES) {
  const size = Number(bytes);
  return Number.isFinite(size) && size > max;
}

function formatMB(bytes) {
  return `${(Number(bytes) / 1024 / 1024).toFixed(2)}MB`;
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipImages = args.has('--skip-images');
const skipCatalog = args.has('--skip-catalog');
const bestEffort = args.has('--best-effort');
const prune = args.has('--prune');
const forcePrune = args.has('--force-prune');

/** Load .env without overriding variables the caller already exported. */
function loadEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || '';
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY || '';
  return { url: String(url).replace(/\/+$/, ''), anonKey };
}

/** Validate a Supabase bucket key. Only the public `products/` folder is mirrored. */
export function safeBucketKey(key) {
  if (typeof key !== 'string' || !key) return '';
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return '';
  }
  if (!decoded.startsWith('products/') || decoded.includes('..') || decoded.includes('\0')) return '';
  return decoded;
}

/** Extract the `products/...` key from a Supabase Storage public URL. */
export function bucketKeyForUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  const idx = url.indexOf(SUPABASE_MARKER);
  if (idx === -1) return '';
  return safeBucketKey(url.slice(idx + SUPABASE_MARKER.length).split(/[?#]/)[0]);
}

/** Resolve a bucket key inside public/media, refusing anything outside it. */
export function localMirrorPath(key, mirrorDir = MIRROR_DIR) {
  const safeKey = safeBucketKey(key);
  if (!safeKey) return '';
  const target = resolve(mirrorDir, safeKey);
  if (!target.startsWith(`${resolve(mirrorDir)}${sep}`)) return '';
  return target;
}

/**
 * Read the repo-only exclusion list. Shape:
 *   { "excludedIds": ["1793846979234526"] }
 * Excluded products stay untouched in Supabase; they are only skipped when the
 * snapshot and the image mirror are built.
 */
export function loadExclusions(file = EXCLUSIONS_FILE) {
  if (!existsSync(file)) return new Set();
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`invalid exclusion file ${file}: ${(err && err.message) || err}`);
  }
  const ids = Array.isArray(payload)
    ? payload
    : Array.isArray(payload && payload.excludedIds)
      ? payload.excludedIds
      : null;
  if (!ids) {
    throw new Error(`invalid exclusion file ${file}: expected { "excludedIds": [] }`);
  }
  return new Set(ids.map((id) => String(id).trim()).filter(Boolean));
}

/** Drop excluded product ids from the rows used for the snapshot + mirror. */
export function filterExcluded(products, excluded) {
  const list = Array.isArray(products) ? products : [];
  if (!excluded) return list;
  const ids = excluded instanceof Set
    ? excluded
    : new Set(Array.from(excluded, (id) => String(id).trim()));
  if (ids.size === 0) return list;
  return list.filter((product) => !ids.has(String(product && product.id)));
}

/** Every file already inside the mirror, as a relative key (`products/x.jpg`). */
export function listMirrorKeys(dir = MIRROR_DIR) {
  const keys = [];
  if (!existsSync(dir)) return keys;
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        walk(resolve(current, name), prefix ? `${prefix}/${name}` : name);
      } else if (entry.isFile() && !name.endsWith('.tmp')) {
        keys.push(prefix ? `${prefix}/${name}` : name);
      }
    }
  };
  walk(dir, '');
  return keys.sort();
}

/** Keys on disk that no product references any more. */
export function selectOrphanKeys(referencedKeys, existingKeys) {
  const keep = referencedKeys instanceof Set ? referencedKeys : new Set(referencedKeys || []);
  return (existingKeys || []).filter((key) => !keep.has(key));
}

function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(resolve(dir, entry.name));
  }
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* ignore: another process may hold it */ }
}

/**
 * Delete mirrored files that no product references, so removing a product also
 * reclaims its disk space. Only files inside `dir` are touched and the caller
 * decides when pruning is safe (see main()).
 */
export function pruneMirror(keepKeys, { dir = MIRROR_DIR, dryRun: planOnly = false, log = () => {} } = {}) {
  const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
  const orphans = selectOrphanKeys(keep, listMirrorKeys(dir));
  const base = resolve(dir);
  let removed = 0;
  let bytes = 0;

  for (const key of orphans) {
    const target = resolve(base, key);
    if (!target.startsWith(`${base}${sep}`)) continue;
    if (!existsSync(target)) continue;
    const size = statSync(target).size;
    if (planOnly) {
      removed += 1;
      bytes += size;
      log(`would prune ${key} (${formatMB(size)})`);
      continue;
    }
    unlinkSync(target);
    removed += 1;
    bytes += size;
    log(`pruned ${key} (${formatMB(size)})`);
  }

  if (!planOnly && removed > 0) removeEmptyDirs(base);
  return { removed, bytes, keys: orphans };
}

function collectImageUrls(products) {
  const urls = new Map();
  for (const product of products) {
    const candidates = [];
    if (product && product.image) candidates.push(product.image);
    if (product && Array.isArray(product.images)) candidates.push(...product.images);
    if (product && product.sizeGuide) candidates.push(product.sizeGuide);
    for (const url of candidates) {
      const key = bucketKeyForUrl(url);
      if (key) urls.set(key, url);
    }
  }
  return urls;
}

async function fetchProducts() {
  const { url, anonKey } = supabaseConfig();
  if (!url || !anonKey) {
    throw new Error('Supabase URL/anon key missing (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)');
  }
  const res = await fetch(`${url}/rest/v1/products_public?select=*&order=id.asc`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase products_public failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Supabase products_public returned a non-array payload');
  return rows;
}

async function writeSnapshot(products, excludedIds = []) {
  // Keep the previous generatedAt when the payload did not change, so a routine
  // sync does not create a no-op diff.
  let existing = null;
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      existing = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
    } catch {
      existing = null;
    }
  }
  const sameProducts = existing
    && Array.isArray(existing.products)
    && JSON.stringify(existing.products) === JSON.stringify(products);
  const sameExclusions = existing
    && JSON.stringify(existing.excludedIds || []) === JSON.stringify(excludedIds);
  if (sameProducts && sameExclusions) {
    console.log(`snapshot unchanged: ${SNAPSHOT_FILE}`);
    return;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    count: products.length,
    excludedIds,
    products,
  };
  mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] would write snapshot (${products.length} products) to ${SNAPSHOT_FILE}`);
    return;
  }
  writeFileSync(SNAPSHOT_FILE, body, 'utf8');
  console.log(`snapshot written: ${SNAPSHOT_FILE} (${products.length} products)`);
}

async function syncImages(products) {
  const urls = collectImageUrls(products);
  let mirrored = 0;
  let current = 0;
  let failed = 0;
  let oversized = 0;
  let bytes = 0;

  for (const [key, url] of urls) {
    const target = localMirrorPath(key);
    if (!target) {
      failed += 1;
      console.error(`FAILED ${key}: unsafe path`);
      continue;
    }

    if (dryRun) {
      let remote = 0;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head.ok) remote = Number(head.headers.get('content-length')) || 0;
      } catch { /* size stays unknown */ }
      const onDisk = existsSync(target) ? statSync(target).size : 0;
      const remoteLabel = remote ? `remote ${formatMB(remote)}` : 'remote size unknown';
      const diskLabel = onDisk ? `on disk ${formatMB(onDisk)}` : 'missing';
      if (isOversizedImage(remote)) {
        oversized += 1;
        console.error(`[dry-run] OVERSIZED ${key} (${remoteLabel} > ${formatMB(MIRROR_MAX_FILE_BYTES)}) — compress it before release`);
      } else {
        console.log(`[dry-run] ${key} (${remoteLabel}, ${diskLabel})`);
      }
      continue;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);

      // Refuse before reading a large body when the server declares its size.
      const declared = Number(res.headers.get('content-length')) || 0;
      if (isOversizedImage(declared)) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        oversized += 1;
        if (existsSync(target)) {
          try {
            unlinkSync(target);
            console.error(`OVERSIZED ${key} — removed the stale mirror copy`);
          } catch { /* ignore */ }
        }
        console.error(`OVERSIZED ${key} (${formatMB(declared)} > ${formatMB(MIRROR_MAX_FILE_BYTES)}) — compress it before release or raise MIRROR_MAX_FILE_MB after review`);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      if (isOversizedImage(buffer.length)) {
        oversized += 1;
        // A copy from an older policy must not keep the oversized file in the
        // repository; the release check (test-resilience §8) then fails until
        // the image is compressed or the limit is deliberately raised.
        if (existsSync(target)) {
          try {
            unlinkSync(target);
            console.error(`OVERSIZED ${key} — removed the stale mirror copy`);
          } catch { /* ignore */ }
        }
        console.error(`OVERSIZED ${key} (${formatMB(buffer.length)} > ${formatMB(MIRROR_MAX_FILE_BYTES)}) — compress it before release or raise MIRROR_MAX_FILE_MB after review`);
        continue;
      }

      if (existsSync(target) && readFileSync(target).equals(buffer)) {
        current += 1;
        bytes += buffer.length;
        console.log(`current ${key} (${formatMB(buffer.length)})`);
        continue;
      }

      if (bytes + buffer.length > MAX_MIRROR_BYTES) {
        throw new Error(`mirror budget exceeded (${Math.round(MAX_MIRROR_BYTES / 1024 / 1024)}MB); raise MIRROR_MAX_MB after reviewing the repo size`);
      }

      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      writeFileSync(temp, buffer);
      renameSync(temp, target);
      mirrored += 1;
      bytes += buffer.length;
      console.log(`mirrored ${key} (${formatMB(buffer.length)})`);
    } catch (err) {
      failed += 1;
      const temp = `${target}.tmp`;
      if (existsSync(temp)) {
        try { unlinkSync(temp); } catch { /* ignore */ }
      }
      console.error(`FAILED ${key}: ${(err && err.message) || err}`);
    }
  }

  console.log(
    `images: ${mirrored} mirrored, ${current} already current, ${failed} failed, ${oversized} oversized ` +
    `(${(bytes / 1024 / 1024).toFixed(1)}MB of ${(MAX_MIRROR_BYTES / 1024 / 1024).toFixed(0)}MB budget; ` +
    `per-image limit ${formatMB(MIRROR_MAX_FILE_BYTES)})`
  );
  return { mirrored, current, failed, oversized };
}

async function main() {
  loadEnv();

  console.log(`ZASHM resilience sync${dryRun ? ' (dry run)' : ''}`);

  let excluded;
  try {
    excluded = loadExclusions();
  } catch (err) {
    console.error((err && err.message) || err);
    process.exitCode = 1;
    return;
  }
  if (excluded.size > 0) {
    console.log(
      `excluding ${excluded.size} product id(s) via scripts/resilience-exclude.json ` +
      `(${Array.from(excluded).sort().join(', ')})`
    );
  }
  if (prune && skipImages) {
    console.log('--prune ignored: it only touches the image mirror, which --skip-images disables');
  }

  let fetched = null;
  let products = null;
  let snapshotOk = skipCatalog;

  const loadProducts = async () => {
    const rows = await fetchProducts();
    fetched = rows;
    // A stale entry would silently keep filtering nothing; surface it so the
    // exclusion file can be cleaned up after the product is deleted for good.
    const knownIds = new Set(rows.map((row) => String(row && row.id)));
    const stale = Array.from(excluded).filter((id) => !knownIds.has(id));
    if (stale.length > 0) {
      console.log(
        `note: excluded id(s) not present in products_public: ${stale.join(', ')} — ` +
        'safe to remove them from scripts/resilience-exclude.json'
      );
    }
    return filterExcluded(rows, excluded);
  };

  if (!skipCatalog) {
    try {
      products = await loadProducts();
      await writeSnapshot(products, Array.from(excluded).sort());
      snapshotOk = true;
    } catch (err) {
      console.error(`snapshot failed: ${(err && err.message) || err}`);
      if (!bestEffort) process.exitCode = 1;
    }
  }

  if (!skipImages) {
    if (!products) {
      try {
        products = await loadProducts();
      } catch (err) {
        console.error(`image sync skipped: ${(err && err.message) || err}`);
        if (!bestEffort) process.exitCode = 1;
      }
    }
    if (products) {
      const result = await syncImages(products);
      if ((result.failed > 0 || result.oversized > 0) && !bestEffort) process.exitCode = 1;

      // A product removed from Supabase (or excluded above) leaves its images
      // behind. Report them every run, and delete them only when asked.
      const keepKeys = new Set(collectImageUrls(products).keys());
      const orphans = selectOrphanKeys(keepKeys, listMirrorKeys());
      if (orphans.length === 0) {
        if (prune) console.log('mirror prune: nothing to remove');
      } else {
        const orphanBytes = orphans.reduce((sum, key) => {
          const target = localMirrorPath(key);
          return sum + (target && existsSync(target) ? statSync(target).size : 0);
        }, 0);
        if (!prune) {
          console.log(
            `mirror: ${orphans.length} unused file(s) (${formatMB(orphanBytes)}) — ` +
            'run "npm run resilience:sync -- --prune" to reclaim the space'
          );
        } else if (products.length === 0 && (fetched || []).length === 0 && !forcePrune) {
          // Never wipe the mirror just because the public view suddenly returns
          // nothing (revoked grant, RLS regression, wrong project).
          console.error(
            'mirror prune refused: products_public returned zero rows. ' +
            'Pass --force-prune only after confirming the empty catalogue is intended.'
          );
          if (!bestEffort) process.exitCode = 1;
        } else {
          const pruned = pruneMirror(keepKeys, {
            dryRun,
            log: (message) => console.log(dryRun ? `[dry-run] ${message}` : message),
          });
          console.log(
            `mirror prune: ${pruned.removed} file(s), ${formatMB(pruned.bytes)} ` +
            `${dryRun ? 'would be reclaimed' : 'reclaimed'}`
          );
        }
      }
    }
  }

  if (!snapshotOk && !bestEffort) process.exitCode = 1;
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(`resilience sync crashed: ${(err && err.message) || err}`);
    if (!bestEffort) process.exitCode = 1;
  });
}
