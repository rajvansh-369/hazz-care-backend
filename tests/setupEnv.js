'use strict';

/**
 * Runs before the test framework in every worker. Supplies a complete, valid
 * environment so `src/config/config.js` never falls back to a developer's local
 * `.env` while tests are running.
 */
const defaults = {
  NODE_ENV: 'test',
  PORT: '5099',
  API_PREFIX: '/api/v1',
  LOG_LEVEL: 'error',
  CORS_ORIGINS: '*',
  TRUST_PROXY: '0',
  MONGODB_AUTO_INDEX: 'false',
  JWT_ACCESS_SECRET: 'test-jwt-access-secret-value-that-is-long-enough-12345678901',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  JWT_REFRESH_EXPIRATION_DAYS: '60',
  REFRESH_ROTATION_GRACE_SECONDS: '60',
  RESET_TOKEN_TTL_SECONDS: '600',
  OTP_HMAC_SECRET: 'test-otp-hmac-secret-value-that-is-long-enough-1234567890',
  OTP_TTL_SECONDS: '600',
  OTP_RESEND_AFTER_SECONDS: '60',
  OTP_LENGTH: '6',
  OTP_MAX_ATTEMPTS: '5',
  OTP_MAX_SENDS_PER_HOUR: '5',
  PASSWORD_MIN_LENGTH: '8',
  // Keep hashing cheap so the suite stays fast; production uses 12.
  BCRYPT_SALT_ROUNDS: '10',
  RATE_LIMIT_IP_PER_HOUR: '300',
  EMAIL_PROVIDER: 'dev',
  EMAIL_FROM: 'no-reply@hajjcare.test',
  EMAIL_DEV_DIR: '.dev-emails',
  RC_WEBHOOK_SECRET: 'test-rc-webhook-secret-min-32-chars-required-here-1234567890123',
  RC_WEBHOOK_HMAC_SECRET: 'test-rc-webhook-hmac-secret-min-32-chars-required-12345678',
  HAJJCARE_ENTITLEMENT_ID: 'hajjcare_pass',
};

Object.entries(defaults).forEach(([key, value]) => {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
});

// NODE_ENV must be `test` even if the shell exported something else.
process.env.NODE_ENV = 'test';

if (!process.env.MONGODB_URL) {
  process.env.MONGODB_URL =
    process.env.MONGODB_URL_TEST || 'mongodb://127.0.0.1:27017/jest-fallback';
}
