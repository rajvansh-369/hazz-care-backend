'use strict';

/**
 * Deep redaction for anything that reaches the logger. Keys are matched
 * case-insensitively at any depth. `code` is here because it is the OTP code on
 * verify-otp; losing an error code from a log line is the cheaper mistake.
 */
const REDACTED_KEYS = new Set(
  ['password', 'code', 'refreshToken', 'accessToken', 'resetToken', 'authorization'].map((key) =>
    key.toLowerCase()
  )
);
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

const redactValue = (value, depth, seen) => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Date) {
    return value;
  }

  const out = {};
  const keys = value instanceof Error ? ['name', 'message', 'stack', ...Object.keys(value)] : Object.keys(value);
  keys.forEach((key) => {
    // Keys come from the object being logged, and are only copied, never executed.
    // eslint-disable-next-line security/detect-object-injection
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(value[key], depth + 1, seen);
  });
  return out;
};

/**
 * Redacts a winston `info` object in place. Winston keeps level and message under
 * Symbol keys, so the object itself must be preserved; only its string keys change.
 *
 * @param {object} info
 * @returns {object}
 */
const redactInfo = (info) => {
  const seen = new WeakSet([info]);
  Object.keys(info).forEach((key) => {
    // eslint-disable-next-line security/detect-object-injection
    info[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(info[key], 1, seen);
  });
  return info;
};

module.exports = { redactInfo, redactValue, REDACTED };
