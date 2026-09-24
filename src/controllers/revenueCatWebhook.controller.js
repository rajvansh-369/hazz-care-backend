'use strict';

const config = require('../config/config');
const logger = require('../config/logger');
const { verifyAuthorization, verifySignature } = require('../lib/revenueCatAuth');
const revenueCatService = require('../services/revenueCat.service');
const errorCodes = require('../utils/errorCodes');
const catchAsync = require('../utils/catchAsync');
const { sendJson } = require('../utils/respond');

const SIGNATURE_HEADER = 'x-revenuecat-webhook-signature';

/**
 * HMAC signing when a signing secret is configured, otherwise the fixed shared secret in
 * the Authorization header (BACKEND_SPEC.md §6b). Neither header value is ever logged.
 */
const isAuthentic = (req, rawBody) => {
  const hmacSecret = config.revenueCat.webhookHmacSecret;
  if (hmacSecret) {
    return verifySignature({
      rawBody,
      header: req.get(SIGNATURE_HEADER),
      secret: hmacSecret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
  }
  return verifyAuthorization({ header: req.get('authorization'), secret: config.revenueCat.webhookSecret });
};

/**
 * POST /webhooks/revenuecat. Answers exactly 200, 400, 401 or 503.
 *
 * Stores the event and answers 200 as soon as it is durable; processing runs afterwards.
 * A redelivery (same event.id) is 200 and nothing else. A storage failure is 503, so
 * RevenueCat retries (5 times, over under three hours).
 */
const receive = async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!isAuthentic(req, rawBody)) {
    logger.warn('RevenueCat webhook refused: authentication failed');
    return sendJson(res, 401, { code: errorCodes.unauthorized });
  }

  const text = rawBody.toString('utf8');
  const event = revenueCatService.parseEvent(text);
  if (!event) {
    return sendJson(res, 400, { code: errorCodes.invalid_input });
  }
  if (event.type === 'TEST') {
    logger.info(`RevenueCat TEST event ${event.id} received; nothing stored`);
    return sendJson(res, 200, {});
  }

  let result;
  try {
    result = await revenueCatService.store(event, text);
  } catch (error) {
    logger.error(`RevenueCat event ${event.id} could not be stored: ${error.message}`);
    return sendJson(res, 503, { code: errorCodes.unavailable });
  }
  if (result === 'stored') {
    revenueCatService.schedule(event.id);
  } else {
    logger.info(`RevenueCat event ${event.id} redelivered; already stored`);
  }
  return sendJson(res, 200, {});
};

module.exports = { receive: catchAsync(receive) };
