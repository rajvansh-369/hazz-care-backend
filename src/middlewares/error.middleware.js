'use strict';

const mongoose = require('mongoose');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const notFoundHandler = (req, res, next) => {
  if (req.path.startsWith('/auth')) {
    return next(
      new ApiError(httpStatus.BAD_REQUEST, 'Invalid request', {
        code: errorCodes.bad_request,
      })
    );
  }
  next(
    new ApiError(httpStatus.NOT_FOUND, 'Not found', {
      code: errorCodes.not_found,
    })
  );
};

const fromMongooseValidationError = (error) => {
  const details = Object.values(error.errors || {}).map((fieldError) => ({
    field: fieldError.path,
    code: errorCodes.invalid_input,
    message: fieldError.message,
  }));
  return new ApiError(httpStatus.UNPROCESSABLE_ENTITY, 'Invalid input', {
    code: errorCodes.invalid_input,
    details,
    stack: error.stack,
  });
};

const fromDuplicateKeyError = (error, req) => {
  const field = Object.keys(error.keyPattern || error.keyValue || { field: 1 })[0];
  // ONLY User.email on register → 409 email_taken
  if (field === 'email' && req.path === '/register') {
    return new ApiError(httpStatus.CONFLICT, 'Email already registered', {
      code: errorCodes.email_taken,
      details: [{ field: 'email', code: errorCodes.email_taken, message: 'Email already registered' }],
      stack: error.stack,
    });
  }
  // ANY other E11000 (Token.tokenHash, RevenueCatEvent._id, etc.) → 500 server_error, never 409
  return new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database error', {
    code: errorCodes.server_error,
    isOperational: false,
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
      // CastError (malformed ObjectId) → 400, never 404
      error = new ApiError(httpStatus.BAD_REQUEST, 'Invalid input', {
        code: errorCodes.invalid_input,
        details: [{ field: error.path, code: errorCodes.invalid_input, message: 'Invalid input' }],
        stack: error.stack,
      });
    } else if (error && (error.code === 11000 || error.code === 11001)) {
      error = fromDuplicateKeyError(error, req);
    } else if (error instanceof mongoose.Error) {
      error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Database operation failed', {
        code: errorCodes.invalid_input,
        isOperational: false,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.parse.failed') {
      error = new ApiError(httpStatus.BAD_REQUEST, 'Request body is not valid JSON', {
        code: errorCodes.invalid_input,
        stack: error.stack,
      });
    } else if (error && error.type === 'entity.too.large') {
      error = new ApiError(httpStatus.PAYLOAD_TOO_LARGE, 'Request body is too large', {
        code: errorCodes.payload_too_large,
        stack: error.stack,
      });
    } else if (error && error.type === 'charset.unsupported') {
      error = new ApiError(httpStatus.UNSUPPORTED_MEDIA_TYPE, 'Unsupported charset', {
        code: errorCodes.unsupported_media_type,
        stack: error.stack,
      });
    } else {
      // Unrecognized error: log it, return 500 server_error
      error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Internal server error', {
        code: errorCodes.server_error,
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
 * Response format per BACKEND_SPEC.md: {code, errors: [{field, code, message}]}
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  let { code, details = [], isOperational } = err;

  if (config.isProduction && !isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = 'Internal server error';
  }

  res.locals.errorMessage = err.message;

  // CLAUDE.md §A3 rules 1-2: Never 404 or 409 under /auth except email_taken on register.
  // Transform computed errors to prevent client misinterpretation.
  if (req.path.startsWith('/auth')) {
    if (statusCode === httpStatus.NOT_FOUND) {
      statusCode = httpStatus.BAD_REQUEST;
      code = errorCodes.bad_request;
    } else if (statusCode === httpStatus.CONFLICT && code !== errorCodes.email_taken) {
      statusCode = httpStatus.BAD_REQUEST;
      code = errorCodes.bad_request;
    }
  }

  const response = {
    code: code || errorCodes.invalid_input,
    ...(details && details.length ? { errors: details } : {}),
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
