'use strict';

const httpStatus = require('./httpStatus');
const errorCodes = require('./errorCodes');

/**
 * The single error type the application throws. Anything that reaches the error
 * handler as a plain Error is treated as a non-operational bug and reported as a
 * 500 without leaking internals.
 */
class ApiError extends Error {
  /**
   * @param {number} statusCode HTTP status to return.
   * @param {string} message Human readable message, safe to show to a client.
   * @param {object} [options]
   * @param {string} [options.code] Stable machine readable error code.
   * @param {Array<{field: string, message: string}>} [options.details] Field level details.
   * @param {boolean} [options.isOperational] False for programmer errors.
   * @param {string} [options.stack] Preserve an original stack when re-wrapping.
   */
  constructor(statusCode, message, options = {}) {
    super(message);
    const {
      code = errorCodes.INTERNAL_ERROR,
      details = [],
      isOperational = true,
      stack = '',
    } = options;

    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  static badRequest(message = 'Bad request', options = {}) {
    return new ApiError(httpStatus.BAD_REQUEST, message, {
      code: errorCodes.VALIDATION_ERROR,
      ...options,
    });
  }

  static unauthorized(message = 'Authentication required', options = {}) {
    return new ApiError(httpStatus.UNAUTHORIZED, message, {
      code: errorCodes.UNAUTHENTICATED,
      ...options,
    });
  }

  static forbidden(message = 'You do not have permission to perform this action', options = {}) {
    return new ApiError(httpStatus.FORBIDDEN, message, { code: errorCodes.FORBIDDEN, ...options });
  }

  static notFound(message = 'Resource not found', options = {}) {
    return new ApiError(httpStatus.NOT_FOUND, message, {
      code: errorCodes.RESOURCE_NOT_FOUND,
      ...options,
    });
  }

  static conflict(message = 'Resource already exists', options = {}) {
    return new ApiError(httpStatus.CONFLICT, message, {
      code: errorCodes.DUPLICATE_RESOURCE,
      ...options,
    });
  }

  static internal(message = 'Something went wrong', options = {}) {
    return new ApiError(httpStatus.INTERNAL_SERVER_ERROR, message, {
      code: errorCodes.INTERNAL_ERROR,
      isOperational: false,
      ...options,
    });
  }
}

module.exports = ApiError;
