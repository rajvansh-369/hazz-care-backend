'use strict';

const authService = require('../services/auth.service');
const authValidation = require('../validations/auth.validation');
const catchAsync = require('../utils/catchAsync');
const errorCodes = require('../utils/errorCodes');
const { sendJson } = require('../utils/respond');
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

/** A bare AuthUser, not { user }, and nothing else (BACKEND_SPEC.md §3.10). */
const me = catchAsync(async (req, res) => {
  const user = await authService.getMe(req.auth.userId);
  sendJson(res, 200, toAuthUser(user));
});

module.exports = {
  register,
  login,
  refresh: notImplemented,
  forgotPassword: notImplemented,
  verifyOtp: notImplemented,
  resetPassword: notImplemented,
  logout: notImplemented,
  me,
};
