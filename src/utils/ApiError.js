'use strict';

const errorCodes = require('./errorCodes');

/**
 * The single error type the application throws. It carries exactly what goes on
 * the wire: an HTTP status, a contract error code, and optional field errors
 * (BACKEND_SPEC.md §3.2). There is deliberately no default status or code — an
 * error that is not an ApiError is unexpected and becomes 503 in the error handler.
 *
 * @typedef {{ field: string, code: string, message?: string }} FieldError
 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP status to return.
   * @param {string} code One of `errorCodes`.
   * @param {FieldError[]} [fieldErrors]
   */
  constructor(status, code, fieldErrors = []) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = Array.isArray(fieldErrors) ? fieldErrors : [];
    Error.captureStackTrace(this, this.constructor);
  }

  static emailTaken() {
    return new ApiError(409, errorCodes.email_taken, [
      { field: 'email', code: errorCodes.email_taken },
    ]);
  }

  static invalidCredentials() {
    return new ApiError(401, errorCodes.invalid_credentials);
  }

  static passwordTooShort() {
    return new ApiError(422, errorCodes.invalid_input, [
      { field: 'password', code: errorCodes.password_too_short },
    ]);
  }

  static emailInvalid() {
    return new ApiError(422, errorCodes.invalid_input, [
      { field: 'email', code: errorCodes.email_invalid },
    ]);
  }

  static invalidInput() {
    return new ApiError(400, errorCodes.invalid_input);
  }

  static invalidOtp() {
    return new ApiError(400, errorCodes.invalid_otp, [
      { field: 'code', code: errorCodes.invalid_otp },
    ]);
  }

  static otpExpired() {
    return new ApiError(400, errorCodes.otp_expired, [
      { field: 'code', code: errorCodes.otp_expired },
    ]);
  }

  static invalidResetToken() {
    return new ApiError(400, errorCodes.invalid_reset_token, [
      { field: 'resetToken', code: errorCodes.invalid_reset_token },
    ]);
  }

  static tooManyAttempts() {
    return new ApiError(429, errorCodes.too_many_attempts);
  }

  /** Only `POST /auth/refresh` may use this: it signs the pilgrim out. */
  static sessionRevoked() {
    return new ApiError(401, errorCodes.session_revoked);
  }

  static unauthorized() {
    return new ApiError(401, errorCodes.unauthorized);
  }

  static unavailable() {
    return new ApiError(503, errorCodes.unavailable);
  }

  /** For use OUTSIDE the auth router only — a 404 under /auth lies to the pilgrim. */
  static notFound() {
    return new ApiError(404, errorCodes.not_found);
  }
}

module.exports = ApiError;
