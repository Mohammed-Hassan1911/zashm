/**
 * Client error reporting — /api/errors + src/lib/errorReporting.js.
 *
 *   node scripts/test-error-reporting.mjs
 *
 * The endpoint is deliberately boring: no database, no echo, no unbounded text.
 * These tests pin the contract that keeps it boring:
 *   - method guard, OPTIONS, no-store, no CORS widening
 *   - one greppable CLIENT-ERROR log line per accepted report
 *   - control characters collapsed, every field truncated
 *   - invalid / oversized payloads rejected before anything is logged
 *   - 30 reports per IP per 10 minutes, then 429 (other IPs unaffected)
 *   - Telegram is optional: no env → no network call, still a 200
 *   - the browser reporter is capped, de-duped, dev-off and PII-free
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    if (process.env.VERBOSE) console.log(`  ok  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
function ok(value, label) { eq(Boolean(value), true, label); }

// ─── Boot the real handler ───────────────────────────────────────────────────
// The shared limiter tries Postgres before its in-memory fallback. A stub
// client without `.rpc` makes that first attempt fail instantly, which is the
// same path production takes when the database is unreachable.
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};
const handler = require('../api/_errors.js');
const lib = require('../api/_lib.js');
Module._load = originalLoad;

// ─── HTTP fakes ──────────────────────────────────────────────────────────────
function makeReq({ method = 'POST', body, raw, ip = '198.51.100.7', headers = {} } = {}) {
  const text = raw !== undefined ? raw : body === undefined ? '' : JSON.stringify(body);
  const listeners = {};
  const req = {
    method,
    headers: {
      'x-real-ip': ip,
      'content-type': 'application/json',
      origin: 'https://za-shm.vercel.app',
      ...headers,
    },
    query: {},
    socket: { remoteAddress: ip },
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      if (event === 'data' && text) setImmediate(() => cb(Buffer.from(text)));
      if (event === 'end') setImmediate(() => cb());
      return req;
    },
    resume() {},
    destroy() {},
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    appendHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
}

async function call(opts = {}) {
  const req = makeReq(opts);
  const res = makeRes();
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

// Capture what the handler writes to the function log / console.
function captureConsole(fn) {
  const lines = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...args) => lines.push(args.map(String).join(' '));
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  console.log = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
    })
    .then((result) => ({ result, lines }));
}

const ip = (n) => `198.51.100.${n}`;
const valid = { kind: 'error', message: 'boom', route: '/shop', stack: 'at x', app: 'zashm-web', userAgent: 'test' };

// ─── [1] the browser side is bounded and PII-free ───────────────────────────
console.log('\n[1] client reporter');
{
  const src = read('src/lib/errorReporting.js');
  ok(/export function reportError/.test(src), 'the reporter exports reportError');
  ok(/export function installErrorReporting/.test(src), 'the reporter exports installErrorReporting');
  ok(/MAX_REPORTS = 5/.test(src), 'a page can send at most 5 reports');
  ok(/seen\.has\(key\)/.test(src), 'identical reports are de-duped before sending');
  ok(/sendBeacon/.test(src) && /keepalive: true/.test(src), 'reports survive a closing tab (beacon, then keepalive fetch)');
  ok(/credentials: 'omit'/.test(src), 'a report never carries cookies');
  ok(/import\.meta\.env\.DEV/.test(src), 'the reporter is off in dev builds');
  ok(/localhost/.test(src) && /127\.0\.0\.1/.test(src), 'the reporter is off on localhost');
  ok(/pathname/.test(src) && !/search/.test(src), 'only the path is reported, never the query string');
  ok(/MAX_MESSAGE = 300/.test(src) && /MAX_STACK = 1200/.test(src), 'message and stack are size-capped');
  ok(!/password|email|localStorage|document\.cookie/i.test(src), 'the reporter never reads form values, email or storage');

  const index = read('src/index.js');
  ok(/installErrorReporting\(\)/.test(index), 'the entry point installs the global hooks');
  ok(
    index.indexOf('installErrorReporting()') < index.indexOf('root.render'),
    'reporting is installed before the first render'
  );

  const boundary = read('src/components/ui/ErrorBoundary.js');
  ok(/reportError\('boundary'/.test(boundary), 'the error boundary reports render failures');
}

// ─── [2] method guard, OPTIONS and headers ─────────────────────────────────
console.log('\n[2] transport contract');
{
  const get = await call({ method: 'GET', ip: ip(1) });
  eq(get.status, 405, 'GET → 405');
  eq(get.headers['cache-control'], 'no-store', 'error responses are not cacheable');

  const options = await call({ method: 'OPTIONS', ip: ip(2) });
  eq(options.status, 204, 'OPTIONS → 204');

  const { result: accepted } = await captureConsole(() => call({ body: valid, ip: ip(3) }));
  eq(accepted.status, 200, 'a valid report → 200');
  eq(accepted.body, { ok: true }, 'the response is a fixed acknowledgement');
  eq(accepted.headers['cache-control'], 'no-store', 'success responses are not cacheable');
}

// ─── [3] payload validation ────────────────────────────────────────────────
console.log('\n[3] payload validation');
{
  const noMessage = await call({ body: { kind: 'error' }, ip: ip(4) });
  eq(noMessage.status, 400, 'a report without a message → 400');

  const blankMessage = await call({ body: { message: '   ' }, ip: ip(5) });
  eq(blankMessage.status, 400, 'a whitespace-only message → 400');

  const array = await call({ body: [valid], ip: ip(6) });
  eq(array.status, 400, 'an array body → 400');

  const text = await call({ raw: 'not json', ip: ip(7) });
  eq(text.status, 400, 'invalid JSON → 400');

  const huge = await call({ body: { message: 'x'.repeat(9000) }, ip: ip(8) });
  eq(huge.status, 413, 'a body over 8 KB → 413');
}

// ─── [4] sanitisation and the log line ─────────────────────────────────────
console.log('\n[4] sanitisation');
{
  const hostile = {
    kind: 'not-a-kind',
    message: 'line1\nline2\r\nFAKE-LOG-LINE\u0000\u0007  spaced   out',
    route: '/x'.repeat(400),
    stack: 's'.repeat(2500),
    app: 'a'.repeat(200),
    userAgent: 'u'.repeat(2000),
  };
  // Start from a clean alert window so the Telegram branch is deterministic.
  handler._alertState.windowStart = 0;
  handler._alertState.sent = 0;
  handler._alertState.seen.clear();
  const { result, lines } = await captureConsole(() => call({ body: hostile, ip: ip(9) }));
  eq(result.status, 200, 'a hostile but well-formed report is still accepted');
  eq(result.body, { ok: true }, 'the payload is never echoed back');

  const logged = lines.find((line) => line.startsWith('CLIENT-ERROR')) || '';
  ok(Boolean(logged), 'one CLIENT-ERROR line is written');
  ok(!/\n/.test(logged), 'the log entry stays on a single line');
  ok(!/[\u0000-\u001f\u007f]/.test(logged.replace('CLIENT-ERROR', '')), 'control characters are stripped');

  const parsed = logged ? JSON.parse(logged.slice('CLIENT-ERROR'.length).trim()) : {};
  eq(parsed.kind, 'error', 'an unknown kind collapses to "error"');
  ok((parsed.message || '').length <= 300, 'the message is truncated to 300 characters');
  ok((parsed.stack || '').length <= 1200, 'the stack is truncated to 1200 characters');
  ok((parsed.route || '').length <= 160, 'the route is truncated to 160 characters');
  ok((parsed.ua || '').length <= 220, 'the user agent is truncated to 220 characters');
  ok((parsed.app || '').length <= 60, 'the app tag is truncated to 60 characters');
  ok(!/[\u0000-\u001f\u007f]/.test(parsed.message || ''), 'the message keeps no control characters');
  ok(/line1 line2/.test(parsed.message || ''), 'collapsed whitespace keeps the text readable');

  // Telegram is optional: with no token the report is logged, the skip is
  // announced once, and the client still gets a 200.
  ok(
    lines.some((line) => /Telegram notification skipped/.test(line)),
    'no Telegram call is attempted without env'
  );
}

// ─── [5] per-IP budget ─────────────────────────────────────────────────────
console.log('\n[5] per-IP budget');
{
  const budgetIp = ip(20);
  const statuses = [];
  await captureConsole(async () => {
    for (let i = 0; i < 30; i += 1) {
      // A unique message each time, so dedupe/alert caps never mask the limiter.
      const res = await call({ body: { ...valid, message: `burst ${i}` }, ip: budgetIp });
      statuses.push(res.status);
    }
  });
  eq(statuses.every((status) => status === 200), true, 'the first 30 reports from one IP are accepted');

  const { result: over } = await captureConsole(() =>
    call({ body: { ...valid, message: 'burst 30' }, ip: budgetIp })
  );
  eq(over.status, 429, 'the 31st report from the same IP → 429');
  eq(over.body.rateLimited, true, 'the 429 is flagged as rate limiting');
  ok(Number(over.headers['retry-after']) > 0, 'the 429 carries Retry-After');

  const { result: otherIp } = await captureConsole(() =>
    call({ body: { ...valid, message: 'different client' }, ip: ip(21) })
  );
  eq(otherIp.status, 200, 'a different IP is not affected');
}

// ─── [6] alert caps ────────────────────────────────────────────────────────
console.log('\n[6] alert throttling');
{
  const { _alertState } = handler;
  ok(_alertState && _alertState.seen instanceof Map, 'the alert state is exposed for the suite');
  ok(_alertState.seen.size <= 200, 'the dedupe map stays bounded');
}

// ─── [7] shared server-side error logging ───────────────────────────────────
console.log('\n[7] safeLogError');
{
  const hostile = Object.assign(
    new Error('customer alice@example.com 01012345678 12 Nile Street'),
    { name: 'Hostile\nError', code: 'X\nY' }
  );
  const { lines } = await captureConsole(() =>
    lib.safeLogError('Order\nlookup failed', hostile, 'detail\nwith text '.repeat(40))
  );
  eq(lines.length, 1, 'safeLogError writes exactly one line');
  const line = lines[0];
  ok(line.startsWith('ZASHM Order lookup failed | Hostile Error | code=X Y | '),
    'fixed label, sanitised error name and bounded error code are logged');
  ok(!/[\n\r\x00-\u001f\u007f]/.test(line), 'the log line has no newline or control characters');
  ok(!line.includes('alice@example.com') && !line.includes('01012345678') &&
     !line.includes('12 Nile Street'), 'the raw message and customer PII are never logged');
  ok(line.length <= 400, 'the detail is bounded to a short suffix');

  const { lines: minimal } = await captureConsole(() =>
    lib.safeLogError('Fixed label', new TypeError('secret detail'))
  );
  eq(minimal, ['ZASHM Fixed label | TypeError'], 'without detail only label and error type are logged');

  eq(typeof lib.safeLogError, 'function', 'safeLogError is exported for every API handler');
  for (const file of [
    'api/_lib.js', 'api/auth.js', 'api/orders.js', 'api/admin/orders.js',
    'api/admin/products.js', 'api/admin/users.js', 'api/admin/upload.js',
  ]) {
    ok(!/console\.(error|warn)\([^\n]*\.message/.test(read(file)),
      `${file} never logs a raw error message`);
  }
}

// ─── [8] deployment budget: one mounted route, not one more function ───────
console.log('\n[8] serverless function budget');
{
  // Vercel Hobby allows 12 Serverless Functions per deployment, and the
  // middleware counts as one. This project is at the cap, so a new endpoint
  // must be mounted on an existing function instead of adding a file.
  const apiDir = path.join(root, 'api');
  const handlers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|mjs)$/.test(entry.name) && !entry.name.startsWith('_')) handlers.push(full);
    }
  };
  walk(apiDir);
  const functions = handlers.length + (existsSync(path.join(root, 'middleware.ts')) ? 1 : 0);
  ok(functions <= 12, `deployment stays within the 12-function cap (${functions})`);

  ok(!existsSync(path.join(apiDir, 'errors.js')), '/api/errors is not its own function');
  ok(existsSync(path.join(apiDir, '_errors.js')), 'the handler lives in an underscore module');

  const vercel = JSON.parse(read('vercel.json'));
  const mount = (vercel.rewrites || []).find((rule) => rule.source === '/api/errors');
  ok(Boolean(mount), 'vercel.json rewrites /api/errors');
  eq(mount && mount.destination, '/api/auth?__zshm_route=errors', 'the rewrite targets the auth function with a marker');

  const authSrc = read('api/auth.js');
  ok(/require\('\.\/_errors'\)/.test(authSrc), 'api/auth.js requires the errors handler');
  ok(/__zshm_route === 'errors'/.test(authSrc), 'api/auth.js recognises the marker');
  ok(
    authSrc.indexOf("__zshm_route === 'errors'") < authSrc.indexOf('requestOriginAllowed(req)'),
    'the mount is handled before any auth logic'
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
