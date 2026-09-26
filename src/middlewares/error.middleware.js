'use strict';

const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const errorCodes = require('../utils/errorCodes');
const { sendJson } = require('../utils/respond');

const KNOWN_CODES = new Set(Object.values(errorCodes));
const AUTH_PREFIX = `${config.apiPrefix.replace(/\/+$/, '')}/auth`.toLowerCase();

/** Routes on which the client reads 401/403 as "That email and password do not match". */
const NO_UNAUTHORIZED_ROUTES = new Set(['/register', '/forgot-password', '/verify-otp', '/reset-password']);
/** Routes on which the client's 429 wording ("ask for a new code") makes no sense. */
const NO_RATE_LIMIT_ROUTES = new Set(['/login', '/register']);

/**
 * The path below the auth router, e.g. "/login", or null when the request is not
 * under it. Express matches paths case-insensitively and ignores a trailing slash,
 * so this does too.
 */
const authSubPath = (req) => {
  const path = (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
  if (path === AUTH_PREFIX) {
    return '/';
  }
  if (!path.startsWith(`${AUTH_PREFIX}/`)) {
    return null;
  }
  const sub = path.slice(AUTH_PREFIX.length).replace(/\/+$/, '');
  return sub || '/';
};

/** Keeps only well-typed field errors: `field` and `code` strings, `message` a string or absent. */
const toWireFieldErrors = (fieldErrors) =>
  fieldErrors
    .filter((entry) => entry && typeof entry.field === 'string' && typeof entry.code === 'string')
    .map(({ field, code, message }) => ({
      field,
      code,
      ...(typeof message === 'string' ? { message } : {}),
    }));

const toBody = (apiError) => {
  const errors = toWireFieldErrors(apiError.fieldErrors);
  return { code: apiError.code, ...(errors.length ? { errors } : {}) };
};

/**
 * Last line of defence for the status-code landmines (CLAUDE.md A3). A handler
 * should never produce one of these; if it does, answering 503 is safe for the
 * pilgrim while the log tells us which rule was about to be broken.
 *
 * @returns {string|null} the violated rule, or null when the error may go out as is
 */
const contractViolation = (req, apiError) => {
  const { status, code } = apiError;
  if (!KNOWN_CODES.has(code)) {
    return `unknown error code "${code}"`;
  }
  if (status === 403) {
    return '403 is never sent';
  }
  if (status >= 500 && status !== 503) {
    return `${status} is never sent`;
  }
  const sub = authSubPath(req);
  if (sub === null) {
    return null;
  }
  if (status === 404) {
    return '404 under the auth router';
  }
  if (status === 409 && code !== errorCodes.email_taken) {
    return '409 under the auth router for something other than email_taken';
  }
  if (status === 401 && NO_UNAUTHORIZED_ROUTES.has(sub)) {
    return `401 on ${sub}`;
  }
  if (status === 401 && sub === '/refresh' && code !== errorCodes.session_revoked) {
    return '401 on /refresh without session_revoked';
  }
  if (status === 429 && NO_RATE_LIMIT_ROUTES.has(sub)) {
    return `429 on ${sub}`;
  }
  return null;
};

const logUnexpected = (req, err, reason) => {
  logger.error(reason, {
    requestId: req.id,
    method: req.method,
    path: (req.originalUrl || '').split('?')[0],
    errorName: err && err.name,
    errorCode: err && err.code !== undefined ? String(err.code) : undefined,
    stack: err && err.stack,
  });
};

/** The "scheme://authority" of an absolute-form request target (RFC 9112 §3.2.2). */
const ABSOLUTE_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/\\]*/i;

/**
 * The path of a request target as lowercase segments: query dropped, backslashes
 * read as "/", empty segments (a doubled "/") and "." dropped, ".." resolved, and
 * each segment trimmed. With `decode`, ASCII %XX escapes are decoded first; that can
 * never throw, because malformed and non-ASCII escapes are simply left as they are.
 */
