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

const logout = catchAsync(async (req, res) => {
  await authService.logout(req.body.refreshToken || req.cookies.refreshToken);
  res.clearCookie('refreshToken', { path: '/' });
  return ApiResponse.send(res, { statusCode: httpStatus.OK, message: 'Signed out', data: null });
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

const me = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.principal.id);
  return ApiResponse.send(res, {
    message: 'Current user',
    data: { user, role: req.principal.role, rights: req.principal.rights },
  });
});

module.exports = {
  register,
  login,
  logout,
  logoutAll,
  refreshTokens,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
  me,
};
