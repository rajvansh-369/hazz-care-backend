'use strict';

const { userService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const pick = require('../utils/pick');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  return ApiResponse.send(res, {
    statusCode: httpStatus.CREATED,
    message: 'User created',
    data: { user },
  });
});

const getUsers = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'email', 'role', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await userService.queryUsers(filter, options);
  return ApiResponse.send(res, {
    message: 'Users retrieved',
    data: result.results,
    meta: {
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      totalResults: result.totalResults,
    },
  });
});

const getUser = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.params.userId);
  return ApiResponse.send(res, { message: 'User retrieved', data: { user } });
});

const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.params.userId, req.body);
  return ApiResponse.send(res, { message: 'User updated', data: { user } });
});

const deleteUser = catchAsync(async (req, res) => {
  await userService.deleteUserById(req.params.userId);
  return res.status(httpStatus.NO_CONTENT).send();
});

const getMe = catchAsync(async (req, res) => {
  const user = await userService.getUserByIdOrFail(req.principal.id);
  return ApiResponse.send(res, { message: 'Profile retrieved', data: { user } });
});

const updateMe = catchAsync(async (req, res) => {
  const user = await userService.updateUserById(req.principal.id, req.body);
  return ApiResponse.send(res, { message: 'Profile updated', data: { user } });
});

module.exports = { createUser, getUsers, getUser, updateUser, deleteUser, getMe, updateMe };