const pathSegments = (target, { decode }) => {
  let path = String(target).replace(ABSOLUTE_FORM, '').split('?')[0];
  if (decode) {
    path = path.replace(/%([0-7][0-9a-f])/gi, (escape, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
  const segments = [];
  path
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .map((segment) => segment.trim())
    .forEach((segment) => {
      if (segment === '..') {
        segments.pop();
      } else if (segment !== '' && segment !== '.') {
        segments.push(segment);
      }
    });
  return segments;
};

/**
 * True when a request that matched no route was meant for the auth API: its path has
 * an "auth" segment anywhere, decoded or raw. That covers every spelling Express does
 * not route into the auth router (`//api/v1/auth/login`, `/api/v1/./auth/login`,
 * `/api/v1/%61uth/x`, `/api/v1/auth\x`) and a client built with the wrong base URL
 * (`/auth/login`, `/v1/auth/login`, `/api/v2/auth/login`); `${apiPrefix}/auth` is
 * just the common case. `/auths`, `/auth-login` and the like are not an auth segment.
 */
const isAuthLikePath = (target) =>
  pathSegments(target, { decode: true }).includes('auth') ||
  pathSegments(target, { decode: false }).includes('auth');

/**
 * Answers every request that matched no route. The auth router has its own 503
 * catch-all; this catches what never reached it. Anything that looks like an auth
 * request is 503 {"code":"unavailable"}, never 404: the client shows any 404 under
 * /auth as "We could not find an account for that email address", and on
 * forgot-password as a code that was sent (BACKEND_SPEC.md §3.2, CLAUDE.md A10 f).
 * Everything else is 404 {"code":"not_found"}.
 */
const notFoundHandler = (req, res) => {
  if (isAuthLikePath(req.originalUrl || req.url || '')) {
    return sendJson(res, 503, { code: errorCodes.unavailable });
  }
  return sendJson(res, 404, { code: errorCodes.not_found });
};

/**
 * Single place where an error becomes an HTTP response. Never defaults to 500, 401,
 * 403, 404 or 409: anything not explicitly recognised is 503 {"code":"unavailable"},
 * which the client treats as retryable and which never ends a session.
 */
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    logUnexpected(req, err, 'Error after the response was sent');
    return undefined;
  }

  // POST /auth/logout always answers 204 (BACKEND_SPEC.md §3.9) — including when the
  // body parser rejects the request before the handler runs (malformed or oversized).
  if (authSubPath(req) === '/logout') {
    logUnexpected(req, err, 'Error on /auth/logout; answering 204 anyway');
    return res.status(204).end();
  }

  if (err instanceof ApiError) {
    const violation = contractViolation(req, err);
    if (violation) {
      logUnexpected(req, err, `Contract guard: ${violation}`);
      return sendJson(res, 503, { code: errorCodes.unavailable });
    }
    return sendJson(res, err.status, toBody(err));
  }

  // body-parser: malformed JSON and oversized bodies are the client's fault, not ours.
  if (err && err.type === 'entity.parse.failed') {
    return sendJson(res, 400, { code: errorCodes.invalid_input });
  }
  if (err && err.type === 'entity.too.large') {
    return sendJson(res, 413, { code: errorCodes.invalid_input });
  }

  // A duplicate key that reaches this point was not claimed by the register service,
  // so it is a race or a bug — never "that email already has an account" (409).
  if (err && err.code === 11000) {
    logUnexpected(req, err, 'Unhandled duplicate key error');
    return sendJson(res, 503, { code: errorCodes.unavailable });
  }

  // A CastError is malformed input (an id that is not an ObjectId): 400, never the
  // 404 many boilerplates use — under /auth a 404 reads as "no account for that
  // email" (CLAUDE.md A3, A8 point 3). Logged, because a validator should have
  // caught it first.
  if (err && err.name === 'CastError') {
    logUnexpected(req, err, 'Unhandled Mongoose CastError');
    return sendJson(res, 400, { code: errorCodes.invalid_input });
  }

  // A ValidationError means our own validation let through something the schema
  // refuses: a server bug, not the pilgrim's input.
  if (err && err.name === 'ValidationError') {
    logUnexpected(req, err, 'Unhandled Mongoose ValidationError');
    return sendJson(res, 503, { code: errorCodes.unavailable });
  }

  logUnexpected(req, err, 'Unexpected error');
  return sendJson(res, 503, { code: errorCodes.unavailable });
};

module.exports = { errorHandler, notFoundHandler, authSubPath, isAuthLikePath };
