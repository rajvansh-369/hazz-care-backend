'use strict';

const morgan = require('morgan');
const config = require('./config');
const logger = require('./logger');

morgan.token('request-id', (req) => req.id || '-');

/**
 * One line per request: method, URL, status and time, plus the request id. Never
 * bodies, never headers — secrets travel in both.
 */
const format = ':method :url :status :response-time ms rid=:request-id';

const successHandler = morgan(format, {
  skip: (req, res) => res.statusCode >= 400,
  stream: { write: (message) => logger.http(message.trim()) },
});

const errorHandler = morgan(format, {
  skip: (req, res) => res.statusCode < 400,
  stream: { write: (message) => logger.warn(message.trim()) },
});

module.exports = {
  successHandler,
  errorHandler,
  enabled: !config.isTest,
};
