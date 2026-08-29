'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

/** Terminal 404 for any request that matched no route. */
const notFoundHandler = (req, res, next) => {
  next(
    new ApiError(httpStatus.NOT_FOUND, `Route ${req.method} ${req.originalUrl} does not exist`, {
      code: errorCodes.ROUTE_NOT_FOUND,
    })
  );
};

const fromMongooseValidationError = (error) => {
  const details = Object.values(error.errors || {}).map((fieldError) => ({
    field: fieldError.path,
    location: 'body',
    message: fieldError.message,
  }));
  return new ApiError(httpStatus.BAD_REQUEST, 'Request validation failed', {
    code: errorCodes.VALIDATION_ERROR,
    details,
    stack: error.stack,
  });
};

const fromDuplicateKeyError = (error) => {
  const field = Object.keys(error.keyPattern || error.keyValue || { field: 1 })[0];
  return new ApiError(httpStatus.CONFLICT, `A record with this ${field} already exists`, {
    code: field === 'email' ? errorCodes.EMAIL_ALREADY_EXISTS : errorCodes.DUPLICATE_RESOURCE,
    details: [{ field, location: 'body', message: `This ${field} is already in use` }],
    stack: error.stack,
  });
};

/**
 * Normalises every thrown value into an ApiError before it reaches the handler.
 * Anything unrecognised becomes a non-operational 500, which the handler then
 * scrubs in production.
 */
// eslint-disable-next-line no-unused-vars
const errorConverter = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    if (error instanceof mongoose.Error.ValidationError) {
      error = fromMongooseValidationError(error);
    } else if (error instanceof mongoose.Error.CastError) {
      error = new ApiError(httpStatus.BAD_REQUEST, `Invalid value for '${error.path}'`, {
        code: errorCodes.VALIDATION_ERROR,
        details: [{ field: error.path, location: 'params', message: 'Malformed identifier' }],
        stack: error.stack,
      });
    } else if (error && (error.code === 11000 || error.code === 11001)) {
      error = fromDuplicateKeyError(error);
    } else if (error instanceof mongoose.Error) {
      error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database operation failed', {
        code: errorCodes.DATABASE_ERROR,
        isOperational: false,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.parse.failed') {
      error = new ApiError(httpStatus.BAD_REQUEST, 'Request body is not valid JSON', {
        code: errorCodes.VALIDATION_ERROR,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.too.large') {
      error = new ApiError(httpStatus.PAYLOAD_TOO_LARGE, 'Request body is too large', {
        code: errorCodes.PAYLOAD_TOO_LARGE,
        stack: error.stack,
      });
    } else if (error && error.type === 'charset.unsupported') {
      error = new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Unsupported charset', {
        code: errorCodes.UNSUPPORTED_MEDIA_TYPE,
        stack: error.stack,
      });
    } else {
      const statusCode =
        error && typeof error.statusCode === 'number'
          ? error.statusCode
          : httpStatus.INTERNAL_SERVER_ERROR;
      const message = (error && error.message) || httpStatus.getStatusMessage(statusCode);
      error = new ApiError(statusCode, message, {
        code: errorCodes.INTERNAL_ERROR,
        isOperational: false,
        stack: error && error.stack,
      });
    }
  }

  next(error);
};

/**
 * Single place where an error becomes an HTTP response. Non-operational errors
 * are scrubbed in production so internals are never leaked to a client.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  const { code, details, isOperational } = err;

  if (config.isProduction && !isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = 'Internal server error';
  }

  res.locals.errorMessage = err.message;

  const response = {
    success: false,
    code: code || errorCodes.INTERNAL_ERROR,
    message,
    ...(details && details.length ? { details } : {}),
    requestId: req.id,
    ...(config.isProduction ? {} : { stack: err.stack }),
  };

  const logPayload = {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code: response.code,
    userId: req.principal ? req.principal.id : undefined,
  };

  if (statusCode >= httpStatus.INTERNAL_SERVER_ERROR) {
    logger.error(`${message} :: ${err.stack || ''}`, logPayload);
  } else {
    logger.warn(message, logPayload);
  }

  if (res.headersSent) {
    return next(err);
  }

  return res.status(statusCode).json(response);
};

module.exports = { errorConverter, errorHandler, notFoundHandler };
