'use strict';

const logger = require('../config/logger');
const authService = require('../services/auth.service');
const authValidation = require('../validations/auth.validation');
const catchAsync = require('../utils/catchAsync');
const errorCodes = require('../utils/errorCodes');
const { sendJson, sendNoContent } = require('../utils/respond');
const { toAuthSession, toAuthUser } = require('../utils/serialize');

/**
 * HTTP only: validate, call the service, shape the response. Every handler reads
 * `req.body || {}`-safe input through the validators, which accept any body.
 *
 * Handlers not implemented yet answer 503 {"code":"unavailable"} — never 200 {},
 * which the client fails to parse as a session. 503 is retryable on the client and
 * never ends a session.
 */
const notImplemented = (req, res) => sendJson(res, 503, { code: errorCodes.unavailable });

const register = catchAsync(async (req, res) => {
  const input = authValidation.register(req.body);
  const { user, tokens } = await authService.register(input);
  sendJson(res, 201, toAuthSession(tokens, user));
});

const login = catchAsync(async (req, res) => {
  const input = authValidation.login(req.body);
  const { user, tokens } = await authService.login(input);
  sendJson(res, 200, toAuthSession(tokens, user));
});

/** Logs an error by name, code and stack only — never a request body or token value. */
const logFailure = (req, message, error) => {
  logger.error(message, {
    requestId: req.id,
    errorName: error && error.name,
    errorCode: error && error.code !== undefined ? String(error.code) : undefined,
    stack: error && error.stack,
  });
};

/**
 * POST /auth/refresh — the ONLY response in the API that can sign a pilgrim out: a
 * 401 or 403 with a JSON content type ends the session, even with no body (§3.5, §4).
 * So every status is decided here, inside one try/catch, and nothing reaches the
 * default error handler:
 *
 *   bad body            → 400 invalid_input   (not a sign-out)
 *   genuinely dead token → 401 session_revoked (the only 401 on this route)
 *   success             → 200 { tokens }      (no user key)
 *   anything thrown     → 503 unavailable     (session untouched)
 */
const refresh = catchAsync(async (req, res) => {
  try {
    const refreshToken = authValidation.refresh(req.body);
    if (refreshToken === null) {
      return sendJson(res, 400, { code: errorCodes.invalid_input });
    }
    const pair = await authService.refresh(refreshToken);
    if (pair === null) {
      return sendJson(res, 401, { code: errorCodes.session_revoked });
    }
    return sendJson(res, 200, {
      tokens: {
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        expiresIn: pair.expiresIn,
      },
    });
  } catch (error) {
    logFailure(req, 'POST /auth/refresh failed; answering 503 so the session survives', error);
    if (res.headersSent) {
      return undefined;
    }
    return sendJson(res, 503, { code: errorCodes.unavailable });
  }
});

/**
 * POST /auth/logout — ALWAYS 204, no body (§3.9). The client has already cleared its
 * session and does nothing with the answer; revocation is best effort.
 */
const logout = catchAsync(async (req, res) => {
  try {
    const refreshToken = authValidation.logout(req.body);
    if (refreshToken !== null) {
      await authService.logout(refreshToken);
    }
  } catch (error) {
    logFailure(req, 'POST /auth/logout could not revoke; answering 204 anyway', error);
  }
  if (res.headersSent) {
    return undefined;
  }
  return sendNoContent(res);
});

/** A bare AuthUser, not { user }, and nothing else (BACKEND_SPEC.md §3.10). */
const me = catchAsync(async (req, res) => {
  const user = await authService.getMe(req.auth.userId);
  sendJson(res, 200, toAuthUser(user));
});

module.exports = {
  register,
  login,
  refresh,
  forgotPassword: notImplemented,
  verifyOtp: notImplemented,
  resetPassword: notImplemented,
  logout,
  me,
};
