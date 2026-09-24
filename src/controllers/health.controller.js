'use strict';

const { healthService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const httpStatus = require('../utils/httpStatus');

const live = (req, res) => {
  res.status(httpStatus.OK).json({ status: 'live' });
};

const ready = catchAsync(async (req, res) => {
  const report = await healthService.readiness();
  const statusCode = report.status === 'ready' ? httpStatus.OK : httpStatus.SERVICE_UNAVAILABLE;
  res.status(statusCode).json(report);
});

module.exports = { live, ready };
