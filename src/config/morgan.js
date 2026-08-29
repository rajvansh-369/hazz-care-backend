'use strict';

const morgan = require('morgan');
const config = require('./config');
const logger = require('./logger');

morgan.token('request-id', (req) => req.id || '-');
morgan.token('error-message', (req, res) => res.locals.errorMessage || '-');

const baseFormat =
  ':remote-addr :method :url :status :res[content-length] - :response-time ms rid=:request-id';

const successResponseFormat = baseFormat;
const errorResponseFormat = `${baseFormat} - error: :error-message`;

const successHandler = morgan(successResponseFormat, {
  skip: (req, res) => res.statusCode >= 400,
  stream: { write: (message) => logger.http(message.trim()) },
});

const errorHandler = morgan(errorResponseFormat, {
  skip: (req, res) => res.statusCode < 400,
  stream: { write: (message) => logger.warn(message.trim()) },
});

module.exports = {
  successHandler,
  errorHandler,
  enabled: !config.isTest,
};
