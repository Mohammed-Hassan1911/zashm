'use strict';

const {
  json,
  applyCors,
  handleOptions,
  clientIp,
  rateLimitShared,
  tooMany,
  requirePerm,
  sendNtfyNotification,
  ntfyConfigSummary,
} = require('../_lib');

/**
 * POST /api/admin/notify-test — admin-only notification self-test.
 *
 * Sends one harmless message through the optional ntfy backup channel and
 * reports whether the request was built, delivered, and what HTTP status ntfy
 * returned. This exists because a fire-and-forget push has no other observable
 * outcome: without it, a misconfigured environment variable and a network
 * failure look identical from the outside.
 *
 * Security: requires a signed-in admin/staff session with `orders.read`.
 * Returns booleans and an HTTP status only — never the topic, token, server
 * credentials, order data, or customer data.
 */
module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const ip = clientIp(req);
  const check = await rateLimitShared(`notifytest:${ip}`, 10, 60 * 1000);
  if (!check.allowed) return tooMany(res, check.resetIn);

  const session = await requirePerm(req, res, 'orders.read');
  if (!session) return;

  const config = ntfyConfigSummary();
  const outcome = {};
  let delivered = false;
  try {
    // Fire-and-forget helper: it never throws, and the outcome object records
    // the configured/status/network flags for this diagnostic response.
    delivered = await sendNtfyNotification({
      title: 'ZASHM notification self-test',
      message: `Harmless self-test triggered by ${session.name || 'admin'} at ${new Date().toISOString()}`,
      tags: 'test_tube,bell',
      priority: 3,
      result: outcome,
    });
  } catch (e) {
    // Defensive only — the helper contains its own try/catch.
    console.error('notify self-test failed:', e && e.name);
  }

  return json(res, 200, {
    success: true,
    ntfy: {
      configured: config.configured,
      serverHost: config.serverHost,
      serverIsDefault: config.serverIsDefault,
      tokenConfigured: config.tokenConfigured,
      delivered: delivered === true,
      httpStatus: typeof outcome.status === 'number' ? outcome.status : null,
      networkError: outcome.network === true,
    },
    telegram: {
      configured: Boolean(
        (process.env.TELEGRAM_BOT_TOKEN || '').trim() &&
          (process.env.TELEGRAM_CHAT_ID || '').trim()
      ),
    },
  });
};
