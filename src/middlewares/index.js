'use strict';

module.exports = {
  requireAuth: require('./auth.middleware'),
  requestId: require('./requestId.middleware'),
  validate: require('./validate.middleware'),
  ...require('./error.middleware'),
  ...require('./rateLimiter.middleware'),
};
