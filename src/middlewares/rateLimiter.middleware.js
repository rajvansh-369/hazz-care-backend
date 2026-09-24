'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const errorCodes = require('../utils/errorCodes');
const { sendJson } = require('../utils/respond');

const HOUR_MS = 60 * 60 * 1000;

const buildLimiter = ({ windowMs, max, skipSuccessfulRequests = false }) =>
  rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Rate limiting is a transport concern; disable it entirely under test so
    // suites stay deterministic no matter how many requests they fire.
    skip: () => config.isTest,
    handler: (req, res, next) => {
      next(ApiError.tooManyAttempts());
    },
  });

const otpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: false,
});

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

/** Kept for the refresh tests and call sites that name it. */
const createRefreshLimiter = createIpLimiter;

const refreshLimiter = createIpLimiter();
const forgotPasswordLimiter = createIpLimiter();
const verifyOtpLimiter = createIpLimiter();

module.exports = {
  otpLimiter,
  buildLimiter,
  createIpLimiter,
  createRefreshLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
  verifyOtpLimiter,
};
