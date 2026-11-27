#!/usr/bin/env node
// Regenerate the reviewed public catalogue snapshot used by offline/release
// builds. This is a READ-ONLY anon request to `products_public`; it never writes
// to Supabase and never reads a service-role key. The snapshot contains only the
// public fields the prerender needs, so it is safe to keep in the repository.
//
//   node scripts/catalogue-snapshot.mjs
//
// Refresh it deliberately after catalogue changes, then include the diff in the
// release review. An empty or non-array response is a hard failure: publishing
// that snapshot would erase every product URL from the generated sitemap.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'config/catalogue-snapshot.json');
const TIMEOUT_MS = 15000;
const FIELDS = [
  'id',
  'name',
  'price',
  'salePrice',
  'category',
  'stock',
  'image',
  'images',
  'description',
  'label',
  'rating',
  'reviews',
  'sku',
  'sizes',
  'colors',
  'variantStock',
];

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

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function publicRow(row) {
  const out = {};
  for (const field of FIELDS) {
    if (row && row[field] !== undefined) out[field] = row[field];
  }
  return out;
}

async function main() {
  loadEnv();
  const url = firstEnv(['VITE_SUPABASE_URL', 'REACT_APP_SUPABASE_URL', 'SUPABASE_URL']);
  const anonKey = firstEnv(['VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']);
  if (!url || !anonKey) {
    throw new Error('set the public Supabase URL and anon key in .env (VITE_* or REACT_APP_*)');
  }

  const endpoint = new URL('/rest/v1/products_public', url);
  endpoint.searchParams.set('select', FIELDS.join(','));
  endpoint.searchParams.set('order', 'id.asc');
  const response = await fetch(endpoint, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`products_public HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('products_public returned a non-array payload');
  if (rows.length === 0) throw new Error('products_public returned no rows; refusing to publish an empty snapshot');

  const snapshot = rows.map(publicRow);
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`catalogue snapshot: wrote ${snapshot.length} public product(s) to config/catalogue-snapshot.json`);
}

main().catch((err) => {
  console.error(`catalogue snapshot failed: ${(err && err.message) || String(err)}`);
  process.exitCode = 1;
});
