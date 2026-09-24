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
 * Per-IP limiter for POST /auth/refresh ONLY (CLAUDE.md A7).
 *
 * - Generous (RATE_LIMIT_IP_PER_HOUR): hundreds of pilgrims share one hotel NAT address.
 * - Keyed on req.ip, which honours TRUST_PROXY.
 * - Answers 429 {"code":"too_many_attempts"} as JSON, sent directly — never 401 or
 *   403, which on this route would sign the pilgrim out.
 * - A failing store lets the request through (passOnStoreError): a broken limiter
 *   must never become an outage on the one route that keeps sessions alive.
 *
 * Tests build their own with a small limit and `skip: () => false`.
 *
 * @param {{ limit?: number, windowMs?: number, store?: object, skip?: Function }} [options]
 */
const createRefreshLimiter = ({
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

const refreshLimiter = createRefreshLimiter();

module.exports = { otpLimiter, buildLimiter, createRefreshLimiter, refreshLimiter };
