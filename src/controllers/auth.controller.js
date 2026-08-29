'use strict';

const config = require('../config/config');
const { authService, tokenService, userService, emailService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

/** Client metadata attached to every issued session, useful for auditing. */
const clientMeta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') || null });

/**
 * Tokens returned to a client are only ever exposed in the JSON body; the refresh
 * token is additionally set as an httpOnly cookie for browser clients that want
 * one. Mobile clients (Flutter) simply ignore the cookie.
 */
const setRefreshCookie = (res, tokens) => {
  res.cookie('refreshToken', tokens.refresh.token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    expires: tokens.refresh.expires,
    path: '/',
  });
};

// ============================================================================
// EMAIL/PASSWORD AUTH FLOW (Keep for backward compatibility)
// ============================================================================

const register = catchAsync(async (req, res) => {
  const user = await authService.register(req.body);
  const tokens = await tokenService.generateAuthTokens(user, clientMeta(req));
  const verifyEmailToken = await tokenService.generateVerifyEmailToken(user);
  await emailService.sendVerificationEmail(user.email, verifyEmailToken);

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'Account created',
    data: {
      user,
      tokens,
      ...(config.isProduction ? {} : { verifyEmailToken }),
    },
  });
});

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const user = await authService.loginUserWithEmailAndPassword(email, password);
  const tokens = await tokenService.generateAuthTokens(user, clientMeta(req));

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, { message: 'Signed in', data: { user, tokens } });
});

const refreshTokens = catchAsync(async (req, res) => {
  const refreshToken = req.body.refreshToken || req.cookies.refreshToken;
  const { user, tokens } = await authService.refreshAuth(refreshToken, clientMeta(req));

  setRefreshCookie(res, tokens);
  return ApiResponse.send(res, { message: 'Session refreshed', data: { user, tokens } });
});

const logoutAll = catchAsync(async (req, res) => {
  await authService.logoutAll(req.principal.id);
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, { message: 'Signed out of every device', data: null });
});

const forgotPassword = catchAsync(async (req, res) => {
  const { token, user } = await authService.forgotPassword(req.body.email);
  if (token && user) {
    await emailService.sendResetPasswordEmail(user.email, token);
  }
  return ApiResponse.send(res, {
    message: 'If that email is registered, a reset link is on its way',
    data: config.isProduction ? null : { resetToken: token },
  });
});

const resetPassword = catchAsync(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  return ApiResponse.send(res, { message: 'Password updated, please sign in again', data: null });
});

const verifyEmail = catchAsync(async (req, res) => {
  const user = await authService.verifyEmail(req.body.token);
  return ApiResponse.send(res, { message: 'Email verified', data: { user } });
});

const changePassword = catchAsync(async (req, res) => {
  await authService.changePassword(
    req.principal.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, {
    message: 'Password changed, please sign in again',
    data: null,
  });
});

// ============================================================================
// OTP AUTH FLOW (Phone-first, per CLAUDE.md §4)
// ============================================================================

/**
 * OTP request: send 6-digit code to phone
 * 5-min TTL, max 5 attempts, 15-min lockout on phone + IP
 */
const requestOtp = catchAsync(async (req, res) => {
  const { phone, locale } = req.body;
  const { challengeId, expiresIn } = await authService.requestOtp(phone, locale, clientMeta(req));

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'OTP sent to phone',
    data: { challengeId, expiresIn },
  });
});

/**
 * OTP verify: exchange challenge + code for tokens
 * Returns tokens + isNewUser flag for first-time signup
 */
const verifyOtp = catchAsync(async (req, res) => {
  const { challengeId, code } = req.body;
  const { user, tokens, isNewUser } = await authService.verifyOtp(challengeId, code, clientMeta(req));

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: isNewUser ? 'Account created' : 'Signed in',
    data: { accessToken: tokens.access.token, refreshToken: tokens.refresh.token, isNewUser },
  });
});

/**
 * Refresh access token; returns rotated refresh token (single-use)
 * Reuse detection revokes whole device family + logs security event
 */
const refresh = catchAsync(async (req, res) => {
  const { refreshToken } = req.body;
  const { tokens } = await authService.refresh(refreshToken, clientMeta(req));

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Session refreshed',
    data: { accessToken: tokens.access.token, refreshToken: tokens.refresh.token },
  });
});

/**
 * Logout: revoke single device session
 */
const logout = catchAsync(async (req, res) => {
  const { refreshToken } = req.body;
  await authService.logout(refreshToken);

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Signed out',
    data: null,
  });
});

/**
 * Register device: store push token + platform for notifications
 * Called after login
 */
const registerDevice = catchAsync(async (req, res) => {
  const { pushToken, platform, appVersion, locale } = req.body;
  const userId = req.principal.id;

  await authService.registerDevice(userId, {
    pushToken,
    platform,
    appVersion,
    locale,
  });

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Device registered',
    data: null,
  });
});

/**
 * Get current user profile + journey summary + entitlement
 * Required for POST /auth/me
 */
const me = catchAsync(async (req, res) => {
  const userId = req.principal.id;
  const { user, journey, entitlement } = await authService.getMe(userId);

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Current user',
    data: { user, journey, entitlement },
  });
});

module.exports = {
  // Email/password flow
  register,
  login,
  refreshTokens,
  logoutAll,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  // OTP flow
  requestOtp,
  verifyOtp,
  refresh,
  logout,
  registerDevice,
  me,
};
