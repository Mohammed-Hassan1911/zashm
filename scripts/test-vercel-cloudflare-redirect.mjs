/**
 * Read-only verification for the Vercel -> Cloudflare 307 redirect.
 *
 *   node scripts/test-vercel-cloudflare-redirect.mjs --preflight
 *   node scripts/test-vercel-cloudflare-redirect.mjs --expect-redirect
 *
 * `--preflight` checks the live baseline before a Vercel change. It never
 * expects a redirect. `--expect-redirect` is the suite for AFTER the
 * owner-approved Production deploy. Exactly one mode flag is required, so a
 * bare invocation fails loudly instead of silently choosing the wrong mode.
 *
 * Nothing here deploys, sets aliases, edits dashboard settings or creates an
 * order. The only POST target is the bounded /api/errors handler, and the only
 * tracking requests use a deliberately invalid token.
 *
 * Only `za-shm.vercel.app` is a public customer entry point. The two other
 * production aliases were already behind Vercel SSO before the redirect, so
 * their SSO gate is asserted separately; they are not counted as redirect
 * passes while they still point at the original deployment.
 */
import assert from 'node:assert/strict';

const CF = process.env.ZSHM_CLOUDFLARE_ORIGIN || 'https://zashm.za-shm.workers.dev';
const VC = process.env.ZSHM_LEGACY_ORIGIN || 'https://za-shm.vercel.app';
const MODES = ['--preflight', '--expect-redirect'];
const args = process.argv.slice(2);
const mode = args.length === 1 && MODES.includes(args[0]) ? args[0] : null;

if (!mode) {
  console.error('Usage: node scripts/test-vercel-cloudflare-redirect.mjs ' +
    '[--preflight | --expect-redirect]');
  process.exit(2);
}

const EXPECT_REDIRECT = mode === '--expect-redirect';
const PREFLIGHT = !EXPECT_REDIRECT;

// Inventory from `vercel alias list --limit 100` on 2026-11-25.
const PUBLIC_ALIAS = 'za-shm.vercel.app';
const SSO_ALIASES = [
  'zashm-zashm.vercel.app',
  'zashm-git-main-zashm.vercel.app',
];
const PREVIEW_ALIASES = [
  'zashm-git-cloudflare-migration-zashm.vercel.app',
  'zashm-git-preview-stillform-redesign-zashm.vercel.app',
];
const TRACK_PATH = '/track?track=ZSH-PREFLIGHT-00000000&tk=invalid';
const TRACK_API = '/api/orders?track=ZSH-PREFLIGHT-00000000&tk=invalid';
const PAGES = [
  '/',
  '/?probe=123',
  '/shop?sort=newest',
  '/product/1?utm=preflight',
  '/cart?x=1',
  '/checkout',
  TRACK_PATH,
  '/admin',
];

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name} — ${error && error.message ? error.message : error}`);
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    redirect: options.redirect || 'manual',
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {
    status: response.status,
    location: response.headers.get('location'),
    allowOrigin: response.headers.get('access-control-allow-origin'),
    robots: response.headers.get('x-robots-tag'),
    text,
    json,
    finalUrl: response.url,
  };
}

console.log(PREFLIGHT
  ? 'Vercel → Cloudflare redirect: PREFLIGHT (redirect assertions skipped)'
  : 'Vercel → Cloudflare redirect: FULL (307 assertions enabled)');

console.log('\n[1] inventory is production-only');
await check('one public alias, two SSO-gated aliases, no preview alias among them', () => {
  assert.equal(SSO_ALIASES.length, 2);
  for (const host of [...SSO_ALIASES, ...PREVIEW_ALIASES]) {
    assert.ok(host !== PUBLIC_ALIAS, `${host} must not be the public alias`);
  }
});

console.log('\n[2] Cloudflare baseline (both modes)');
await check('canonical storefront is live and noindex', async () => {
  const r = await request(`${CF}/`);
  assert.equal(r.status, 200);
  assert.match(r.robots || '', /noindex/);
  assert.match(r.text, /name="robots" content="noindex, nofollow, noarchive"/);
});
await check('signed tracking page renders with noindex and no leaked order data', async () => {
  const r = await request(`${CF}${TRACK_PATH}`);
  assert.equal(r.status, 200);
  assert.match(r.robots || '', /noindex/);
  assert.ok(!r.text.includes('E2E Customer'));
});
await check('invalid tracking token returns found:false without PII', async () => {
  const r = await request(`${CF}${TRACK_API}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { found: false });
});

