'use strict';

const { healthService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/ApiResponse');
const httpStatus = require('../utils/httpStatus');

const live = (req, res) =>
  ApiResponse.send(res, { message: 'Service is live', data: healthService.liveness() });

const ready = catchAsync(async (req, res) => {
  const report = await healthService.readiness();
  return ApiResponse.send(res, {
    statusCode: report.status === 'ready' ? httpStatus.OK : httpStatus.SERVICE_UNAVAILABLE,
    message: report.status === 'ready' ? 'Service is ready' : 'Service is not ready',
    data: report,
  });
});

module.exports = { live, ready };
