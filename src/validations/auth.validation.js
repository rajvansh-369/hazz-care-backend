'use strict';

const config = require('../config/config');
const ApiError = require('../utils/ApiError');
const errorCodes = require('../utils/errorCodes');
const { isPlainObject } = require('../utils/respond');

/**
 * Explicit request validation for the auth routes. Each failure maps to the codes
 * the client's screens switch on (BACKEND_SPEC.md §3.2, §3.3); Joi's error format
 * and the generic invalid_input-without-fields never reach these routes. Unknown
 * body keys are ignored.
 *
 * The server is never stricter than the client: same email pattern, password
 * min 8 by JS `.length` (UTF-16 code units, like Dart's String.length), never
 * trimmed, no maximum, no composition rules.
 */

// eslint-disable-next-line security/detect-unsafe-regex -- the repeated group starts with a literal "." its body cannot contain, so it cannot backtrack
const CLIENT_EMAIL_PATTERN = /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/;

const bodyOf = (body) => (isPlainObject(body) ? body : {});

/** Trim + lowercase, exactly as register stores it. */
const normaliseEmail = (email) => email.trim().toLowerCase();

const fieldError = (field, code) => ({ field, code });

/**
 * @param {unknown} body
 * @returns {{ email: string, password: string, fullName: string|null }}
 */
const register = (body) => {
  const { email, password, fullName } = bodyOf(body);
  const errors = [];

  let normalisedEmail = null;
  if (typeof email === 'string' && CLIENT_EMAIL_PATTERN.test(email.trim())) {
    normalisedEmail = normaliseEmail(email);
  } else {
    errors.push(fieldError('email', errorCodes.email_invalid));
  }

  if (typeof password !== 'string' || password.length < config.security.passwordMinLength) {
    errors.push(fieldError('password', errorCodes.password_too_short));
  }

  let normalisedName = null;
  if (typeof fullName === 'string') {
    normalisedName = fullName.trim() || null;
  } else if (fullName !== undefined && fullName !== null) {
    errors.push(fieldError('fullName', errorCodes.invalid_input));
  }

  if (errors.length) {
    throw new ApiError(422, errorCodes.invalid_input, errors);
  }
  return { email: normalisedEmail, password, fullName: normalisedName };
};

/**
 * No email pattern here: a pilgrim who registered with an address must always be
 * able to sign in with it. No field routing either; the sign-in screen shows a banner.
 *
 * @param {unknown} body
 * @returns {{ email: string, password: string }}
 */
const login = (body) => {
  const { email, password } = bodyOf(body);
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new ApiError(422, errorCodes.invalid_input);
  }
  return { email: normaliseEmail(email), password };
};

/**
 * Does not throw: on POST /auth/refresh the handler decides every status itself,
 * because a 401/403 there signs the pilgrim out (BACKEND_SPEC.md §3.5).
 *
 * @param {unknown} body
 * @returns {string|null} the refresh token, or null when missing, not a string, or ""
 */
const refresh = (body) => {
  const { refreshToken } = bodyOf(body);
  return typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null;
};

/**
 * Does not throw: logout always answers 204. `{"refreshToken": ""}` is normal — a
 * session signed in without "Keep me signed in" has no token to send (§3.9).
 *
 * @param {unknown} body
 * @returns {string|null} a token worth revoking, or null when there is nothing to do
 */
const logout = (body) => refresh(body);

/**
 * Same address rule as register: trimmed, the client's pattern, then lowercased.
 * @param {unknown} body
 * @returns {{ email: string }}
 * @throws {ApiError} 422 invalid_input, field email = email_invalid
 */
const forgotPassword = (body) => {
  const { email } = bodyOf(body);
  if (typeof email !== 'string' || !CLIENT_EMAIL_PATTERN.test(email.trim())) {
    throw ApiError.emailInvalid();
  }
  return { email: normaliseEmail(email) };
};

const OTP_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * Rejected here, before the OTP service, so a malformed request consumes no attempt.
 * The app always sends exactly six ASCII digits (§3.7).
 *
 * @param {unknown} body
 * @returns {{ email: string, code: string }}
 * @throws {ApiError} 400 invalid_otp, field code = invalid_otp
 */
const verifyOtp = (body) => {
  const { email, code } = bodyOf(body);
  if (typeof email !== 'string' || typeof code !== 'string' || !OTP_CODE_PATTERN.test(code)) {
    throw ApiError.invalidOtp();
  }
  return { email, code };
};

/**
 * The first half of reset-password: the token's shape. Checked before the password,
 * so a pilgrim with a dead token is not asked to fix a password for nothing.
 *
 * @param {unknown} body
 * @returns {string}
 * @throws {ApiError} 400 invalid_reset_token, field resetToken
 */
const resetToken = (body) => {
  const { resetToken: token } = bodyOf(body);
  if (typeof token !== 'string' || token.length === 0) {
    throw ApiError.invalidResetToken();
  }
  return token;
};

/**
 * The second half of reset-password: same rule as register — min 8 by `.length`,
 * never trimmed, no maximum, no composition rules.
 *
 * @param {unknown} body
 * @returns {string}
 * @throws {ApiError} 422 invalid_input, field password = password_too_short
 */
const newPassword = (body) => {
  const { password } = bodyOf(body);
  if (typeof password !== 'string' || password.length < config.security.passwordMinLength) {
    throw ApiError.passwordTooShort();
  }
  return password;
};

module.exports = {
  CLIENT_EMAIL_PATTERN,
  normaliseEmail,
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  verifyOtp,
  resetToken,
  newPassword,
};
