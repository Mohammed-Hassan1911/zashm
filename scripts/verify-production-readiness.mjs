#!/usr/bin/env node
/**
 * Production preparation gates.
 *
 * Two independent checks share the runtime contract in
 * src/lib/production-env.mjs:
 *
 *   1. configuration: a separate Worker, workers.dev only for the approved
 *      temporary launch, no domain/routes/zones, no Staging references and no
 *      Staging routing regression;
 *   2. environment: every required Production binding present, non-placeholder,
 *      and pointing only at the Production Supabase project.
 *
 * A third check scans the prepared artifact so no Staging reference or
 * server-only secret can reach the public bundle.
 *
 *   node scripts/verify-production-readiness.mjs --config-only
 *   node scripts/verify-production-readiness.mjs            # full gate
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLACEHOLDER_VALUE,
  PRODUCTION_ENV_FLAG,
  PRODUCTION_ENV_VALUE,
  PRODUCTION_SUPABASE_REF,
  STAGING_SUPABASE_REF,
  STAGING_WORKER_HOST,
  TEMP_WORKERS_DEV_FLAG,
  TEMP_WORKERS_DEV_ORIGIN,
  productionConfigProblems,
} from '../src/lib/production-env.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCTION_CONFIG = 'wrangler.production.toml';
export const STAGING_CONFIG = 'wrangler.toml';
export const PRODUCTION_BUILD = 'build-production';

export function readProjectFile(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

/** Read the local .env without a dependency; explicit process.env still wins. */
export function localEnv() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    values[trimmed.slice(0, separator).trim()] = value;
  }
  return values;
}

function effectiveEnv() {
  return { ...localEnv(), ...process.env };
}

function tomlString(text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text);
  return match ? match[1] : null;
}

function workerFirstPatterns(text) {
  const block = /run_worker_first\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] || '';
  return (block.match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1)).sort();
}

