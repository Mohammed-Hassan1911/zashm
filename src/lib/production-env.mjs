/**
 * Production environment contract for the Cloudflare Worker.
 *
 * This module is intentionally pure and dependency-free: the Worker uses it to
 * fail closed before touching Supabase, and the preparation/verification
 * scripts use the same rules so a build cannot quietly inherit Staging values.
 *
 * The guard only activates when the Worker binding ZASHM_ENVIRONMENT is exactly
 * "production". Staging (`zashm-staging`) has no such binding and is unaffected.
 */

export const PRODUCTION_ENV_FLAG = 'ZASHM_ENVIRONMENT';
export const PRODUCTION_ENV_VALUE = 'production';
export const PRODUCTION_SUPABASE_REF = 'ptegprcbtfylqhbnbkih';
export const STAGING_SUPABASE_REF = 'sfenutmgfawuhmvwkmhv';
export const STAGING_WORKER_HOST = 'zashm-staging.za-shm.workers.dev';
// Temporary, brand-named canonical origin used only while the paid domain is
// purchased. It stays rejected by the guard unless the explicit opt-in flag is
// present, and the Staging host is never allowed even with the flag.
export const TEMP_WORKERS_DEV_ORIGIN = 'https://zashm.za-shm.workers.dev';
export const TEMP_WORKERS_DEV_FLAG = 'ZASHM_TEMP_WORKERS_DEV';

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

function isLoopbackHost(host) {
  const value = host.toLowerCase();
  if (value === 'localhost' || value.endsWith('.localhost') ||
      value === '0' || value === '0.0.0.0' ||
      /^127(?:\.\d{1,3}){3}$/.test(value)) return true;
  const ipv6 = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  return ipv6 === '::1' || ipv6 === '0:0:0:0:0:0:0:1' ||
    /^::ffff:(?:127(?:\.\d{1,3}){3}|7f00:[0-9a-f]{1,4})$/i.test(ipv6);
}

/**
 * Validate one ALLOWED_ORIGINS entry. Production may only name explicit HTTPS
 * origins; retired Vercel, loopback, Staging and unapproved workers.dev hosts
 * are refused even when the rest of the guard is bypassed by a bad deploy.
 */
function allowedOriginProblem(rawValue, env) {
  const value = rawValue.trim();
  if (/\*/.test(value)) {
    return 'ALLOWED_ORIGINS must name explicit origins, not wildcards';
  }

  let host = '';
  let parsed = null;
  try {
    parsed = new URL(value);
    host = parsed.hostname.toLowerCase();
  } catch {
    return 'ALLOWED_ORIGINS must contain explicit https origins';
  }

  // A trailing dot is a different DNS name to browsers but resolves to the
  // same host. Fail closed instead of normalising an ambiguous allow-list.
  if (host.endsWith('.')) {
    return 'ALLOWED_ORIGINS must not use a trailing-dot hostname';
  }

  // Vercel is the retired public origin and localhost is a development-only
  // fallback. Neither may be authorised by a Production binding.
  if (host === 'za-shm.vercel.app' || host.endsWith('.vercel.app')) {
    return 'ALLOWED_ORIGINS contains the retired Vercel origin';
  }
  if (isLoopbackHost(host)) {
    return 'ALLOWED_ORIGINS contains a localhost origin';
  }
  if (host.includes(STAGING_SUPABASE_REF) || host.includes(STAGING_WORKER_HOST)) {
    return 'ALLOWED_ORIGINS contains a Staging origin';
  }
  if (parsed.port) {
    return 'ALLOWED_ORIGINS must use the default HTTPS port';
  }
  if (host.endsWith('.workers.dev')) {
    if (httpsOrigin(value) !== TEMP_WORKERS_DEV_ORIGIN) {
      return 'ALLOWED_ORIGINS contains an unapproved workers.dev origin';
    }
    if (String(env[TEMP_WORKERS_DEV_FLAG] || '') !== '1') {
      return 'ALLOWED_ORIGINS uses the temporary workers.dev origin without the opt-in flag';
    }
  }
  if (!httpsOrigin(value)) {
    return 'ALLOWED_ORIGINS must contain explicit https origins without credentials, path, query or hash';
  }
  return null;
}

/** Return the parsed, production-safe allow-list and any reasons to fail closed. */
function inspectAllowedOrigins(env) {
  const raw = env.ALLOWED_ORIGINS;
  // Missing/placeholder values are already reported by REQUIRED_PRODUCTION_BINDINGS.
  if (!nonEmptyString(raw) || PLACEHOLDER_VALUE.test(raw.trim())) {
    return { origins: [], problems: [] };
  }

  const problems = [];
  const addProblem = (message) => {
    if (!problems.includes(message)) problems.push(message);
  };
  const entries = raw.split(',').map((s) => s.trim());
  if (entries.some((entry) => !entry)) {
    addProblem('ALLOWED_ORIGINS contains an empty entry');
  }

  const origins = [];
  for (const entry of entries) {
    if (!entry) continue;
    const problem = allowedOriginProblem(entry, env);
    if (problem) addProblem(problem);
    else origins.push(httpsOrigin(entry));
  }

  // If the canonical site origin is not in the allow-list, the storefront's own
  // /api calls would be denied. That is a configuration error, not a reason to
  // silently widen the list.
  const publicOrigin = httpsOrigin(env.PUBLIC_BASE_URL);
  if (!problems.length && publicOrigin && !origins.includes(publicOrigin)) {
    addProblem('ALLOWED_ORIGINS must include PUBLIC_BASE_URL');
  }
  return { origins: problems.length ? [] : origins, problems };
}

/** The exact Production origin list; empty whenever the configuration is unsafe. */
export function allowedOriginsFromEnv(env = {}) {
  if (!isProductionEnv(env)) return [];
  return inspectAllowedOrigins(env).origins;
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
  const tempOriginAllowed = String(env[TEMP_WORKERS_DEV_FLAG] || '') === '1' &&
    publicOrigin === TEMP_WORKERS_DEV_ORIGIN;
  if (!publicOrigin) {
    problems.push('PUBLIC_BASE_URL must be an explicit https origin');
  } else if (publicOrigin.includes(STAGING_WORKER_HOST) ||
             (publicOrigin.includes('.workers.dev') && !tempOriginAllowed)) {
    problems.push('PUBLIC_BASE_URL must not be a workers.dev origin');
  } else if (publicOrigin.includes('vercel.app')) {
    problems.push('PUBLIC_BASE_URL must not be the old vercel.app origin');
  }

  problems.push(...inspectAllowedOrigins(env).problems);

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
