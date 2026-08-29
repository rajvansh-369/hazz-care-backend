'use strict';

/**
 * Runs before the test framework in every worker. Supplies a complete, valid
 * environment so `src/config/config.js` never falls back to a developer's local
 * `.env` while tests are running.
 */
const defaults = {
  NODE_ENV: 'test',
  PORT: '5099',
  GATEWAY_PORT: '8099',
  API_PREFIX: '/api/v1',
  SERVICE_NAME: 'core-service-test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-value-that-is-long-enough-1234567890',
  JWT_ACCESS_EXPIRATION_MINUTES: '15',
  JWT_REFRESH_EXPIRATION_DAYS: '30',
  JWT_RESET_PASSWORD_EXPIRATION_MINUTES: '10',
  JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: '60',
  // Keep hashing cheap so the suite stays fast; production uses 12.
  BCRYPT_SALT_ROUNDS: '10',
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_LOCK_MINUTES: '15',
  MONGODB_AUTO_INDEX: 'false',
  CORS_ORIGINS: '*',
  TRUST_PROXY: '1',
  CORE_SERVICE_URL: 'http://127.0.0.1:5099',
  GATEWAY_PROXY_TIMEOUT_MS: '3000',
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