/** Static, offline checks over the two wrangler configurations. */
export function checkProductionConfig() {
  const problems = [];
  if (!existsSync(resolve(ROOT, PRODUCTION_CONFIG))) return [`${PRODUCTION_CONFIG} is missing`];

  const prod = readProjectFile(PRODUCTION_CONFIG);
  const staging = readProjectFile(STAGING_CONFIG);

  if (tomlString(prod, 'name') !== 'zashm') problems.push('Production Worker name must be zashm');
  if (/^\s*name\s*=/m.test(prod.replace(/^\s*name\s*=\s*"zashm"\s*$/m, ''))) {
    problems.push('Production config declares more than one Worker name');
  }
  const workersDevEnabled = /^workers_dev\s*=\s*true\s*$/m.test(prod);
  if (!workersDevEnabled && !/^workers_dev\s*=\s*false\s*$/m.test(prod)) {
    problems.push('Production Worker must explicitly set workers_dev to true or false');
  }
  if (workersDevEnabled) {
    const tempFlag = new RegExp(`^${TEMP_WORKERS_DEV_FLAG}\\s*=\\s*"1"\\s*$`, 'm').test(prod);
    if (!tempFlag) problems.push('workers.dev launch requires the temporary opt-in flag');
    if (tomlString(prod, 'PUBLIC_BASE_URL') !== TEMP_WORKERS_DEV_ORIGIN) {
      problems.push('workers.dev launch requires the exact temporary ZASHM canonical origin');
    }
    if (tomlString(prod, 'SITEMAP_ALLOWED_ORIGINS') !== TEMP_WORKERS_DEV_ORIGIN) {
      problems.push('workers.dev launch requires the temporary origin in SITEMAP_ALLOWED_ORIGINS');
    }
    if (!/^ZASHM_STOREFRONT_NOINDEX\s*=\s*"1"\s*$/m.test(prod)) {
      problems.push('workers.dev launch requires the temporary storefront noindex flag');
    }
    if (!/^preview_urls\s*=\s*false\s*$/m.test(prod)) {
      problems.push('workers.dev launch must disable additional preview URLs');
    }
  }
  if (tomlString(prod, 'main') !== 'worker.mjs') problems.push('Production entrypoint must be worker.mjs');
  if (tomlString(prod, 'directory') !== './build-production') {
    problems.push('Production assets must come from ./build-production');
  }
  if (tomlString(prod, 'not_found_handling') !== '404-page') problems.push('Production 404 behaviour must be preserved');

  for (const forbidden of [
    /^\s*route\s*=/m, /^\s*routes\s*=/m, /^\s*pattern\s*=/m,
    /^\s*zone_id\s*=/m, /^\s*zone_name\s*=/m, /^\s*custom_domain\s*=/m,
    /^\s*\[env\./m, /^\s*\[routes\]/m,
  ]) {
    if (forbidden.test(prod)) problems.push(`Production config must not declare ${forbidden.source}`);
  }
  if (prod.includes('supabase.co') || prod.includes(STAGING_SUPABASE_REF) || prod.includes(STAGING_WORKER_HOST)) {
    problems.push('Production config must not pin a Supabase project or Staging host');
  }
  if (/^\s*[A-Z_]*(SERVICE_ROLE|SESSION_SECRET|TELEGRAM|UPSTASH|REDIS)[A-Z_]*\s*=/mi.test(prod)) {
    problems.push('Production config must not contain secret values');
  }
  if (!/^ZASHM_ENVIRONMENT\s*=\s*"production"\s*$/m.test(prod)) {
    problems.push('Production config must activate the runtime fail-closed guard');
  }

  const prodPatterns = workerFirstPatterns(prod);
  const stagingPatterns = workerFirstPatterns(staging);
  if (!prodPatterns.includes('/*')) problems.push('Production Worker lost its dynamic-route catch-all');
  if (prodPatterns.join('\n') !== stagingPatterns.join('\n')) {
    problems.push('Production run_worker_first differs from the reviewed Staging routing');
  }
  for (const pattern of ['!/assets/*', '!/fonts/*', '!/*.css', '!/*.woff2', '!/*.svg']) {
    if (!prodPatterns.includes(pattern)) problems.push(`Production assets no longer bypass the Worker (${pattern})`);
  }
  if (prodPatterns.includes('!/*.js')) problems.push('A broad !/*.js would bypass the telemetry shim');

  // Staging keeps its distinct name, assets directory and temporary noindex flag.
  if (tomlString(staging, 'name') !== 'zashm-staging') problems.push('Staging Worker name changed');
  if (!/^workers_dev\s*=\s*true\s*$/m.test(staging)) problems.push('Staging workers.dev setting changed');
  if (tomlString(staging, 'directory') !== './build') problems.push('Staging assets directory changed');
  if (!/^ZASHM_STOREFRONT_NOINDEX\s*=\s*"1"\s*$/m.test(staging)) {
    problems.push('Staging Worker must pin storefront noindex while temporary');
  }
  if (/^\s*name\s*=\s*"zashm"\s*$/m.test(staging)) problems.push('Staging config references the Production Worker name');
  if (staging.includes(TEMP_WORKERS_DEV_ORIGIN)) problems.push('Staging config references the Production origin');

  return problems;
}

/** Environment gate: force the Production flag even in a local shell. */
export function checkProductionEnv(env = effectiveEnv()) {
  const problems = productionConfigProblems({
    ...env,
    [PRODUCTION_ENV_FLAG]: PRODUCTION_ENV_VALUE,
  });
  const publicUrl = String(env.PUBLIC_BASE_URL || '');
  if (publicUrl.includes('.invalid') || publicUrl.includes('example.')) {
    problems.push('PUBLIC_BASE_URL is still a preparation placeholder domain');
  }
  if (!String(env.VITE_SUPABASE_URL || '').includes(PRODUCTION_SUPABASE_REF)) {
    problems.push('VITE_SUPABASE_URL must point at the Production project');
  }
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !PLACEHOLDER_VALUE.test(value.trim())) continue;
    if (name.startsWith('VITE_') || name.startsWith('REACT_APP_')) {
      problems.push(`${name} is still a preparation placeholder`);
    }
  }
  return problems;
}

const JWT_VALUE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SECRET_PATTERNS = [
  ['Telegram bot token', /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/],
  ['Upstash token', /\bAX[A-Za-z0-9_-]{20,}\b/],
];

