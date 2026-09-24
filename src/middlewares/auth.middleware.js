'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config/config');
const ApiError = require('../utils/ApiError');

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * Verifies `Authorization: Bearer <jwt>` (HS256, JWT_ACCESS_SECRET).
 *
 * Missing, malformed, invalid or expired → 401 {"code":"unauthorized"}, never 403:
 * the client's refresh-and-retry is wired to 401 only (BACKEND_SPEC.md §3.2).
 *
 * Attach it to `GET /auth/me` ONLY — never with `router.use()`. On register,
 * forgot-password, verify-otp and reset-password a 401 is shown to the pilgrim as
 * "That email and password do not match".
 */
const requireAuth = (req, res, next) => {
  const match = BEARER.exec(req.get('authorization') || '');
  if (!match) {
    return next(ApiError.unauthorized());
  }

  let payload;
  try {
    payload = jwt.verify(match[1], config.jwt.accessSecret, { algorithms: ['HS256'] });
  } catch (error) {
    return next(ApiError.unauthorized());
  }

  if (!payload || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return next(ApiError.unauthorized());
  }

  req.auth = { userId: payload.sub };
  return next();
};

module.exports = requireAuth;
