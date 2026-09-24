'use strict';

const express = require('express');
const revenueCatWebhookController = require('../../controllers/revenueCatWebhook.controller');
const errorCodes = require('../../utils/errorCodes');
const { sendJson } = require('../../utils/respond');

const router = express.Router();

// The raw bytes, not parsed JSON: the HMAC signature covers the body exactly as sent,
// and re-serialising a parsed object changes it. Mounted in app.js BEFORE express.json().
router.post(
  '/revenuecat',
  express.raw({ type: 'application/json', limit: '1mb' }),
  revenueCatWebhookController.receive
);

// This route answers only 200, 400, 401 or 503. An oversized or undecodable body is
// 400; anything else that escapes the handler is 503, so RevenueCat retries.
// eslint-disable-next-line no-unused-vars -- Express needs the 4-argument signature
router.use((err, req, res, next) => {
  const status = err && (err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    return sendJson(res, 400, { code: errorCodes.invalid_input });
  }
  return sendJson(res, 503, { code: errorCodes.unavailable });
});

module.exports = router;
