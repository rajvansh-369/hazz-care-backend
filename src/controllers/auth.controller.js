'use strict';

const config = require('../config/config');
const logger = require('../config/logger');
const authService = require('../services/auth.service');
const authValidation = require('../validations/auth.validation');
const catchAsync = require('../utils/catchAsync');
const errorCodes = require('../utils/errorCodes');
const { sendJson, sendNoContent } = require('../utils/respond');
const { toAuthSession, toAuthUser } = require('../utils/serialize');

/**
 * HTTP only: validate, call the service, shape the response. Every handler reads
 * its input through the validators, which accept any body (including none).
 */
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

const waitUntil = (deadline) => {
  const remaining = deadline - Date.now();
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : undefined;
};

/**
 * POST /auth/forgot-password — 200 with a fresh { expiresInSeconds, resendAfterSeconds,
 * codeLength } for every valid address. Whatever the outcome, it never answers sooner
 * than FORGOT_PASSWORD_MIN_RESPONSE_MS after the request started, so timing cannot
 * reveal whether an account exists (§3.6, §6).
 */
const forgotPassword = catchAsync(async (req, res) => {
  const startedAt = Date.now();
  let body;
  try {
    body = await authService.forgotPassword(authValidation.forgotPassword(req.body));
  } finally {
    await waitUntil(startedAt + config.otp.forgotPasswordMinResponseMs);
  }
  sendJson(res, 200, body);
});

/** POST /auth/verify-otp — 200 with exactly { resetToken, expiresInSeconds }. */
const verifyOtp = catchAsync(async (req, res) => {
  const input = authValidation.verifyOtp(req.body);
  const { resetToken, expiresInSeconds } = await authService.verifyOtp(input);
  sendJson(res, 200, { resetToken, expiresInSeconds });
});

/**
 * POST /auth/reset-password — 204, no body, no tokens. The token is checked before the
 * password, so a dead token is reported first (§3.8).
 */
const resetPassword = catchAsync(async (req, res) => {
  const resetToken = authValidation.resetToken(req.body);
  await authService.assertUsableResetToken(resetToken);
  const password = authValidation.newPassword(req.body);
  await authService.resetPassword(resetToken, password);
  sendNoContent(res);
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
  forgotPassword,
  verifyOtp,
  resetPassword,
  logout,
  me,
};