/**
 * Supabase's anon key is public by design and is intentionally embedded in the
 * browser bundle. Only the exact anon JWT for the Production project may be
 * exempted; any other JWT in a public file is treated as a credential leak.
 */
function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function approvedPublicJwts(env = process.env) {
  return new Set(
    ['VITE_SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY']
      .map((name) => String(env[name] || '').trim())
      .filter((value) => value &&
        jwtClaims(value).role === 'anon' &&
        jwtClaims(value).ref === PRODUCTION_SUPABASE_REF)
  );
}
const SERVER_ONLY_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID', 'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
];
const TEXT_EXTENSIONS = /\.(html|js|mjs|css|json|txt|svg|map|xml|webmanifest)$|^\/?_headers$/;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/** Scan the prepared public artifact for cross-environment or secret leaks. */
export function checkProductionBundle(buildDir = PRODUCTION_BUILD, env = effectiveEnv()) {
  const problems = [];
  const publicJwts = approvedPublicJwts(env);
  const absolute = resolve(ROOT, buildDir);
  if (!existsSync(absolute)) return { problems: [`${buildDir} is missing`], files: [], refs: [] };

  const files = walk(absolute).filter((file) => !file.includes(`${sep}.git${sep}`));
  const refs = [];
  for (const file of files) {
    const relative = file.slice(absolute.length + 1);
    if (/^\.env|\.env$|\.dev\.vars$/.test(relative)) problems.push(`environment file copied into bundle: ${relative}`);
    if (!TEXT_EXTENSIONS.test(relative)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(STAGING_SUPABASE_REF)) problems.push(`Staging Supabase ref in ${relative}`);
    if (text.includes(STAGING_WORKER_HOST)) problems.push(`Staging Worker host in ${relative}`);
    if (text.includes('za-shm.vercel.app')) problems.push(`Vercel Production origin in ${relative}`);
    if (text.includes(PRODUCTION_SUPABASE_REF)) refs.push(relative);
    for (const match of text.matchAll(JWT_VALUE)) {
      if (!publicJwts.has(match[0])) problems.push(`JWT value in ${relative}`);
    }
    for (const [name, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text)) problems.push(`${name} in ${relative}`);
    }
    for (const name of SERVER_ONLY_NAMES) {
      if (text.includes(name)) problems.push(`server-only name ${name} in ${relative}`);
    }
  }
  if (!refs.some((name) => name === '_headers')) {
    problems.push('Production CSP _headers does not allow the Production Supabase origin');
  }
  const noindexRequired = /^ZASHM_STOREFRONT_NOINDEX\s*=\s*"1"\s*$/m
    .test(readProjectFile(PRODUCTION_CONFIG));
  if (noindexRequired) {
    const shell = join(absolute, 'index.html');
    if (!existsSync(shell) || !readFileSync(shell, 'utf8').includes('content="noindex, nofollow, noarchive"')) {
      problems.push('temporary storefront build is missing the noindex robots meta tag');
    }
    const headersFile = join(absolute, '_headers');
    if (!existsSync(headersFile) || !readFileSync(headersFile, 'utf8').includes('X-Robots-Tag: noindex, nofollow, noarchive')) {
      problems.push('temporary storefront build is missing the noindex response header');
    }
  }
  return { problems, files, refs };
}

function print(section, problems, note = '') {
  console.log(`\n[${section}]${note ? ` ${note}` : ''}`);
  if (!problems.length) {
    console.log('  ok  no problems found');
    return 0;
  }
  for (const problem of problems) console.log(`  FAIL ${problem}`);
  return problems.length;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const args = new Set(process.argv.slice(2));
  let failed = 0;
  if (!args.has('--env-only')) failed += print('config', checkProductionConfig());
  if (!args.has('--config-only') && !args.has('--bundle-only')) failed += print('environment', checkProductionEnv());
  if (!args.has('--config-only') && !args.has('--env-only')) {
    const bundle = checkProductionBundle();
    failed += print('bundle', bundle.problems, `${bundle.files.length} file(s) scanned`);
  }
  console.log(`\n${failed === 0 ? 'READY' : 'BLOCKED'}: ${failed} problem(s)`);
  process.exit(failed ? 1 : 0);
}
