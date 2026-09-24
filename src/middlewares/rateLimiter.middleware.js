'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const errorCodes = require('../utils/errorCodes');
const { sendJson } = require('../utils/respond');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Per-IP limiter factory for the auth routes that may be limited (CLAUDE.md A7):
 * /refresh, /forgot-password and /verify-otp. Never /login, /register, /logout or
 * /reset-password. Each route gets its own instance, attached to that route only.
 *
 * - Generous (RATE_LIMIT_IP_PER_HOUR): hundreds of pilgrims share one hotel NAT address.
 * - Keyed on req.ip, which honours TRUST_PROXY.
 * - Answers 429 {"code":"too_many_attempts"} as JSON, sent directly — never 401 or
 *   403 (on /refresh that would sign the pilgrim out; on the reset routes the client
 *   shows "That email and password do not match").
 * - A failing store lets the request through (passOnStoreError): a broken limiter
 *   must never become an outage.
 *
 * Tests build their own with a small limit and `skip: () => false`.
 *
 * @param {{ limit?: number, windowMs?: number, store?: object, skip?: Function }} [options]
 */
const createIpLimiter = ({
  limit = config.rateLimit.ipPerHour,
  windowMs = HOUR_MS,
  store,
  skip = () => config.isTest,
} = {}) =>
  rateLimit({
    windowMs,
    limit,
    keyGenerator: (req) => req.ip,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    skip,
    ...(store ? { store } : {}),
    handler: (req, res) => sendJson(res, 429, { code: errorCodes.too_many_attempts }),
  });

const refreshLimiter = createIpLimiter();
const forgotPasswordLimiter = createIpLimiter();
const verifyOtpLimiter = createIpLimiter();

module.exports = {
  createIpLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
  verifyOtpLimiter,
};
