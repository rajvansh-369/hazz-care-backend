'use strict';

const { verifyAccess } = require('../services/token.service');
const ApiError = require('../utils/ApiError');

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * Verifies `Authorization: Bearer <jwt>` via tokenService.verifyAccess (HS256 only,
 * JWT_ACCESS_SECRET, non-empty string `sub`).
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

  const verified = verifyAccess(match[1]);
  if (!verified) {
    return next(ApiError.unauthorized());
  }

  req.auth = { userId: verified.userId };
  return next();
};

module.exports = requireAuth;
