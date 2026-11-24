/**
 * Production preparation isolation tests.
 *
 * Proves that the Production artifact and its Worker configuration cannot
 * inherit Staging data, that the fail-closed gate really blocks an incomplete
 * environment, and that no server-only secret reaches the public bundle.
 *
 *   node scripts/test-production-isolation.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkProductionBundle,
  checkProductionConfig,
  checkProductionEnv,
  PRODUCTION_BUILD,
  PRODUCTION_CONFIG,
  ROOT,
  STAGING_CONFIG,
} from './verify-production-readiness.mjs';
import {
  PRODUCTION_ENV_FLAG,
  PRODUCTION_SUPABASE_REF,
  STAGING_SUPABASE_REF,
  STAGING_WORKER_HOST,
  isProductionEnv,
  productionConfigProblems,
} from '../src/lib/production-env.mjs';
import { handleRequest } from '../src/lib/worker-runtime.mjs';

let passed = 0;
let failed = 0;
function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}
const projectFile = (name) => readFileSync(resolve(ROOT, name), 'utf8');
const configText = projectFile(PRODUCTION_CONFIG);
const stagingText = projectFile(STAGING_CONFIG);
const bundleFile = (name) => readFileSync(resolve(ROOT, PRODUCTION_BUILD, name), 'utf8');

const COMPLETE_ENV = {
  VITE_SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: 'dummy-anon-value-for-isolation-tests',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-for-isolation-tests',
  SESSION_SECRET: 'dummy-session-secret-for-isolation-tests',
  PUBLIC_BASE_URL: 'https://zashm.example',
  ALLOWED_ORIGINS: 'https://zashm.example',
  TELEGRAM_BOT_TOKEN: 'dummy-telegram-token-for-isolation-tests',
  TELEGRAM_CHAT_ID: 'dummy-telegram-chat-for-isolation-tests',
};

section(1, 'separate Worker configuration');
eq(checkProductionConfig(), [], 'production and staging configs pass every isolation rule');
ok(configText.includes('name = "zashm-production"'), 'Production Worker has its own name');
ok(!/^\s*name\s*=\s*"zashm"\s*$/m.test(configText), 'Production config never uses the Staging name');
ok(/^workers_dev\s*=\s*false\s*$/m.test(configText), 'workers.dev endpoint is disabled');
ok(!/^\s*(route|routes|pattern|zone_id|zone_name|custom_domain)\s*=/m.test(configText), 'no route, zone or custom domain is declared');
ok(configText.includes('directory = "./build-production"'), 'Production assets are a separate directory');
ok(configText.includes('ZASHM_ENVIRONMENT = "production"'), 'runtime fail-closed guard is activated');
ok(!configText.includes(STAGING_SUPABASE_REF) && !configText.includes(STAGING_WORKER_HOST), 'Production config has no Staging reference');
ok(!configText.includes('SESSION_SECRET') && !configText.includes('SERVICE_ROLE'), 'Production config carries no secret value');
ok(stagingText.includes('name = "zashm"') && /^workers_dev\s*=\s*true\s*$/m.test(stagingText), 'Staging config is unchanged');
ok(stagingText.includes('directory = "./build"'), 'Staging still builds from build/');

section(2, 'environment fail-closed');
const emptyProblems = checkProductionEnv({});
ok(emptyProblems.length > 0, 'an empty Production environment is blocked');
for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'PUBLIC_BASE_URL', 'ALLOWED_ORIGINS']) {
  ok(emptyProblems.some((p) => p.includes(name)), `missing ${name} is reported`);
}
ok(checkProductionEnv({ ...COMPLETE_ENV, VITE_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co` })
  .some((p) => p.includes('not the Production Supabase project')), 'a Staging Supabase URL is rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, VITE_SUPABASE_ANON_KEY: 'PREP_ANON_KEY_NOT_A_REAL_CREDENTIAL' })
  .some((p) => p.includes('placeholder')), 'preparation placeholders are rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, PUBLIC_BASE_URL: 'https://production-prep.invalid' })
  .some((p) => p.includes('placeholder domain')), 'placeholder domain is rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, PUBLIC_BASE_URL: `https://${STAGING_WORKER_HOST}` })
  .some((p) => p.includes('workers.dev')), 'Staging Worker origin is rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, PUBLIC_BASE_URL: 'https://za-shm.vercel.app' })
  .some((p) => p.includes('vercel.app')), 'old Vercel origin is rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, TELEGRAM_CHAT_ID: '' })
  .some((p) => p.includes('together')), 'half-configured Telegram secrets are rejected');
ok(checkProductionEnv({ ...COMPLETE_ENV, VITE_SERVICE_ROLE_KEY: 'leaked' })
  .some((p) => p.includes('must not be a public')), 'service-role value in VITE_* is rejected');
eq(checkProductionEnv(COMPLETE_ENV), [], 'a complete, Production-only environment passes');
eq(isProductionEnv({}), false, 'Staging environment does not activate the Production guard');
eq(isProductionEnv({ [PRODUCTION_ENV_FLAG]: 'production' }), true, 'Production flag activates the guard');
ok(productionConfigProblems({ [PRODUCTION_ENV_FLAG]: 'production' }).length > 0, 'runtime guard sees an incomplete environment');

section(3, 'Worker refuses requests before any API work');
const guarded = await handleRequest(new Request('https://zashm.example/'), { [PRODUCTION_ENV_FLAG]: 'production' });
eq(guarded.status, 503, 'incomplete Production Worker returns 503');
ok(guarded.headers.get('Cache-Control') === 'no-store', 'guard response is not cached');
ok(guarded.headers.get('X-Robots-Tag')?.includes('noindex'), 'guard response is not indexable');
const guardBody = await guarded.text();
ok(!guardBody.includes('is missing') && !guardBody.includes('Staging'), 'guard does not leak configuration details');
const halfGuarded = await handleRequest(new Request('https://zashm.example/'), {
  [PRODUCTION_ENV_FLAG]: 'production',
  ...COMPLETE_ENV,
  VITE_SUPABASE_URL: `https://${STAGING_SUPABASE_REF}.supabase.co`,
});
eq(halfGuarded.status, 503, 'Production Worker with a Staging Supabase URL is blocked');
const fakeAssets = { fetch: async () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/html' } }) };
const stagingResponse = await handleRequest(new Request('https://zashm.example/'), { ASSETS: fakeAssets });
eq(stagingResponse.status, 200, 'Staging behaviour is unaffected by the Production guard');

section(4, 'prepared Production build');
const bundle = checkProductionBundle();
eq(bundle.problems, [], 'public artifact has no isolation or secret problems');
ok(bundle.files.length > 0, `build-production is populated (${bundle.files.length} files)`);
for (const name of ['index.html', '_headers', '404.html']) {
  ok(existsSync(resolve(ROOT, PRODUCTION_BUILD, name)), `${name} exists in the Production artifact`);
}
const shell = bundleFile('index.html');
const headers = bundleFile('_headers');
ok(shell.includes(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`), 'CSP preconnect uses the Production project');
ok(!shell.includes(STAGING_SUPABASE_REF), 'shell has no Staging Supabase ref');
ok(!shell.includes('za-shm.vercel.app'), 'shell has no Vercel Production canonical');
ok(shell.includes('production-prep.invalid'), 'canonical uses the non-public preparation placeholder');
ok(headers.includes(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`), 'static CSP allows only the Production Supabase origin');
ok(!headers.includes('__ZASHM_SUPABASE_ORIGIN__'), 'Supabase placeholder was filled for this build');
ok(!existsSync(resolve(ROOT, PRODUCTION_BUILD, '_redirects')), 'no redirects can send Production traffic elsewhere');
for (const name of ['.env', '.dev.vars']) {
  ok(!existsSync(resolve(ROOT, PRODUCTION_BUILD, name)), `${name} was not copied into the artifact`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
