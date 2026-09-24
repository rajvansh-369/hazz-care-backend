'use strict';

const errorCodes = require('../utils/errorCodes');
const { sendJson } = require('../utils/respond');

/**
 * Stubs. Each handler answers 503 {"code":"unavailable"} until the session that
 * implements it lands — never 200 {}, which the client fails to parse as a session.
 * 503 is retryable on the client and never ends a session.
 *
 * When a handler is implemented it must read `req.body || {}`, so a request that
 * reached it without a parsed body cannot throw a TypeError. The stubs read nothing.
 */
const notImplemented = (req, res) => sendJson(res, 503, { code: errorCodes.unavailable });

module.exports = {
  register: notImplemented,
  login: notImplemented,
  refresh: notImplemented,
  forgotPassword: notImplemented,
  verifyOtp: notImplemented,
  resetPassword: notImplemented,
  logout: notImplemented,
  me: notImplemented,
};
