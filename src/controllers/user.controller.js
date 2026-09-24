'use strict';

const httpStatus = require('../utils/httpStatus');
const catchAsync = require('../utils/catchAsync');

const getMe = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({});
});

const updateMe = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).json({});
});

module.exports = {
  getMe,
  updateMe,
};