console.log('\n[3] POST / OPTIONS / CORS from the old Vercel Origin are fail-closed');
await check('OPTIONS from za-shm.vercel.app gets no CORS grant', async () => {
  const r = await request(`${CF}/api/orders`, {
    method: 'OPTIONS',
    headers: {
      Origin: VC,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(r.status, 204);
  assert.equal(r.allowOrigin, null);
});
await check('OPTIONS from the Cloudflare origin gets the exact CORS grant', async () => {
  const r = await request(`${CF}/api/orders`, {
    method: 'OPTIONS',
    headers: {
      Origin: CF,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(r.status, 204);
  assert.equal(r.allowOrigin, CF);
});
await check('POST /api/errors from the old origin is rejected before any handler', async () => {
  const r = await request(`${CF}/api/errors`, {
    method: 'POST',
    headers: { Origin: VC, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 403);
  assert.equal(r.json && r.json.error, 'Request origin is not allowed');
});
await check('POST /api/errors from Cloudflare reaches the bounded handler, no order', async () => {
  const r = await request(`${CF}/api/errors`, {
    method: 'POST',
    headers: { Origin: CF, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 400);
  assert.equal(r.json && r.json.error, 'Invalid report');
});

console.log('\n[4] Preview Deployments stay protected and are never redirected');
for (const host of PREVIEW_ALIASES) {
  await check(`${host} is not a public storefront`, async () => {
    const r = await request(`https://${host}/`);
    assert.ok(r.status === 302 || r.status === 401,
      `expected SSO/protection response, got ${r.status}`);
    assert.ok((r.location || '').includes('vercel.com/sso-api') ||
              (r.location || '').includes('/login'),
      'expected the Vercel SSO challenge');
    assert.ok(!(r.location || '').startsWith(CF), 'preview must not be redirected');
  });
}

if (PREFLIGHT) {
  console.log('\n[5] Vercel baseline (before deploy: no redirect expected)');
  await check('za-shm.vercel.app still serves the public storefront', async () => {
    const r = await request(`${VC}/`);
    assert.equal(r.status, 200);
    assert.notEqual(r.status, 307);
  });
  await check('the Vercel tracking URL still works with track and tk', async () => {
    const r = await request(`${VC}${TRACK_PATH}`);
    assert.equal(r.status, 200);
    assert.match(r.robots || '', /noindex/);
  });
  console.log('\nRedirect assertions are intentionally skipped in PREFLIGHT mode.');
} else {
  console.log('\n[5] 307 redirects preserve path and query on the public alias');
  for (const path of PAGES) {
    await check(`${PUBLIC_ALIAS}${path} → Cloudflare with the same path/query`, async () => {
      const first = await request(`https://${PUBLIC_ALIAS}${path}`);
      assert.equal(first.status, 307);
      assert.equal(first.location, `${CF}${path}`);
      const final = await request(first.location);
      assert.equal(final.status, 200);
      assert.ok(final.finalUrl.startsWith(CF));
      if (path.startsWith('/track')) {
        assert.match(final.robots || '', /noindex/);
      }
    });
  }

  console.log('\n[6] SSO-gated production aliases are unchanged, not redirect passes');
  for (const host of SSO_ALIASES) {
    await check(`${host} still challenges with Vercel SSO`, async () => {
      const r = await request(`https://${host}/`);
      assert.ok(r.status === 302 || r.status === 401,
        `expected SSO/protection response, got ${r.status}`);
      assert.ok((r.location || '').includes('vercel.com/sso-api') ||
                (r.location || '').includes('/login'),
        'expected the Vercel SSO challenge');
      assert.ok(!(r.location || '').startsWith(CF), 'SSO alias must not be redirected');
    });
  }

  console.log('\n[7] POST follows the 307 without creating an order');
  await check('POST /api/errors keeps its method/body across the 307 and stays fail-closed', async () => {
    const first = await request(`${VC}/api/errors`, {
      method: 'POST',
      headers: { Origin: VC, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(first.status, 307);
    assert.equal(first.location, `${CF}/api/errors`);
    // A real browser keeps the document Origin across the redirect. Do not
    // rewrite it to Cloudflare: the old Origin must stay denied. A Cloudflare-
    // Origin POST is already proven to reach the bounded handler in section [3].
    const final = await request(first.location, {
      method: 'POST',
      headers: { Origin: VC, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(final.status, 403);
    assert.equal(final.json && final.json.error, 'Request origin is not allowed');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
