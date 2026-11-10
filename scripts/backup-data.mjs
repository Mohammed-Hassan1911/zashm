#!/usr/bin/env node
// ─── ZASHM data backup ───────────────────────────────────────────────────────
// Pulls every operational table out of Supabase into timestamped JSON files on
// this machine, so an order/customer row is never unrecoverable.
//
//   node scripts/backup-data.mjs                  # all tables, metadata only
//   node scripts/backup-data.mjs --with-images    # + the products bucket bytes
//   node scripts/backup-data.mjs --out /path      # custom destination
//   node scripts/backup-data.mjs --keep 8         # prune all but the newest 8
//   node scripts/backup-data.mjs --dry-run        # plan only, no writes
//
// What is backed up:
//   products, orders, users, coupons, product_reviews (full rows, service role)
//   + a storage manifest for the `products` bucket (name/size/updated_at)
//   + with --with-images: the actual image files.
//
// What is NOT backed up:
//   auth.users passwords/sessions (Supabase Auth owns those) and the schema
//   itself — the schema lives in supabase/*.sql and is versioned in git.
//
// The output contains customer names, phones and addresses. `backups/` is
// git-ignored on purpose: never commit it, never paste it into a chat.
//
// Requires SUPABASE_SERVICE_ROLE_KEY. It is read from the environment or the
// local `.env`; it is never printed and never written to the backup.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** PostgREST caps a page at the project's db-max-rows (Supabase default 1000). */
export const PAGE_SIZE = 1000;
/** Hard stop so a broken `Content-Range` can never loop forever. */
export const MAX_PAGES = 10000;
/** Tables that hold data which cannot be recreated once lost. */
export const BACKUP_TABLES = ['products', 'orders', 'users', 'coupons', 'product_reviews'];
export const STORAGE_BUCKET = 'products';

/** Load .env without overriding variables the caller already exported. */
export function loadEnv(root = ROOT) {
  const file = resolve(root, '.env');
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

export function supabaseConfig() {
  const url = process.env.VITE_SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url: String(url).replace(/\/+$/, ''), serviceKey };
}

