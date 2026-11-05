/**
 * ntfy backup push channel — unit tests.
 *
 *   node scripts/test-ntfy.js
 */
const lib = require('../api/_lib.js');

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}
function ok(value, label) { eq(Boolean(value), true, label); }

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

async function main() {
  // ─── [1] missing topic → skip (no fetch) ──────────────────────────────────
  console.log('\n[1] missing NTFY_TOPIC');
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_TOKEN;
  delete process.env.NTFY_SERVER;
  let fetchCalls = [];
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, text: async () => '' }; };
  const r1 = await lib.sendNtfyNotification({ title: 't', message: 'm', tags: 'a', priority: 4 });
  eq(r1, false, 'returns false when topic is unset');
  eq(fetchCalls.length, 0, 'no fetch is made when topic is unset');

  // ─── [2] HTTP 200 → success ───────────────────────────────────────────────
  console.log('\n[2] HTTP 200');
  process.env.NTFY_TOPIC = 'zashm-test-topic';
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, status: 200, text: async () => '{"event":"message"}' };
  };
  const consoleErrors2 = [];
  console.error = (...args) => consoleErrors2.push(args.join(' '));
  const r2 = await lib.sendNtfyNotification({ title: 'New order ZSH-X — EGP 1,000', message: 'item x1\nCairo · COD', tags: 'shopping_cart,bell', priority: 4 });
  console.error = realConsoleError;
  eq(r2, true, 'returns true on HTTP 200');
  eq(fetchCalls.length, 1, 'one fetch is made');
  ok(fetchCalls[0].url.includes('zashm-test-topic'), 'URL contains the topic');
  eq(fetchCalls[0].opts.method, 'POST', 'uses POST');
  eq(fetchCalls[0].opts.headers['Title'], 'New order ZSH-X — EGP 1,000', 'Title header set');
  eq(fetchCalls[0].opts.headers['Priority'], '4', 'Priority header set');
  eq(fetchCalls[0].opts.headers['Tags'], 'shopping_cart,bell', 'Tags header set');
  eq(fetchCalls[0].opts.headers['Content-Type'], 'text/plain; charset=utf-8', 'Content-Type set');
  eq(fetchCalls[0].opts.body, 'item x1\nCairo · COD', 'body is the message');
  eq(consoleErrors2.length, 0, 'no console.error on 200');

  // ─── [3] HTTP 401 → failure + log ─────────────────────────────────────────
  console.log('\n[3] HTTP 401');
  fetchCalls = [];
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"code":40101,"error":"unauthorized"}' });
  const consoleErrors3 = [];
  console.error = (...args) => consoleErrors3.push(args.join(' '));
  const r3 = await lib.sendNtfyNotification({ title: 't', message: 'm' });
  console.error = realConsoleError;
  eq(r3, false, 'returns false on HTTP 401');
  ok(consoleErrors3.some(e => e.includes('401')), 'logs HTTP status 401');
  ok(consoleErrors3.some(e => e.includes('unauthorized')), 'logs sanitized response body');

  // ─── [4] HTTP 404 → failure + log ─────────────────────────────────────────
  console.log('\n[4] HTTP 404');
  fetchCalls = [];
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '{"error":"topic not found"}' });
  const consoleErrors4 = [];
  console.error = (...args) => consoleErrors4.push(args.join(' '));
  const r4 = await lib.sendNtfyNotification({ title: 't', message: 'm' });
  console.error = realConsoleError;
  eq(r4, false, 'returns false on HTTP 404');
  ok(consoleErrors4.some(e => e.includes('404')), 'logs HTTP status 404');

  // ─── [5] Network failure → failure + log ──────────────────────────────────
  console.log('\n[5] Network failure');
  fetchCalls = [];
  globalThis.fetch = async () => { throw new Error('network down'); };
  const consoleErrors5 = [];
  console.error = (...args) => consoleErrors5.push(args.join(' '));
  const r5 = await lib.sendNtfyNotification({ title: 't', message: 'm' });
  console.error = realConsoleError;
  eq(r5, false, 'returns false on network failure');
  ok(consoleErrors5.some(e => e.includes('network down')), 'logs network error');

  // ─── [6] NTFY_SERVER default + custom ─────────────────────────────────────
  console.log('\n[6] server default/custom');
  delete process.env.NTFY_SERVER;
  fetchCalls = [];
  globalThis.fetch = async (url) => { fetchCalls.push(url); return { ok: true, status: 200, text: async () => '' }; };
  await lib.sendNtfyNotification({ title: 't', message: 'm' });
  ok(fetchCalls[0].startsWith('https://ntfy.sh/'), 'defaults to https://ntfy.sh');
  process.env.NTFY_SERVER = 'https://ntfy.example.com/';
  fetchCalls = [];
  globalThis.fetch = async (url) => { fetchCalls.push(url); return { ok: true, status: 200, text: async () => '' }; };
  await lib.sendNtfyNotification({ title: 't', message: 'm' });
  ok(fetchCalls[0].startsWith('https://ntfy.example.com/'), 'honors NTFY_SERVER override');
  delete process.env.NTFY_SERVER;

  // ─── [7] NTFY_TOKEN adds Authorization header ─────────────────────────────
  console.log('\n[7] token handling');
  process.env.NTFY_TOKEN = 'secret-token-123';
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, text: async () => '' }; };
  await lib.sendNtfyNotification({ title: 't', message: 'm' });
  eq(fetchCalls[0].opts.headers['Authorization'], 'Bearer secret-token-123', 'sends Bearer token when set');
  delete process.env.NTFY_TOKEN;
  fetchCalls = [];
  globalThis.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, text: async () => '' }; };
  await lib.sendNtfyNotification({ title: 't', message: 'm' });
  eq(fetchCalls[0].opts.headers['Authorization'], undefined, 'no Authorization header when token unset');

  // ─── [8] topic value never logged ──────────────────────────────────────────
  console.log('\n[8] no secret leakage');
  process.env.NTFY_TOPIC = 'zashm-secret-topic-xyz';
  fetchCalls = [];
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  const consoleErrors8 = [];
  console.error = (...args) => consoleErrors8.push(args.join(' '));
  await lib.sendNtfyNotification({ title: 't', message: 'm' });
  console.error = realConsoleError;
  const leaked = consoleErrors8.some(e => e.includes('zashm-secret-topic-xyz'));
  eq(leaked, false, 'topic value is never logged on failure');

  // ─── cleanup ──────────────────────────────────────────────────────────────
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_TOKEN;
  delete process.env.NTFY_SERVER;
  globalThis.fetch = realFetch;
  console.error = realConsoleError;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });