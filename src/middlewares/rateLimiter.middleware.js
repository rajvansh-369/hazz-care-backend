'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const buildLimiter = ({ windowMs, max, message, skipSuccessfulRequests = false }) =>
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
      next(new ApiError(httpStatus.TOO_MANY_REQUESTS, message, { code: errorCodes.RATE_LIMITED }));
    },
  });

/** Broad limiter applied to the whole API surface. */
const generalLimiter = buildLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests. Please slow down and try again later.',
});

/**
 * Tight limiter for credential endpoints. Successful requests are not counted,
 * so a legitimate user is never locked out by their own activity.
 */
const authLimiter = buildLimiter({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
  message: 'Too many authentication attempts. Please try again later.',
});

/**
 * OTP limiter: 5 attempts per 15 min per phone (per CLAUDE.md §4)
 */
const otpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  skipSuccessfulRequests: false,
  message: 'Too many OTP attempts. Please try again in 15 minutes.',
});

module.exports = { generalLimiter, authLimiter, otpLimiter, buildLimiter };
