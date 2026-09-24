'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');

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

module.exports = { otpLimiter, buildLimiter };
