'use strict';

const { User } = require('../models');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

/**
 * @param {object} userBody
 * @returns {Promise<User>}
 */
const createUser = async (userBody) => {
  if (await User.isEmailTaken(userBody.email)) {
    throw new ApiError(httpStatus.CONFLICT, 'Email is already registered', {
      code: errorCodes.EMAIL_ALREADY_EXISTS,
      details: [{ field: 'email', message: 'Email is already registered' }],
    });
  }
  return User.create(userBody);
};

/**
 * @param {object} filter
 * @param {object} options
 * @returns {Promise<object>}
 */
const queryUsers = async (filter, options) => User.paginate(filter, options);

/**
 * @param {string} id
 * @returns {Promise<User|null>}
 */
const getUserById = async (id) => User.findById(id);

/**
 * @param {string} email
 * @param {boolean} [withPassword]
 * @returns {Promise<User|null>}
 */
const getUserByEmail = async (email, withPassword = false) => {
  const query = User.findOne({ email: String(email).toLowerCase() });
  return withPassword ? query.select('+password') : query;
};

/**
 * @param {string} userId
 * @returns {Promise<User>}
 */
const getUserByIdOrFail = async (userId) => {
  const user = await getUserById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found', {
      code: errorCodes.RESOURCE_NOT_FOUND,
    });
  }
  return user;
};

/**
 * @param {string} userId
 * @param {object} updateBody
 * @returns {Promise<User>}
 */
const updateUserById = async (userId, updateBody) => {
  const user = await getUserByIdOrFail(userId);
  if (updateBody.email && (await User.isEmailTaken(updateBody.email, userId))) {
    throw new ApiError(httpStatus.CONFLICT, 'Email is already registered', {
      code: errorCodes.EMAIL_ALREADY_EXISTS,
      details: [{ field: 'email', message: 'Email is already registered' }],
    });
  }
  Object.assign(user, updateBody);
  await user.save();
  return user;
};

/**
 * @param {string} userId
 * @returns {Promise<User>}
 */
const deleteUserById = async (userId) => {
  const user = await getUserByIdOrFail(userId);
  await user.deleteOne();
  return user;
};

module.exports = {
  createUser,
  queryUsers,
  getUserById,
  getUserByIdOrFail,
  getUserByEmail,
  updateUserById,
  deleteUserById,
};
