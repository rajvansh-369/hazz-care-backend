'use strict';

const { healthService } = require('../services');
const catchAsync = require('../utils/catchAsync');
const { sendJson } = require('../utils/respond');

const live = (req, res) => sendJson(res, 200, { status: 'live' });

const ready = catchAsync(async (req, res) => {
  const report = await healthService.readiness();
  sendJson(res, report.status === 'ready' ? 200 : 503, report);
});

module.exports = { live, ready };
