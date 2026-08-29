'use strict';

const { Token, User } = require('../models');
const config = require('../config/config');
const tokenTypes = require('../config/tokenTypes');
const userService = require('./user.service');
const tokenService = require('./token.service');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const INVALID_CREDENTIALS = () =>
  new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect email or password', {
    code: errorCodes.INVALID_CREDENTIALS,
  });

/**
 * Authenticates a user, applying brute force protection and account state checks.
 * The same generic message is returned for unknown emails and wrong passwords so
 * the endpoint cannot be used to enumerate accounts.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<User>}
 */
const loginUserWithEmailAndPassword = async (email, password) => {
  const user = await userService.getUserByEmail(email, true);
  if (!user) {
    throw INVALID_CREDENTIALS();
  }

  if (!user.isActive) {
    throw new ApiError(httpStatus.FORBIDDEN, 'This account has been deactivated', {
      code: errorCodes.ACCOUNT_DISABLED,
    });
  }

  if (user.isLocked()) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      `Account locked after too many failed attempts. Try again in ${config.security.loginLockMinutes} minutes`,
      { code: errorCodes.ACCOUNT_LOCKED }
    );
  }

  const isMatch = await user.isPasswordMatch(password);
  if (!isMatch) {
    await user.registerFailedLogin();
    throw INVALID_CREDENTIALS();
  }

  await user.registerSuccessfulLogin();
  user.password = undefined;
  return user;
};

/**
 * @param {object} userBody
 * @returns {Promise<User>}
 */
const register = async (userBody) => userService.createUser(userBody);

/**
 * @param {string} refreshToken
 * @returns {Promise<void>}
 */
const logout = async (refreshToken) => {
  const tokenDoc = await Token.findOne({
    token: tokenService.hashToken(refreshToken),
    type: tokenTypes.REFRESH,
    blacklisted: false,
  });
  if (!tokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Session not found or already ended', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  await Token.deleteOne({ _id: tokenDoc._id });
};

/**
 * @param {string} userId
 * @returns {Promise<void>}
 */
const logoutAll = async (userId) => tokenService.revokeAllUserTokens(userId);

/**
 * Rotates a refresh token: the presented token is destroyed and a brand new pair
 * is issued, so a stolen refresh token is usable at most once.
 *
 * @param {string} refreshToken
 * @param {object} [meta]
 * @returns {Promise<{user: User, tokens: object}>}
 */
const refreshAuth = async (refreshToken, meta = {}) => {
  const refreshTokenDoc = await tokenService.verifyStoredToken(refreshToken, tokenTypes.REFRESH);
  const user = await userService.getUserById(refreshTokenDoc.user);
  if (!user || !user.isActive) {
    await Token.deleteOne({ _id: refreshTokenDoc._id });
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Session is no longer valid', {
      code: errorCodes.TOKEN_INVALID,
    });
  }
  await Token.deleteOne({ _id: refreshTokenDoc._id });
  const tokens = await tokenService.generateAuthTokens(user, meta);
  return { user, tokens };
};

/**
 * @param {string} email
 * @returns {Promise<{token: string|null, user: User|null}>}
 */
const forgotPassword = async (email) => {
  const user = await userService.getUserByEmail(email);
  if (!user || !user.isActive) {
    // Silently succeed so the endpoint cannot confirm which emails exist.
    return { token: null, user: null };
  }
  const token = await tokenService.generateResetPasswordToken(user);
  return { token, user };
};

/**
 * @param {string} resetPasswordToken
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const resetPassword = async (resetPasswordToken, newPassword) => {
  const tokenDoc = await tokenService.verifyStoredToken(
    resetPasswordToken,
    tokenTypes.RESET_PASSWORD
  );
  const user = await userService.getUserByIdOrFail(tokenDoc.user);

  user.password = newPassword;
  user.loginAttempts = 0;
  user.lockUntil = null;
  await user.save();

  await Token.deleteMany({ user: user.id, type: tokenTypes.RESET_PASSWORD });
  await tokenService.revokeAllUserTokens(user.id);
};

/**
 * @param {string} verifyEmailToken
 * @returns {Promise<User>}
 */
const verifyEmail = async (verifyEmailToken) => {
  const tokenDoc = await tokenService.verifyStoredToken(verifyEmailToken, tokenTypes.VERIFY_EMAIL);
  const user = await userService.getUserByIdOrFail(tokenDoc.user);
  user.isEmailVerified = true;
  await user.save();
  await Token.deleteMany({ user: user.id, type: tokenTypes.VERIFY_EMAIL });
  return user;
};

/**
 * @param {string} userId
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
const changePassword = async (userId, currentPassword, newPassword) => {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  if (!(await user.isPasswordMatch(currentPassword))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Current password is incorrect', {
      code: errorCodes.INVALID_CREDENTIALS,
      details: [{ field: 'currentPassword', message: 'Current password is incorrect' }],
    });
  }
  if (currentPassword === newPassword) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'New password must differ from the current one', {
      code: errorCodes.VALIDATION_ERROR,
      details: [{ field: 'newPassword', message: 'New password must differ from the current one' }],
    });
  }
  user.password = newPassword;
  await user.save();
  await tokenService.revokeAllUserTokens(user.id);
};

module.exports = {
  register,
  loginUserWithEmailAndPassword,
  logout,
  logoutAll,
  refreshAuth,
  forgotPassword,
  resetPassword,
  verifyEmail,
  changePassword,
};
