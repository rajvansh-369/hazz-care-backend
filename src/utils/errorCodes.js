'use strict';

/**
 * The complete set of error codes this API may put on the wire. They are the
 * lowercase codes the Flutter client switches on (BACKEND_SPEC.md §3.2), plus
 * three transport codes. Adding a code is safe; renaming or removing one changes
 * app behaviour and needs a client release.
 */
module.exports = Object.freeze({
  email_taken: 'email_taken',
  invalid_credentials: 'invalid_credentials',
  account_not_found: 'account_not_found',
  invalid_reset_token: 'invalid_reset_token',
  too_many_attempts: 'too_many_attempts',
  otp_expired: 'otp_expired',
  invalid_otp: 'invalid_otp',
  invalid_input: 'invalid_input',
  password_too_short: 'password_too_short',
  email_invalid: 'email_invalid',
  session_revoked: 'session_revoked',
  unauthorized: 'unauthorized',
  unavailable: 'unavailable',
  not_found: 'not_found',
});
