/**
 * Production environment contract for the Cloudflare Worker.
 *
 * This module is intentionally pure and dependency-free: the Worker uses it to
 * fail closed before touching Supabase, and the preparation/verification
 * scripts use the same rules so a build cannot quietly inherit Staging values.
 *
 * The guard only activates when the Worker binding ZASHM_ENVIRONMENT is exactly
 * "production". Staging (`zashm`) has no such binding and is unaffected.
 */

export const PRODUCTION_ENV_FLAG = 'ZASHM_ENVIRONMENT';
export const PRODUCTION_ENV_VALUE = 'production';
export const PRODUCTION_SUPABASE_REF = 'ptegprcbtfylqhbnbkih';
export const STAGING_SUPABASE_REF = 'sfenutmgfawuhmvwkmhv';
export const STAGING_WORKER_HOST = 'zashm.mohammedhassanmail1.workers.dev';

export const REQUIRED_PRODUCTION_BINDINGS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET',
  'PUBLIC_BASE_URL',
  'ALLOWED_ORIGINS',
];

// Values shipped in the preparation scaffold are deliberately invalid. A real
// deployment must replace every one of them before the gate can pass.
export const PLACEHOLDER_VALUE = /^(PREP_|REPLACE_|CHANGE_|YOUR_|__|<)/i;

// Client-visible variables must never carry a server-only credential.
const FORBIDDEN_CLIENT_PREFIX = /^(VITE_|REACT_APP_)/;
const FORBIDDEN_SECRET_NAME = /(SERVICE_ROLE|SESSION_SECRET|TELEGRAM|UPSTASH|REDIS)/i;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function httpsOrigin(value) {
  if (!nonEmptyString(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isProductionEnv(env = {}) {
  return env && env[PRODUCTION_ENV_FLAG] === PRODUCTION_ENV_VALUE;
}

/** Supabase URL used by the Worker, following the shared build-time precedence. */
export function supabaseUrlFromEnv(env = {}) {
  return env?.VITE_SUPABASE_URL || env?.REACT_APP_SUPABASE_URL || env?.SUPABASE_URL || '';
}

/**
 * Return every reason a production Worker must refuse to serve.
 * An empty array means the deployment is configured for its own project only.
 */
export function productionConfigProblems(env = {}) {
  if (!isProductionEnv(env)) return [];

  const problems = [];
  for (const name of REQUIRED_PRODUCTION_BINDINGS) {
    const value = env[name];
    if (!nonEmptyString(value)) {
      problems.push(`${name} is missing`);
    } else if (PLACEHOLDER_VALUE.test(value.trim())) {
      problems.push(`${name} is still a preparation placeholder`);
    }
  }

  const supabaseUrl = supabaseUrlFromEnv(env);
  const origin = httpsOrigin(supabaseUrl);
  if (!origin) {
    problems.push('VITE_SUPABASE_URL must be an https origin without credentials or path');
  } else {
    if (!origin.includes(PRODUCTION_SUPABASE_REF)) {
      problems.push('VITE_SUPABASE_URL is not the Production Supabase project');
    }
    if (origin.includes(STAGING_SUPABASE_REF)) {
      problems.push('VITE_SUPABASE_URL points at the Staging Supabase project');
    }
  }

  const publicOrigin = httpsOrigin(env.PUBLIC_BASE_URL);
  if (!publicOrigin) {
    problems.push('PUBLIC_BASE_URL must be an explicit https origin');
  } else if (publicOrigin.includes(STAGING_WORKER_HOST) || publicOrigin.includes('.workers.dev')) {
    problems.push('PUBLIC_BASE_URL must not be a workers.dev origin');
  } else if (publicOrigin.includes('vercel.app')) {
    problems.push('PUBLIC_BASE_URL must not be the old vercel.app origin');
  }

  const allowed = nonEmptyString(env.ALLOWED_ORIGINS) ? env.ALLOWED_ORIGINS : '';
  if (allowed.includes(STAGING_SUPABASE_REF) || allowed.includes(STAGING_WORKER_HOST)) {
    problems.push('ALLOWED_ORIGINS contains a Staging origin');
  }

  const telegramToken = env.TELEGRAM_BOT_TOKEN;
  const telegramChat = env.TELEGRAM_CHAT_ID;
  if (nonEmptyString(telegramToken) !== nonEmptyString(telegramChat)) {
    problems.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together or omitted together');
  }

  for (const [name, value] of Object.entries(env)) {
    if (!FORBIDDEN_CLIENT_PREFIX.test(name) || !FORBIDDEN_SECRET_NAME.test(name)) continue;
    if (nonEmptyString(value)) problems.push(`${name} must not be a public build-time variable`);
  }

  return problems;
}

/** The exact response used by the Worker when the production guard fails. */
export function productionGuardResponse() {
  return new Response('Production environment is not configured.', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
