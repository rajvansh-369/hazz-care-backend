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

module.exports = {
  CLIENT_EMAIL_PATTERN,
  normaliseEmail,
  register,
  login,
};
