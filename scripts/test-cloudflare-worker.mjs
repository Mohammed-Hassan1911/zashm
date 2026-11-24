import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  applySecurityHeaders,
  CSP,
  createVercelReqRes,
  finalizeVercelResponse,
  handleRequest,
  isPrivatePath,
  MAX_BUFFERED_BODY_BYTES,
  normalizePath,
  SECURITY_HEADERS,
  VERCEL_TELEMETRY_SHIMS,
  VercelResponse,
} from '../worker.mjs';

let passed = 0;
let failed = 0;

function report(condition, message, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok - ${message}`);
  } else {
    failed += 1;
    console.log(`NOT OK - ${message}${detail ? ` :: ${detail}` : ''}`);
  }
}

function ok(value, message) {
  report(Boolean(value), message, `got ${String(value)}`);
}

function eq(actual, expected, message) {
  report(actual === expected, message, `got ${String(actual)}, expected ${String(expected)}`);
}

function section(n, title) {
  console.log(`\n[${n}] ${title}`);
}

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const require = createRequire(import.meta.url);
const { readBody, signSession } = require('../api/_lib.js');

section(1, 'wrangler configuration');
const wrangler = await read('wrangler.toml');
ok(wrangler.includes('name = "zashm"'), 'worker keeps the zashm project name');
ok(wrangler.includes('main = "worker.mjs"'), 'entrypoint is worker.mjs');
ok(wrangler.includes('directory = "./build"'), 'static assets come from build/');
ok(wrangler.includes('binding = "ASSETS"'), 'ASSETS binding is declared');
eq(/not_found_handling = "([^"]+)"/.exec(wrangler)?.[1], '404-page', 'unknown routes stay real 404s');
eq(/html_handling = "([^"]+)"/.exec(wrangler)?.[1], 'none', 'no trailing-slash HTML redirects');
eq(/run_worker_first = (true|false)/.exec(wrangler)?.[1], 'true', 'worker sees requests before static assets');
const compatDate = /compatibility_date = "([^"]+)"/.exec(wrangler)?.[1] || '';
ok(compatDate >= '2025-04-01', `modern nodejs_compat date is pinned (${compatDate})`);

section(2, 'static header parity');
const headersFile = await read('public/_headers');
function headerBlock(text, marker) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === marker);
  const block = {};
  if (start < 0) return block;
  for (let i = start + 1; i < lines.length && lines[i].startsWith('  '); i += 1) {
    const line = lines[i].trim();
    const colon = line.indexOf(':');
    if (colon > -1) block[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  return block;
}
const staticHeaders = headerBlock(headersFile, '/*');
const vercelConfig = JSON.parse(await read('vercel.json'));
const vercelWildcard = vercelConfig.headers.find((item) => item.source === '/(.*)' && !item.has);
const vercelHeaders = Object.fromEntries(
  (vercelWildcard ? vercelWildcard.headers : []).map(({ key, value }) => [key, value])
);
for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
  eq(staticHeaders[name], expected, `_headers ${name} matches the Worker byte-for-byte`);
  eq(vercelHeaders[name], expected, `vercel.json ${name} matches the Worker byte-for-byte`);
}
const cspLine = headersFile.split('\n').map((line) => line.trimStart()).find((line) => line.startsWith('Content-Security-Policy:'));
ok(Boolean(cspLine), 'CSP is present in _headers');
ok(!/script-src[^;]*'unsafe-inline'/.test(cspLine || ''), 'script-src has no unsafe-inline');
ok((cspLine || '').includes("frame-ancestors 'none'"), 'frame-ancestors stays none');
for (const route of ['/api/*', '/admin', '/admin/*', '/checkout', '/cart', '/wishlist', '/track']) {
  const block = new RegExp(`\\n${route.replace(/[/*]/g, '\\$&')}\\n([\\s\\S]*?)(?:\\n\\S|$)`);
  ok(block.test(headersFile), `_headers covers ${route}`);
}
ok(headersFile.includes('X-Robots-Tag: noindex, nofollow, noarchive'), 'private routes keep noindex');
ok(headersFile.includes('Cache-Control: public, max-age=31536000, immutable'), 'assets stay immutable-cached');

section(3, 'api route coverage');
const workerSource = await read('worker.mjs');
for (const file of [
  'api/orders.js',
  'api/auth.js',
  'api/sitemap.mjs',
  'api/coupons/validate.js',
  'api/reviews.js',
  'api/admin/products.js',
  'api/admin/orders.js',
  'api/admin/coupons.js',
  'api/admin/users.js',
  'api/admin/reviews.js',
  'api/admin/upload.js',
]) {
  ok(workerSource.includes(file), `worker routes ${file}`);
}
ok(workerSource.includes("__zshm_route: 'errors'"), '/api/errors rewrite is preserved');

section(4, 'Vercel req/res adapter');
const request = new Request('https://zashm.example/api/orders?track=ZSH-1&tk=abc', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-connecting-ip': '197.210.54.7',
    cookie: 'zashm_csrf=csrf-1; zashm_session=sess-1',
    'x-csrf-token': 'csrf-1',
  },
  body: JSON.stringify({ hello: 'world' }),
});
const { req, res } = await createVercelReqRes(request);
eq(req.method, 'POST', 'method is forwarded');
eq(req.query.track, 'ZSH-1', 'query string is forwarded');
eq(req.headers['x-real-ip'], '197.210.54.7', 'trusted Cloudflare IP replaces forwarded chain');
eq(req.socket.remoteAddress, '197.210.54.7', 'socket IP is available to clientIp()');
eq(req.headers.cookie.includes('zashm_csrf'), true, 'cookie header is preserved');
eq(req.headers['x-csrf-token'], 'csrf-1', 'the double-submit CSRF header is preserved');
res.setHeader('Content-Type', 'application/json; charset=utf-8');
eq(res.getHeader('content-type'), 'application/json; charset=utf-8', 'setHeader/getHeader are case-insensitive');
res.setHeader('Set-Cookie', ['a=1; HttpOnly', 'b=2; Secure']);
res.statusCode = 201;
res.end('{"ok":true}');
const finalized = finalizeVercelResponse(res);
eq(finalized.status, 201, 'status code is forwarded');
eq(await finalized.text(), '{"ok":true}', 'body is forwarded');
ok(finalized.headers.getSetCookie().length === 2, 'multiple Set-Cookie values survive');
const emptyRes = new VercelResponse();
emptyRes.statusCode = 204;
emptyRes.end();
eq(finalizeVercelResponse(emptyRes).body, null, '204 has no response body');

const chunks = [];
let ended = false;
await new Promise((resolve) => {
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => { ended = true; resolve(); });
  req.on('error', resolve);
});
eq(JSON.parse(Buffer.concat(chunks).toString('utf8')).hello, 'world', 'readBody-style stream emits JSON bytes');
ok(ended, 'readBody-style stream emits end');

section(5, 'security headers');
eq(normalizePath('/shop/'), '/shop', 'trailing slash is normalized');
eq(normalizePath('/'), '/', 'root stays root');
ok(isPrivatePath('/admin'), '/admin is private');
ok(isPrivatePath('/api'), '/api is private');
ok(isPrivatePath('/api/admin/orders'), '/api subpaths are private');
ok(isPrivatePath('/cart/extra'), '/cart subpaths are private');
ok(isPrivatePath('/', new URL('https://zashm.example/?track=ZSH-1')), 'tracking links are private');
ok(!isPrivatePath('/shop'), 'public shop is not private');
const secured = applySecurityHeaders(new Response('ok'), '/admin', new URL('https://zashm.example/admin'));
eq(secured.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive', 'noindex header is applied by the worker');
for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
  eq(secured.headers.get(name), expected, `worker response ${name} matches the shared source`);
}
const apiNoindex = applySecurityHeaders(new Response('ok'), '/api/orders', new URL('https://zashm.example/api/orders'));
eq(apiNoindex.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive', 'API responses keep noindex on the Worker path');

section(6, 'request routing');
const assets = {
  async fetch() {
    return new Response('<html>zashm</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
const spaResponse = await handleRequest(new Request('https://zashm.example/admin'), { ASSETS: assets });
eq(spaResponse.status, 200, 'SPA route returns 200');
eq(spaResponse.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate', 'index.html is revalidated');
eq(spaResponse.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive', '/admin gets noindex on the Worker path');
const productResponse = await handleRequest(new Request('https://zashm.example/product/123'), { ASSETS: assets });
eq(productResponse.status, 200, 'product deep link returns the SPA');
const apiGuard = await handleRequest(new Request('https://zashm.example/api/sitemap', { method: 'POST' }), {});
eq(apiGuard.status, 405, 'API method guard still runs through the adapter');
eq(apiGuard.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive', 'generated API response gets noindex');
const missing = {
  async fetch() {
    return new Response('<html>404</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
const notFound = await handleRequest(new Request('https://zashm.example/does-not-exist'), { ASSETS: missing });
eq(notFound.status, 404, 'unknown routes remain 404');
ok((notFound.headers.get('Content-Security-Policy') || '').length > 20, '404 responses keep the CSP');

section(7, 'sitemap on a staging Worker origin');
const sitemapEnvNames = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUBLIC_BASE_URL', 'ALLOWED_ORIGINS'];
const oldSitemapEnv = Object.fromEntries(sitemapEnvNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const fetchTargets = [];
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'public-anon-test-key';
process.env.PUBLIC_BASE_URL = 'https://zashm-staging.workers.dev';
process.env.ALLOWED_ORIGINS = 'https://zashm-staging.workers.dev, http://localhost:3000';
globalThis.fetch = async (url) => {
  const target = String(url);
  fetchTargets.push(target);
  if (target.includes('/rest/v1/products_public')) {
    return new Response(JSON.stringify([{ id: 'p1', stock: 2 }]), { status: 200 });
  }
  return new Response('unexpected self-fetch', { status: 500 });
};
const manifestAssets = {
  async fetch(request) {
    if (new URL(request.url).pathname === '/prerendered-products.json') {
      return new Response(JSON.stringify({ ids: ['p1'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('missing', { status: 404 });
  },
};
let sitemapResponse;
try {
  sitemapResponse = await handleRequest(
    new Request('https://zashm-staging.workers.dev/sitemap.xml'),
    { ASSETS: manifestAssets }
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const name of sitemapEnvNames) {
    if (oldSitemapEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldSitemapEnv[name];
  }
}
const sitemapBody = await sitemapResponse.text();
eq(sitemapResponse.status, 200, 'Worker sitemap returns 200');
ok(sitemapBody.includes('<loc>https://zashm-staging.workers.dev/product/p1</loc>'),
  'an approved staging origin yields real product URLs');
ok(!sitemapBody.includes('za-shm.vercel.app'), 'sitemap stops pointing at the retired Vercel origin');
ok(fetchTargets.length === 1 && fetchTargets[0].includes('/rest/v1/products_public'),
  'manifest is read from local assets, not a self-fetch');

const bindingNames = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUBLIC_BASE_URL', 'ALLOWED_ORIGINS'];
const oldBindings = Object.fromEntries(bindingNames.map((name) => [name, process.env[name]]));
for (const name of bindingNames) delete process.env[name];
globalThis.fetch = async (url) => {
  if (String(url).includes('/rest/v1/products_public')) {
    return new Response(JSON.stringify([{ id: 'p1', stock: 2 }]), { status: 200 });
  }
  return new Response('unexpected self-fetch', { status: 500 });
};
let bindingResponse;
try {
  bindingResponse = await handleRequest(
    new Request('https://zashm-staging.workers.dev/sitemap.xml'),
    {
      ASSETS: manifestAssets,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_ANON_KEY: 'public-anon-test-key',
      PUBLIC_BASE_URL: 'https://zashm-staging.workers.dev',
      ALLOWED_ORIGINS: 'https://zashm-staging.workers.dev',
    }
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const name of bindingNames) {
    if (oldBindings[name] === undefined) delete process.env[name];
    else process.env[name] = oldBindings[name];
  }
}
ok((await bindingResponse.text()).includes('<loc>https://zashm-staging.workers.dev/product/p1</loc>'),
  'Worker bindings reach handlers that read process.env');

section(8, 'bounded body handling');
const shimReq = (await createVercelReqRes(
  new Request('https://zashm.example/api/orders', { method: 'POST', body: '{}' })
)).req;
ok(['resume', 'pause', 'destroy'].every((name) => typeof shimReq[name] === 'function'),
  'stream control methods required by readBody() exist');
let arrayBufferCalls = 0;
const oversizedRequest = {
  url: 'https://zashm.example/api/orders',
  method: 'POST',
  headers: new Map([['content-length', String(MAX_BUFFERED_BODY_BYTES + 1)]]),
  async arrayBuffer() {
    arrayBufferCalls += 1;
    return new ArrayBuffer(2);
  },
};
const { req: bigReq } = await createVercelReqRes(oversizedRequest);
let seenLength = 0;
let forwarded = null;
bigReq.on('data', (chunk) => { seenLength = chunk.length; bigReq.resume(); });
bigReq.on('end', () => {});
bigReq.on('error', (error) => { forwarded = error; });
bigReq.resume = () => { throw new Error('resume failed'); };
await new Promise((resolve) => queueMicrotask(resolve));
eq(arrayBufferCalls, 0, 'a declared oversized body is never buffered');
ok(seenLength > MAX_BUFFERED_BODY_BYTES, 'readBody-style guard sees the oversized length');
eq(forwarded && forwarded.message, 'resume failed', 'a throwing stream callback is forwarded, not left uncaught');

const brokenRequest = {
  url: 'https://zashm.example/api/orders',
  method: 'POST',
  headers: new Map(),
  async arrayBuffer() { throw new Error('stream failed'); },
};
const { req: brokenReq } = await createVercelReqRes(brokenRequest);
let bodyFailure = null;
await new Promise((resolve) => {
  brokenReq.on('data', () => {});
  brokenReq.on('end', resolve);
  brokenReq.on('error', (error) => { bodyFailure = error; resolve(); });
});
eq(bodyFailure && bodyFailure.message, 'stream failed', 'body stream errors reach readBody() instead of escaping');

section(9, 'Vercel-only telemetry on Cloudflare');
const shimPath = '/_vercel/speed-insights/script.js';
ok(VERCEL_TELEMETRY_SHIMS.has(shimPath), 'the Vercel Speed Insights path is shimmed');
const noAssets = {
  ASSETS: {
    fetch() { throw new Error('telemetry shim must not touch ASSETS'); },
  },
};
const shimResponse = await handleRequest(
  new Request(`https://zashm-staging.workers.dev${shimPath}`),
  noAssets
);
eq(shimResponse.status, 200, 'shim avoids the 404 console error');
eq(shimResponse.headers.get('content-type'), 'application/javascript; charset=utf-8', 'shim is executable JS');
eq(shimResponse.headers.get('cache-control'), 'no-store', 'shim is never cached');
eq(shimResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive', 'shim is noindexed');
eq(shimResponse.headers.get('content-security-policy'), CSP, 'shim keeps the full CSP');
ok(!/window\.si|vitals|sendBeacon/.test(await shimResponse.text()), 'shim sends no vitals');
const notFoundAssets = {
  fetch: async () => new Response('not found', { status: 404 }),
};
const unknownTelemetry = await handleRequest(
  new Request('https://zashm-staging.workers.dev/_vercel/analytics/script.js'),
  { ASSETS: notFoundAssets }
);
eq(unknownTelemetry.status, 404, 'unrecognised Vercel paths still reach the static 404 handler');

section(10, 'crawler product 404 parity');
function snapshotEnv(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}
function restoreEnv(old) {
  for (const [name, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
const envNames = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'REACT_APP_SUPABASE_URL',
  'REACT_APP_SUPABASE_ANON_KEY', 'PUBLIC_BASE_URL', 'ALLOWED_ORIGINS',
];
const crawlerEnvBackup = snapshotEnv(envNames);
const fetchBeforeCrawler = globalThis.fetch;
let lookups = 0;
let lookupRows = [];
const crawlerAssets = {
  async fetch(input) {
    const target = String(input && input.url ? input.url : input);
    if (target.includes('/404.html')) {
      return new Response('<html>shipped 404</html>', { status: 200 });
    }
    return new Response('<html>spa shell</html>', { status: 200 });
  },
};
const crawlerBindings = {
  ASSETS: crawlerAssets,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'public-anon-test-key',
};
try {
  globalThis.fetch = async () => {
    lookups += 1;
    return new Response(JSON.stringify(lookupRows), { status: 200 });
  };
  const missing = await handleRequest(
    new Request('https://zashm-staging.workers.dev/product/999999999', {
      headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
    }),
    crawlerBindings
  );
  eq(missing.status, 404, 'Googlebot gets a real 404 for an unknown product id');
  eq(await missing.text(), '<html>shipped 404</html>', 'the shipped 404.html is reused');
  ok((missing.headers.get('x-robots-tag') || '').includes('noindex'),
    'the crawler 404 is noindexed');
  eq(lookups, 1, 'one public-view existence lookup is made');

  lookups = 0;
  const shopper = await handleRequest(
    new Request('https://zashm-staging.workers.dev/product/999999999', {
      headers: { 'user-agent': 'Mozilla/5.0' },
    }),
    crawlerBindings
  );
  eq(shopper.status, 200, 'shoppers keep the instant SPA shell');
  eq(lookups, 0, 'shoppers pay no database round trip');

  lookupRows = [{ id: '999999999' }];
  const existing = await handleRequest(
    new Request('https://zashm-staging.workers.dev/product/999999999', {
      headers: { 'user-agent': 'Bingbot' },
    }),
    crawlerBindings
  );
  eq(existing.status, 200, 'an existing product keeps its 200 for crawlers');
} finally {
  globalThis.fetch = fetchBeforeCrawler;
  restoreEnv(crawlerEnvBackup);
}

section(11, 'bounded streaming body');
let megabytesRead = 0;
const hugeBody = new ReadableStream({
  pull(controller) {
    if (megabytesRead >= 9) {
      controller.close();
      return;
    }
    megabytesRead += 1;
    controller.enqueue(new Uint8Array(1024 * 1024));
  },
});
let streamReaderCalls = 0;
const nativeHugeReader = hugeBody.getReader.bind(hugeBody);
hugeBody.getReader = () => {
  streamReaderCalls += 1;
  return nativeHugeReader();
};
const streamingRequest = {
  url: 'https://zashm.example/api/orders',
  method: 'POST',
  headers: new Map([['content-length', '2']]),
  body: hugeBody,
  async arrayBuffer() { throw new Error('arrayBuffer must not be used for a stream'); },
};
const { req: streamReq } = await createVercelReqRes(streamingRequest);
eq(streamReaderCalls, 0, 'no body is read before readBody() asks for data');
let streamError = null;
await new Promise((resolve) => {
  streamReq.on('data', () => {});
  streamReq.on('end', resolve);
  streamReq.on('error', (error) => { streamError = error; resolve(); });
});
eq(streamError && streamError.status, 413, 'an understated Content-Length still yields 413');
ok(megabytesRead <= 9 && megabytesRead > 8,
  `the reader stops at the cap plus one chunk (${megabytesRead} MiB)`);

let guardedReaderCalls = 0;
const guardedStream = new ReadableStream({ start(controller) { controller.close(); } });
const nativeGetReader = guardedStream.getReader.bind(guardedStream);
guardedStream.getReader = () => {
  guardedReaderCalls += 1;
  return nativeGetReader();
};
const guardedResponse = await handleRequest(
  new Request('https://zashm-staging.workers.dev/api/sitemap', {
    method: 'POST',
    body: guardedStream,
    duplex: 'half',
  }),
  {}
);
eq(guardedResponse.status, 405, 'a method-guarded POST is rejected by the handler');
eq(guardedReaderCalls, 0, 'a rejected route never touches the body stream');

let routeChunksRead = 0;
let routeCancels = 0;
const routeStream = new ReadableStream({
  pull(controller) {
    if (routeChunksRead >= 7) {
      controller.close();
      return;
    }
    routeChunksRead += 1;
    controller.enqueue(new Uint8Array(1024 * 1024));
  },
});
const nativeRouteReader = routeStream.getReader.bind(routeStream);
routeStream.getReader = () => {
  const reader = nativeRouteReader();
  const nativeCancel = reader.cancel.bind(reader);
  reader.cancel = async (...args) => {
    routeCancels += 1;
    return nativeCancel(...args);
  };
  return reader;
};
const { req: routeReq } = await createVercelReqRes({
  url: 'https://zashm.example/api/coupons/validate',
  method: 'POST',
  headers: new Map([
    ['content-type', 'application/json'],
    ['content-length', '2'],
  ]),
  body: routeStream,
  async arrayBuffer() { throw new Error('arrayBuffer must not be used for a stream'); },
});
let routeError = null;
try {
  await readBody(routeReq, 4 * 1024);
} catch (error) {
  routeError = error;
}
eq(routeError && routeError.status, 413, 'a small route cap rejects a lying stream with 413');
ok(routeChunksRead <= 2,
  `the stream stops within one buffered chunk of the route cap (${routeChunksRead} read)`);
eq(routeCancels, 1, 'the underlying reader is cancelled when the route rejects');

section(12, 'origin and CSRF gates through the Worker');
const gateBackup = snapshotEnv(['ALLOWED_ORIGINS', 'SESSION_SECRET']);
const gateEnv = { ALLOWED_ORIGINS: 'https://zashm-staging.workers.dev' };
process.env.SESSION_SECRET = 'worker-test-session-secret';
const signedSession = signSession({ id: 'u1', role: 'admin', name: 'Test', email: 'test@example.invalid' });
const sessionCookie = `zashm_session=${encodeURIComponent(signedSession)}; zashm_csrf=csrf-ok`;
try {
  const preflight = await handleRequest(
    new Request('https://zashm-staging.workers.dev/api/orders', {
      method: 'OPTIONS',
      headers: { origin: 'https://zashm-staging.workers.dev' },
    }),
    gateEnv
  );
  eq(preflight.status, 204, 'an allowed preflight returns 204');
  eq(preflight.headers.get('access-control-allow-origin'), 'https://zashm-staging.workers.dev',
    'the allow-listed Origin is reflected');
  eq(preflight.headers.get('access-control-allow-credentials'), 'true', 'credentials stay allowed');
  ok((preflight.headers.get('vary') || '').includes('Origin'), 'the preflight varies on Origin');
  ok((preflight.headers.get('x-robots-tag') || '').includes('noindex'), 'API preflights stay noindexed');

  const foreign = await handleRequest(
    new Request('https://zashm-staging.workers.dev/api/orders', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    }),
    gateEnv
  );
  eq(foreign.status, 403, 'a foreign Origin is rejected before any handler work');

  const anonymous = await handleRequest(
    new Request('https://zashm-staging.workers.dev/api/admin/products', {
      method: 'POST',
      headers: {
        origin: 'https://zashm-staging.workers.dev',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
    gateEnv
  );
  eq(anonymous.status, 401, 'admin mutations without a session return 401');

  const adminPost = (csrf) => new Request('https://zashm-staging.workers.dev/api/admin/products', {
    method: 'POST',
    headers: {
      origin: 'https://zashm-staging.workers.dev',
      'content-type': 'application/json',
      cookie: sessionCookie,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: '{}',
  });
  const badCsrf = await handleRequest(adminPost('wrong'), gateEnv);
  eq(badCsrf.status, 403, 'a signed session with the wrong CSRF token is rejected');
  ok((await badCsrf.text()).includes('CSRF validation failed'),
    'the failure is specifically the CSRF check');

  const oldSessionLog = console.error;
  console.error = () => {};
  let goodCsrf;
  try {
    goodCsrf = await handleRequest(adminPost('csrf-ok'), gateEnv);
  } finally {
    console.error = oldSessionLog;
  }
  const goodBody = await goodCsrf.text();
  ok(goodCsrf.status !== 403 || !goodBody.includes('CSRF validation failed'),
    'a matching CSRF token passes the double-submit check');
} finally {
  restoreEnv(gateBackup);
}

section(13, 'Set-Cookie survives the final response rewrite');
const cookieResponse = new Response('ok', { status: 200 });
cookieResponse.headers.append(
  'Set-Cookie',
  'zashm_session=abc; HttpOnly; Secure; SameSite=Strict; Path=/'
);
cookieResponse.headers.append('Set-Cookie', 'zashm_csrf=def; Path=/');
const rewrittenCookies = applySecurityHeaders(
  cookieResponse,
  '/api/auth',
  new URL('https://zashm-staging.workers.dev/api/auth')
);
const cookies = typeof rewrittenCookies.headers.getSetCookie === 'function'
  ? rewrittenCookies.headers.getSetCookie()
  : [rewrittenCookies.headers.get('set-cookie')];
eq(cookies.length, 2, 'both cookies survive applySecurityHeaders');
ok(cookies.some((value) => /zashm_session=/.test(value) && /HttpOnly/i.test(value)),
  'the session cookie stays HttpOnly');
ok(cookies.some((value) => /zashm_csrf=/.test(value) && !/HttpOnly/i.test(value)),
  'the CSRF cookie stays readable by JavaScript');

section(14, 'asset binding failures keep the security contract');
const brokenAssets = {
  fetch() { throw new Error('binding unavailable'); },
};
const oldConsoleError = console.error;
console.error = () => {};
try {
  for (const [route, privateRoute] of [['/admin', true], ['/shop', false]]) {
    const failed = await handleRequest(
      new Request(`https://zashm-staging.workers.dev${route}`),
      { ASSETS: brokenAssets }
    );
    eq(failed.status, 500, `a broken ASSETS binding yields 500 for ${route}`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      eq(failed.headers.get(name), value, `${route} 500 keeps ${name}`);
    }
    eq((failed.headers.get('x-robots-tag') || '').includes('noindex'), privateRoute,
      `${route} 500 keeps the correct indexing policy`);
  }
} finally {
  console.error = oldConsoleError;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
