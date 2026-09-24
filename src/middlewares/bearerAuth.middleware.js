'use strict';

const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');
const catchAsync = require('../utils/catchAsync');

const bearerAuth = catchAsync(async (req, res, next) => {
  const header = req.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid credentials', {
      code: errorCodes.invalid_credentials,
    });
  }

  const token = header.slice(7).trim();
  if (!token) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid credentials', {
      code: errorCodes.invalid_credentials,
    });
  }

  req.accessToken = token;
  next();
});

module.exports = bearerAuth;
