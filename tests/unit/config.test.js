'use strict';

/**
 * Each pinned rule in src/config/config.js must refuse to start the process
 * rather than run with a value the client contract forbids.
 */

const { loadConfig } = require('../../src/config/config');

const SECRET = 'x'.repeat(32);

const validEnv = () => ({
  NODE_ENV: 'development',
  MONGODB_URL: 'mongodb://127.0.0.1:27017/hajjcare',
  JWT_ACCESS_SECRET: SECRET,
  OTP_HMAC_SECRET: SECRET,
  RC_WEBHOOK_SECRET: SECRET,
});

const load = (overrides) => {
  const env = { ...validEnv(), ...overrides };
  Object.keys(env).forEach((key) => env[key] === undefined && delete env[key]);
  return loadConfig(env);
};

describe('config', () => {
  test('a minimal valid environment loads, with contract defaults', () => {
    const config = load();
    expect(config.serviceName).toBe('hajjcare-api');
    expect(config.apiPrefix).toBe('/api/v1');
    expect(config.trustProxy).toBe(0);
    expect(config.jwt.accessTtlSeconds).toBe(900);
    expect(config.tokens).toEqual({ refreshTtlDays: 60, refreshRotationGraceSeconds: 60, resetTtlSeconds: 600 });
    expect(config.otp).toMatchObject({ ttlSeconds: 600, resendAfterSeconds: 60, length: 6, maxAttempts: 5, maxSendsPerHour: 5 });
    expect(config.security.passwordMinLength).toBe(8);
    expect(config.rateLimit.ipPerHour).toBe(300);
    expect(config.email).toMatchObject({ provider: 'dev', devDir: '.dev-emails' });
    expect(config.revenueCat.entitlementId).toBe('hajjcare_pass');
  });

  test('JWT_REFRESH_SECRET is not required (refresh tokens are opaque, not JWTs)', () => {
    expect(() => load({ JWT_REFRESH_SECRET: undefined })).not.toThrow();
  });

  test.each([
    ['JWT_ACCESS_SECRET missing', { JWT_ACCESS_SECRET: undefined }],
    ['JWT_ACCESS_SECRET shorter than 32', { JWT_ACCESS_SECRET: 'x'.repeat(31) }],
    ['OTP_HMAC_SECRET missing', { OTP_HMAC_SECRET: undefined }],
    ['OTP_HMAC_SECRET shorter than 32', { OTP_HMAC_SECRET: 'x'.repeat(31) }],
    ['refresh lifetime below 45 days', { JWT_REFRESH_EXPIRATION_DAYS: '44' }],
    ['OTP_LENGTH 4', { OTP_LENGTH: '4' }],
    ['OTP_LENGTH 8', { OTP_LENGTH: '8' }],
    ['OTP_MAX_ATTEMPTS below 5', { OTP_MAX_ATTEMPTS: '3' }],
    ['PASSWORD_MIN_LENGTH 7', { PASSWORD_MIN_LENGTH: '7' }],
    ['PASSWORD_MIN_LENGTH 10 (stricter than the client)', { PASSWORD_MIN_LENGTH: '10' }],
    ['production with EMAIL_PROVIDER dev', { NODE_ENV: 'production', EMAIL_PROVIDER: 'dev' }],
    ['production with EMAIL_PROVIDER left at its default', { NODE_ENV: 'production' }],
    ['smtp without SMTP_URL', { EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.co' }],
    ['smtp without EMAIL_FROM', { EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mail.example.com' }],
    ['an unknown EMAIL_PROVIDER', { EMAIL_PROVIDER: 'sendgrid' }],
    ['RC_WEBHOOK_HMAC_SECRET shorter than 32', { RC_WEBHOOK_HMAC_SECRET: 'short' }],
    ['a negative TRUST_PROXY', { TRUST_PROXY: '-1' }],
    ['an API_PREFIX without a leading slash', { API_PREFIX: 'api/v1' }],
  ])('refuses to start: %s', (_label, overrides) => {
    expect(() => load(overrides)).toThrow(/Invalid environment configuration/);
  });

  test('production with smtp, SMTP_URL and EMAIL_FROM loads', () => {
    const config = load({
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'smtp',
      SMTP_URL: 'smtp://mail.example.com:587',
      EMAIL_FROM: 'no-reply@hajjcare.example',
    });
    expect(config.isProduction).toBe(true);
    expect(config.email.provider).toBe('smtp');
  });

  test('OTP_MAX_ATTEMPTS above 5 is allowed', () => {
    expect(load({ OTP_MAX_ATTEMPTS: '6' }).otp.maxAttempts).toBe(6);
  });
});
