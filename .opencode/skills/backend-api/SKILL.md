---
name: Backend API
description: Use when adding or changing ZASHM Vercel serverless routes, authentication/sessions, validation, rate limiting, error contracts, Telegram notifications, or Supabase service-role access in api/.
---

# ZASHM Backend API

## Mission

Keep every `/api/*` route authenticated, rate-limited, validated, and
non-leaking. The API is the only trusted boundary between the browser and
Supabase's service-role key.

## Runtime facts

- Vercel serverless CommonJS handlers: `module.exports = async function handler(req, res)`.
- Shared helpers: `api/_lib.js` (no framework, no Express).
- Routes:
  - `api/auth.js` — login/logout/session (cookie session + CSRF)
  - `api/orders.js` — guest checkout, tracking
  - `api/coupons/validate.js` — public advisory coupon check
  - `api/admin/products.js`, `orders.js`, `coupons.js`, `users.js`, `upload.js`
- `vercel.json` rewrites SPA routes and adds security headers + `noindex` for
  `/api`, `/admin`, `/cart`, `/checkout`, `/wishlist`, `/track`.
- Secrets: `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `TELEGRAM_*`,
  `UPSTASH_*`; public: `SUPABASE_URL`, anon key.

## Handler skeleton (follow it exactly)

```js
'use strict';

const {
  json, applyCors, handleOptions, readBody, clientIp,
  rateLimitShared, tooMany, requirePerm, supabaseAdmin, cleanText,
} = require('../_lib');

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const session = await requirePerm(req, res, 'products.write');
  if (!session) return; // requirePerm already sent 401/403

  const check = await rateLimitShared(`route:${clientIp(req)}`, 30, 60_000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  let body;
  try { body = await readBody(req, 1024 * 1024); }
  catch (e) { return json(res, 400, { error: 'Invalid request body' }); }

  // validate → call service role → return a minimal shape
};
```

## Auth and permissions

- `requirePerm(req, res, permission)` is the only authorization gate. It:
  - reads an HttpOnly session cookie (preferred) or a legacy Bearer token;
  - for cookie-authenticated unsafe methods enforces Origin allow-list +
    double-submit CSRF (`X-CSRF-Token` vs `zashm_csrf`);
  - re-reads the user row and `session_version` on every call (role changes and
    revocation are immediate);
  - uses the **DB role**, not the role baked into the token.
- Permissions: `admin: ['*']`; `manager`: products/orders/discounts read+write,
  analytics/dashboard read; `support`: orders/dashboard read.
- Never trust a client-supplied role, user id, price, total, discount, or status.
- Guest checkout is intentional: `/api/orders` does not require a session, but it
  validates stock/coupon/totals server-side.

## Response and error contract

- Always `json(res, status, body)`; it sets `Cache-Control: no-store`.
- Errors are safe, stable strings: `{ error: 'Forbidden' }`,
  `{ error: 'Authentication required' }`, validation `{ errors: [...] }`.
- Never echo raw Supabase/driver messages (they can contain row values). Log only
  an error code or a generic action label.
- Status mapping used by the app:
  - `400` validation / malformed JSON
  - `401` missing/expired session
  - `403` permission, origin, or CSRF failure
  - `404` missing resource
  - `409` conflict (duplicate, `status_changed`, `missing_variant`,
    `unavailable`, `coupon_in_use`, idempotency conflict)
  - `429` rate limited (include `Retry-After` via `tooMany`)
  - `500` unexpected failure with a generic message
- Admin lifecycle endpoints return `{ ok, warnings, partial, stockRestored }`
  where applicable; preserve those fields — the UI displays them.

## Validation rules

- Use the shared helpers in `_lib.js`: `str`, `cleanText`, `intInRange`,
  `numInRange`, `isHttpsUrl`, `EMAIL_RE`, `EGYPT_PHONE_RE`, `COUPON_CODE_RE`,
  `ORDER_STATUSES`, `validate*Payload`.
- Bound every input (length, count, numeric range). Strip `<`/`>` where the
  existing validators do. Reject unknown/extra privileged fields by whitelisting.
- Phone: Egyptian mobile `^01[0125][0-9]{8}$`.
- Coupon code: `^[A-Za-z0-9_-]{3,30}$`, uppercase before comparison.
- Images: HTTPS only, max 6 per product in the admin payload; uploads are sniffed
  by magic bytes (`detectImageType`), max ~3 MB decoded.
- Body size: `readBody(req, maxBytes)`; uploads use ~4 MB because base64 expands.

## Rate limiting

- Prefer `rateLimitShared(key, max, windowMs)`; it uses Upstash when configured
  and falls back to per-instance memory (log the fallback once, never silently
  claim durability).
- Key by a stable identity: `clientIp(req)` for anonymous traffic, and include
  the route/coupon code for targeted lockouts.
- Use `rateLimitPeekShared`/`resetRateLimitShared` for progressive lockouts
  (coupon guessing) instead of inventing a second counter.
- Return `tooMany(res, resetIn)` so the client gets `Retry-After`.

## Database access

- Always `supabaseAdmin()` (service role); never the anon client.
- Select explicit columns, not `*`, for public responses (e.g. coupon validation
  returns only code/type/value constraints).
- Writes that must be atomic belong in a SQL RPC (`atomic_place_order`,
  `atomic_set_order_status`, `atomic_delete_order`), not multiple JS calls.
- Treat `error.code === '23503'` as a conflict where a DB guard exists
  (`coupon_in_use`); map known RPC reasons to 409, unknown reasons to a generic
  500 after logging the code.
- For uploads, sanitize paths (`sanitizeStoragePath`) and clean unreferenced
  images after product updates (`cleanupUnreferencedProductImages`).

## Side effects

- Telegram notifications use `sendTelegramNotification` +
  `buildOrderTelegramMessage`; the message builder escapes/sanitises user input.
  Notification failure must never fail the order.
- Tracking URLs use HMAC tokens (`trackToken`/`verifyTrackToken`); optional
  `TRACKING_TOKEN_TTL_HOURS` switches to expiring versioned tokens. Rotating
  `SESSION_SECRET` invalidates all links.
- Do not send secrets or full order PII in logs.

## Adding a route checklist

- [ ] Correct method guard + CORS/OPTIONS.
- [ ] `requirePerm` with the least-privilege permission.
- [ ] Shared rate limit with a meaningful key.
- [ ] Body size + schema validation; no mass assignment.
- [ ] Service-role query with explicit columns and `.maybeSingle()` where a row
      may be absent.
- [ ] Safe status/error mapping; no driver text leaked.
- [ ] Atomicity delegated to SQL when multiple rows/stock/coupon change.
- [ ] Tests added in the relevant `scripts/test-*.mjs` (static + behaviour).
- [ ] `vercel.json` headers/rewrites still correct if the path is new.
