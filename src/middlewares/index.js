'use strict';

module.exports = {
  auth: require('./auth.middleware'),
  requestId: require('./requestId.middleware'),
  validate: require('./validate.middleware'),
  ...require('./error.middleware'),
  ...require('./rateLimiter.middleware'),
};
