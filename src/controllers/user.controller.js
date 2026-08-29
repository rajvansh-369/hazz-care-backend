'use strict';

const { userService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const pick = require('../utils/pick');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

/**
 * Get current user profile (self-service)
 */
const getMe = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.principal.id);
  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Profile retrieved',
    data: { user },
  });
});

/**
 * Update current user profile (self-service)
 * Allowed fields: firstName, lastName, email, dob, gender, locale, countryCode
 */
const updateMe = catchAsync(async (req, res) => {
  const allowedFields = ['firstName', 'lastName', 'email', 'dob', 'gender', 'locale', 'countryCode'];
  const updates = pick(req.body, allowedFields);
  const user = await userService.updateUserById(req.principal.id, updates);

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Profile updated',
    data: { user },
  });
});

/**
 * List users (admin only)
 * Cursor-based pagination per CLAUDE.md §2
 */
const getUsers = catchAsync(async (req, res) => {
  const { cursor, limit } = pick(req.query, ['cursor', 'limit']);
  const result = await userService.queryUsers({ cursor, limit });

  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'Users retrieved',
    data: result.data,
    meta: {
      nextCursor: result.nextCursor,
      requestId: req.requestId,
    },
  });
});

/**
 * Get user by ID (admin or self)
 */
const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.params.userId);
  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'User retrieved',
    data: { user },
  });
});

/**
 * Update user (admin only)
 * Can update: firstName, lastName, email, status, locale, countryCode, etc.
 */
const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.params.userId, req.body);
  return ApiResponse.send(res, {
    statusCode: httpStatus.OK,
    message: 'User updated',
    data: { user },
  });
});

/**
 * Delete user (admin only)
 * Soft delete: sets deleted_at, preserves audit trail
 */
const deleteUser = catchAsync(async (req, res) => {
  await userService.deleteUserById(req.params.userId);
  return res.status(httpStatus.NO_CONTENT).send();
});

module.exports = {
  getMe,
  updateMe,
  getUsers,
  getUser,
  updateUser,
  deleteUser,
};
