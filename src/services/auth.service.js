'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const emailService = require('./email.service');
const otpService = require('./otp.service');
const passwordService = require('./password.service');
const sendLimitService = require('./sendLimit.service');
const tokenService = require('./token.service');

const DUPLICATE_KEY = 11000;

/** An E11000 on the users.email index, and nothing else, means "already registered". */
const isDuplicateEmail = (error) =>
  Boolean(
    error &&
      error.code === DUPLICATE_KEY &&
      ((error.keyPattern && Object.prototype.hasOwnProperty.call(error.keyPattern, 'email')) ||
        (error.keyValue && Object.prototype.hasOwnProperty.call(error.keyValue, 'email')))
  );

/**
 * Creates the account and its first session in one transaction: a user without a
 * session, or a session without a user, cannot be left behind.
 *
 * A duplicate is detected only by the unique index (never check-then-insert), so two
 * simultaneous registrations for one address cannot both succeed.
 *
 * @param {{ email: string, password: string, fullName: string|null }} input validated
 * @returns {Promise<{ user: object, tokens: object }>}
 */
const register = async ({ email, password, fullName }) => {
  const passwordHash = await passwordService.hash(password);
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      result = null;
      const [user] = await User.create([{ email, passwordHash, fullName }], { session });
      const tokens = await tokenService.issuePair(user._id, { session });
      result = { user, tokens };
    });
    return result;
  } catch (error) {
    if (isDuplicateEmail(error)) {
      throw ApiError.emailTaken();
    }
    // Any other duplicate key (a token hash collision, say) is not "that email
    // already has an account": it propagates and becomes a 503.
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Unknown address and wrong password are indistinguishable: same status, same body,
 * and the unknown path verifies against a dummy argon2id hash so it costs the same.
 * No lockout and no rate limit (BACKEND_SPEC.md §3.4).
 *
 * @param {{ email: string, password: string }} input validated, email normalised
 * @returns {Promise<{ user: object, tokens: object }>}
 */
const login = async ({ email, password }) => {
  const user = await User.findOne({ email }).select('+passwordHash');

  if (!user) {
    await passwordService.verify(await passwordService.getDummyHash(), password);
    throw ApiError.invalidCredentials();
  }
  if (!(await passwordService.verify(user.passwordHash, password))) {
    throw ApiError.invalidCredentials();
  }

  user.lastLoginAt = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: user.lastLoginAt } });
  const tokens = await tokenService.issuePair(user._id);
  return { user, tokens };
};

/**
 * @param {string} userId from a verified access token's `sub`
 * @returns {Promise<object>} the user
 * @throws {ApiError} 401 unauthorized when the id is malformed or the user is gone —
 *   never a CastError (503) and never a 404
 */
const getMe = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) {
    throw ApiError.unauthorized();
  }
  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.unauthorized();
  }
  return user;
};

/**
 * @param {string} refreshToken non-empty
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number } | null>}
 *   null ONLY for a genuinely dead token; infrastructure failures throw.
 */
const refresh = async (refreshToken) => tokenService.rotate(refreshToken);

/**
 * Best effort. Revokes every live token in the presented token's family (this
 * device's sign-in); an unknown token is a no-op.
 * @param {string} refreshToken non-empty
 */
const logout = async (refreshToken) => tokenService.revokeFamily(refreshToken, 'LOGOUT');

/**
 * POST /auth/forgot-password. Identical outcome for every valid address, registered
 * or not — same status, same body, same shape of work (BACKEND_SPEC.md §3.6, §6):
 * the per-address send limit runs for both, and the unknown path runs the same
 * transaction against a filter that matches nothing and schedules a no-op email.
 * Email delivery is never awaited.
 *
 * @param {{ email: string }} input validated, email normalised
 * @returns {Promise<{ expiresInSeconds: number, resendAfterSeconds: number, codeLength: number }>}
 */
const forgotPassword = async ({ email }) => {
  const { allowed } = await sendLimitService.consume(email);
  if (!allowed) {
    throw ApiError.tooManyAttempts();
  }

  const user = await User.findOne({ email });
  if (user) {
    const { code } = await otpService.issue(user);
    emailService.enqueueOtpEmail({ to: user.email, code });
  } else {
    await otpService.simulateIssue();
    emailService.enqueueNoop();
  }

  // A fresh full set on every call, resends included: the client's countdowns start
  // from these numbers (§5).
  return {
    expiresInSeconds: config.otp.ttlSeconds,
    resendAfterSeconds: config.otp.resendAfterSeconds,
    codeLength: config.otp.length,
  };
};

/**
 * POST /auth/verify-otp. A verified code buys a reset token and nothing else — never
 * a session (§3.7, §6). If issuing the token fails after the code was consumed, the
 * error propagates (503) and the pilgrim asks for a new code.
 *
 * @param {{ email: string, code: string }} input validated
 * @returns {Promise<{ resetToken: string, expiresInSeconds: number }>}
 */
const verifyOtp = async ({ email, code }) => {
  const result = await otpService.verify(email, code);
  if (result.error === 'locked') {
    throw ApiError.tooManyAttempts();
  }
  if (result.error === 'expired') {
    throw ApiError.otpExpired();
  }
  if (!result.ok) {
    throw ApiError.invalidOtp();
  }
  const resetToken = await tokenService.issueResetToken(result.userId);
  return { resetToken, expiresInSeconds: config.tokens.resetTtlSeconds };
};

/**
 * Read-only check that a reset token is usable, before the password is validated.
 * @param {string} resetToken
 * @throws {ApiError} 400 invalid_reset_token
 */
const assertUsableResetToken = async (resetToken) => {
  if (!(await tokenService.findUsableResetToken(resetToken))) {
    throw ApiError.invalidResetToken();
  }
};

/**
 * POST /auth/reset-password. The hash is computed before the transaction opens, to
 * keep it short. Then, atomically: spend the token (a concurrent double-submit loses
 * here), set the password, spend every other reset token and OTP code for the
 * account, and revoke every refresh token. Returns nothing: no tokens (§3.8).
 *
 * @param {string} resetToken
 * @param {string} password validated, untrimmed
 */
const resetPassword = async (resetToken, password) => {
  const passwordHash = await passwordService.hash(password);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const tokenDoc = await tokenService.consumeResetToken(resetToken, { session });
      if (!tokenDoc) {
        throw ApiError.invalidResetToken();
      }
      const userId = tokenDoc.user;
      const updated = await User.updateOne({ _id: userId }, { $set: { passwordHash } }, { session });
      if (updated.matchedCount === 0) {
        throw ApiError.invalidResetToken();
      }
      await tokenService.invalidateResetTokensForUser(userId, { session });
      await otpService.supersedeAllForUser(userId, { session });
      await tokenService.revokeAllForUser(userId, 'PASSWORD_RESET', { session });
    });
  } finally {
    await session.endSession();
  }
};

module.exports = {
  register,
  login,
  getMe,
  refresh,
  logout,
  forgotPassword,
  verifyOtp,
  assertUsableResetToken,
  resetPassword,
};
