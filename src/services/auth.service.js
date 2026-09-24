'use strict';

const mongoose = require('mongoose');
const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const passwordService = require('./password.service');
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

module.exports = {
  register,
  login,
  getMe,
};
