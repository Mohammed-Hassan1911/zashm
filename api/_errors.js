'use strict';

/**
 * POST /api/errors — client error reports.
 *
 * Mounted through `api/auth.js` (see the rewrite in vercel.json) rather than as
 * its own Serverless Function: the Hobby plan caps a deployment at 12 functions
 * and this project is at the cap (12 handlers + middleware). The leading
 * underscore keeps Vercel from turning this file into a function of its own.
 *
 * The storefront has no error tracking service and no dependency budget for
 * one, so this endpoint is the smallest useful thing that fits the existing
 * infrastructure: a rate-limited, size-capped report that (a) appears in the
 * Vercel function logs with a stable prefix and (b) raises one Telegram alert
 * per distinct error, using the same bot that already carries orders.
 *
 * What it deliberately does NOT do:
 *   - store anything in Postgres (no table, no migration, no PII retention)
 *   - echo the payload back (a report is never reflected into a response)
 *   - accept unbounded text, HTML, or nested objects
 *   - log cookies, headers or the client IP
 *
 * Abuse handling: a report is cheap, so the per-IP budget is generous (30 per
 * 10 minutes) and the alert channel is capped twice over — 6 alerts per warm
 * instance per hour and one alert per identical message per 30 minutes.
 */

const {
  json,
  applyCors,
  handleOptions,
  readBody,
  clientIp,
  rateLimitShared,
  tooMany,
  sendTelegramNotification,
} = require('./_lib');

const MAX_MESSAGE = 300;
const MAX_STACK = 1200;
const MAX_ROUTE = 160;
const MAX_UA = 220;
const MAX_APP = 60;
const KINDS = new Set(['error', 'unhandledrejection', 'react', 'boundary']);

// Control characters would let a report forge extra lines in the log/alert.
// Collapsing whitespace keeps one report on one line.
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// A fingerprint is what stops one broken button from becoming 400 alerts.
function fingerprint(report) {
  return `${report.kind}|${report.route}|${report.message}`.slice(0, 220);
}

const alertState = { windowStart: 0, sent: 0, seen: new Map() };
const ALERT_WINDOW_MS = 60 * 60 * 1000;
const ALERT_MAX_PER_WINDOW = 6;
const ALERT_DEDUPE_MS = 30 * 60 * 1000;

function shouldAlert(report, now) {
  if (now - alertState.windowStart > ALERT_WINDOW_MS) {
    alertState.windowStart = now;
    alertState.sent = 0;
  }
  if (alertState.sent >= ALERT_MAX_PER_WINDOW) return false;

  const key = fingerprint(report);
  const last = alertState.seen.get(key);
  if (last && now - last < ALERT_DEDUPE_MS) return false;

  // Bounded map: a hostile client cannot grow it without limit.
  if (alertState.seen.size > 200) {
    for (const [k, at] of alertState.seen) {
      if (now - at >= ALERT_DEDUPE_MS) alertState.seen.delete(k);
    }
    if (alertState.seen.size > 200) alertState.seen.clear();
  }

  alertState.seen.set(key, now);
  alertState.sent += 1;
  return true;
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const ip = clientIp(req);
  const limit = await rateLimitShared(`errors:${ip}`, 30, 10 * 60 * 1000);
  if (!limit.allowed) return tooMany(res, limit.resetIn);

  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (e) {
    return json(res, e.status || 400, { error: 'Invalid report' });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { error: 'Invalid report' });
  }

  const message = clean(body.message, MAX_MESSAGE);
  if (!message) return json(res, 400, { error: 'Invalid report' });

  const report = {
    kind: KINDS.has(body.kind) ? body.kind : 'error',
    message,
    route: clean(body.route, MAX_ROUTE) || '/',
    stack: clean(body.stack, MAX_STACK),
    app: clean(body.app, MAX_APP),
    userAgent: clean(body.userAgent, MAX_UA),
    at: new Date().toISOString(),
  };

  // One stable, greppable line in the Vercel logs.
  console.error(
    'CLIENT-ERROR',
    JSON.stringify({
      kind: report.kind,
      route: report.route,
      app: report.app,
      message: report.message,
      stack: report.stack,
      ua: report.userAgent,
      at: report.at,
    })
  );

  if (shouldAlert(report, Date.now())) {
    // Fire and forget: a slow Telegram API must never delay the 200.
    sendTelegramNotification(
      [
        '⚠️ Client error',
        `route: ${report.route}`,
        `kind: ${report.kind}${report.app ? ` · ${report.app}` : ''}`,
        `message: ${report.message}`,
        report.stack ? `stack: ${report.stack.slice(0, 600)}` : '',
        report.userAgent ? `device: ${report.userAgent}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      { timeoutMs: 4000 }
    ).catch(() => {});
  }

  return json(res, 200, { ok: true });
}

module.exports = handler;
// Exposed for the regression suite only; the HTTP contract is unchanged.
module.exports.clean = clean;
module.exports.fingerprint = fingerprint;
module.exports._alertState = alertState;
