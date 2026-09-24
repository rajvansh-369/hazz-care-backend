'use strict';

const httpStatus = require('../utils/httpStatus');
const catchAsync = require('../utils/catchAsync');

const register = catchAsync(async (req, res) => {
  // Phase 3
  res.status(httpStatus.CREATED).json({});
});

const login = catchAsync(async (req, res) => {
  // Phase 3
  res.status(httpStatus.OK).json({});
});

const refreshTokens = catchAsync(async (req, res) => {
  // Phase 3
  res.status(httpStatus.OK).json({});
});

const logout = catchAsync(async (req, res) => {
  // Phase 3: 204 no body
  res.status(httpStatus.NO_CONTENT).json({});
});

const forgotPassword = catchAsync(async (req, res) => {
  // Phase 3
  res.status(httpStatus.OK).json({});
});

const verifyOtp = catchAsync(async (req, res) => {
  // Phase 3
  res.status(httpStatus.OK).json({});
});

const resetPassword = catchAsync(async (req, res) => {
  // Phase 3: 204 no body
  res.status(httpStatus.NO_CONTENT).json({});
});

const me = catchAsync(async (req, res) => {
  // Phase 3: return bare AuthUser
  res.status(httpStatus.OK).json({});
});

module.exports = {
  register,
  login,
  refreshTokens,
  logout,
  forgotPassword,
  verifyOtp,
  resetPassword,
  me,
};