/** `2026-11-10T09-15-00Z` — sortable and filesystem-safe. */
export function stampFolder(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

/** Inclusive item range for one PostgREST page. */
export function pageRange(page, pageSize = PAGE_SIZE) {
  const start = page * pageSize;
  return `${start}-${start + pageSize - 1}`;
}

/** Parse `Content-Range: 0-999/12345` into { from, to, total }. */
export function parseContentRange(header) {
  const match = /^(\d+)-(\d+)\/(\d+|\*)$/.exec(String(header || '').trim());
  if (!match) return null;
  return {
    from: Number(match[1]),
    to: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

/** Only the host is reported; the service-role key never reaches the log. */
export function projectHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const valueOf = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--') ? argv[idx + 1] : '';
  };
  return {
    withImages: args.has('--with-images'),
    dryRun: args.has('--dry-run'),
    out: valueOf('--out'),
    keep: Number(valueOf('--keep')) > 0 ? Number(valueOf('--keep')) : 0,
    verbose: args.has('--verbose'),
  };
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function fetchPage(baseUrl, table, page, key, pageSize = PAGE_SIZE) {
  const res = await fetch(`${baseUrl}/rest/v1/${table}?select=*&order=id.asc`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Range-Unit': 'items',
      Range: pageRange(page, pageSize),
      Prefer: 'count=exact',
    },
  });
  if (res.status === 416) return { rows: [], total: 0 };
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${table} page ${page}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} page ${page}: non-array payload`);
  const range = parseContentRange(res.headers.get('content-range'));
  return { rows, total: range ? range.total : null };
}

/** Every row of one table, paging past the 1000-row server cap. */
export async function fetchAllRows(baseUrl, table, key, pageSize = PAGE_SIZE) {
  const rows = [];
  let total = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(baseUrl, table, page, key, pageSize);
    if (total === null && result.total !== null) total = result.total;
    rows.push(...result.rows);
    if (result.rows.length < pageSize) break;
  }
  if (total !== null && rows.length !== total) {
    throw new Error(`${table}: fetched ${rows.length} rows but the server reported ${total}`);
  }
  return { rows, total };
}

async function listBucket(baseUrl, key, bucket = STORAGE_BUCKET) {
  const objects = [];
  for (let offset = 0; offset < MAX_PAGES * PAGE_SIZE; offset += PAGE_SIZE) {
    const res = await fetch(`${baseUrl}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' }, prefix: '' }),
    });
    if (!res.ok) throw new Error(`storage list ${bucket}: HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error(`storage list ${bucket}: non-array payload`);
    for (const item of page) {
      if (!item || !item.id) continue;
      objects.push({
        name: item.name,
        size: Number(item.metadata && item.metadata.size) || 0,
        updatedAt: (item.metadata && item.metadata.lastModified) || item.updated_at || null,
        mimetype: (item.metadata && item.metadata.mimetype) || null,
      });
    }
    if (page.length < PAGE_SIZE) break;
  }
  return objects;
}

async function downloadObject(baseUrl, key, bucket, name, target) {
  const safe = String(name || '');
  if (!safe || safe.includes('..') || safe.includes('\0') || safe.startsWith('/')) {
    throw new Error(`refusing unsafe storage key: ${safe}`);
  }
  const res = await fetch(`${baseUrl}/storage/v1/object/${bucket}/${safe.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`download ${safe}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const dest = resolve(target, safe);
  if (!dest.startsWith(`${resolve(target)}/`)) throw new Error(`refusing path outside the backup: ${safe}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  return bytes.length;
}

function pruneOld(outDir, keep) {
  if (!keep || !existsSync(outDir)) return [];
  const entries = readdirSync(outDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .map((name) => ({ name, path: join(outDir, name), mtime: statSync(join(outDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = [];
  for (const entry of entries.slice(keep)) {
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export async function runBackup(options = {}) {
  const {
    withImages = false,
    dryRun = false,
    out = '',
    keep = 0,
    verbose = false,
    quiet = false,
    now = new Date(),
  } = options;
  const log = quiet ? () => {} : console.log;

  const { url, serviceKey } = supabaseConfig();
  if (!url || !serviceKey) {
    throw new Error('Supabase URL or SUPABASE_SERVICE_ROLE_KEY is missing (.env or environment)');
  }

  const baseOut = resolve(out || join(ROOT, 'backups'));
  const dir = join(baseOut, stampFolder(now));
  const host = projectHost(url);
  log(`ZASHM backup — project ${host}`);
  log(`destination: ${dir}`);
  if (dryRun) log('[dry-run] no files will be written');

  const tables = {};
  let failed = 0;

  for (const table of BACKUP_TABLES) {
    try {
      const { rows, total } = await fetchAllRows(url, table, serviceKey);
      const body = `${JSON.stringify(rows, null, 2)}\n`;
      const bytes = Buffer.byteLength(body);
      tables[table] = { rows: rows.length, reportedTotal: total, bytes, sha256: sha256(body), error: null };
      if (verbose) log(`  ${table}: ${rows.length} rows, ${(bytes / 1024).toFixed(1)} KB`);
      if (!dryRun) {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${table}.json`);
        writeFileSync(file, body);
        const reread = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(reread) || reread.length !== rows.length) {
          throw new Error(`verification failed: wrote ${rows.length} rows but read back ${reread.length}`);
        }
      }
    } catch (err) {
      failed += 1;
      tables[table] = { rows: 0, reportedTotal: null, bytes: 0, sha256: null, error: (err && err.message) || String(err) };
      console.error(`  ${table}: FAILED — ${(err && err.message) || err}`);
    }
  }

  let storage = null;
  try {
    const objects = await listBucket(url, serviceKey);
    const bytes = objects.reduce((sum, o) => sum + o.size, 0);
    storage = { bucket: STORAGE_BUCKET, objects: objects.length, bytes, items: objects, error: null };
    if (verbose) log(`  storage/${STORAGE_BUCKET}: ${objects.length} objects, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    if (withImages && !dryRun && objects.length > 0) {
      const target = join(dir, 'storage');
      let downloaded = 0;
      for (const object of objects) {
        downloaded += await downloadObject(url, serviceKey, STORAGE_BUCKET, object.name, target);
      }
      storage.downloadedBytes = downloaded;
      if (downloaded !== bytes) {
        throw new Error(`image download mismatch: ${downloaded} of ${bytes} bytes`);
      }
    }
  } catch (err) {
    failed += 1;
    storage = { bucket: STORAGE_BUCKET, objects: 0, bytes: 0, items: [], error: (err && err.message) || String(err) };
    console.error(`  storage/${STORAGE_BUCKET}: FAILED — ${(err && err.message) || err}`);
  }

  const manifest = {
    generatedAt: now.toISOString(),
    project: host,
    withImages: Boolean(withImages && !dryRun),
    tables,
    storage: storage ? {
      bucket: storage.bucket,
      objects: storage.objects,
      bytes: storage.bytes,
      downloadedBytes: storage.downloadedBytes || 0,
      error: storage.error,
    } : null,
  };

  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  log('\ntable                 rows      size');
  for (const table of BACKUP_TABLES) {
    const entry = tables[table];
    const size = entry.bytes ? `${(entry.bytes / 1024).toFixed(1)} KB` : '-';
    const status = entry.error ? `FAILED: ${entry.error}` : String(entry.rows);
    log(`${table.padEnd(20)} ${status.padStart(6)} ${size.padStart(10)}`);
  }
  if (storage) {
    log(`${('storage/' + STORAGE_BUCKET).padEnd(20)} ${String(storage.objects).padStart(6)} ${(`${(storage.bytes / 1024 / 1024).toFixed(2)} MB`).padStart(10)}${storage.error ? `  FAILED: ${storage.error}` : ''}`);
  }

  if (!dryRun && keep) {
    const removed = pruneOld(baseOut, keep);
    if (removed.length) log(`pruned ${removed.length} older backup(s)`);
  }

  if (!dryRun) {
    log(`\nwrote ${dir}`);
    log('WARNING: this folder holds customer names, phones and addresses — keep it off git and out of chats.');
  }
  if (failed > 0) throw new Error(`${failed} source(s) failed — the backup is incomplete`);
  return manifest;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadEnv();
  runBackup(parseArgs()).catch((err) => {
    console.error(`\nbackup failed: ${(err && err.message) || err}`);
    process.exit(1);
  });
}
