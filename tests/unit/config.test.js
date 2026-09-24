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
    ['smtp without SMTP_URL', { EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.co' }],
    ['smtp without EMAIL_FROM', { EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mail.example.com' }],
    ['an unknown EMAIL_PROVIDER', { EMAIL_PROVIDER: 'sendgrid' }],
    ['RC_WEBHOOK_HMAC_SECRET shorter than 32', { RC_WEBHOOK_HMAC_SECRET: 'short' }],
    ['a negative TRUST_PROXY', { TRUST_PROXY: '-1' }],
    ['an API_PREFIX without a leading slash', { API_PREFIX: 'api/v1' }],
  ])('refuses to start: %s', (_label, overrides) => {
    expect(() => load(overrides)).toThrow(/Invalid environment configuration/);
  });

  describe('production', () => {
    // Everything production needs; each case below breaks exactly one rule.
    const production = (overrides = {}) =>
      load({
        NODE_ENV: 'production',
        MONGODB_URL: 'mongodb://db1.internal:27017/hajjcare?replicaSet=rs0',
        EMAIL_PROVIDER: 'smtp',
        SMTP_URL: 'smtp://mail.example.com:587',
        EMAIL_FROM: 'no-reply@hajjcare.example',
        ...overrides,
      });

    test('smtp, SMTP_URL, EMAIL_FROM and a replica-set URL load', () => {
      const config = production();
      expect(config.isProduction).toBe(true);
      expect(config.email.provider).toBe('smtp');
    });

    test.each([
      ['EMAIL_PROVIDER dev', { EMAIL_PROVIDER: 'dev' }, /EMAIL_PROVIDER/],
      ['EMAIL_PROVIDER left at its default', { EMAIL_PROVIDER: undefined }, /EMAIL_PROVIDER/],
      ['smtp without SMTP_URL', { SMTP_URL: undefined }, /SMTP_URL/],
    ])('refuses to start: %s', (_label, overrides, key) => {
      expect(() => production(overrides)).toThrow(key);
    });

    test.each([
      ['mongodb+srv:// (Atlas)', 'mongodb+srv://user:pass@cluster0.abcde.mongodb.net/hajjcare?retryWrites=true&w=majority'],
      ['replicaSet= as the first parameter', 'mongodb://mongo:27017/hajjcare?replicaSet=rs0'],
      ['replicaSet= after other parameters', 'mongodb://a:27017,b:27017/hajjcare?authSource=admin&replicaSet=rs0'],
    ])('accepts a replica-set MONGODB_URL: %s', (_label, url) => {
      expect(production({ MONGODB_URL: url }).mongoose.url).toBe(url);
    });

    test.each([
      ['a standalone URL', 'mongodb://127.0.0.1:27017/hajjcare'],
      ['other parameters but no replicaSet', 'mongodb://mongo:27017/hajjcare?authSource=admin'],
      ['an empty replicaSet', 'mongodb://mongo:27017/hajjcare?replicaSet='],
      ['replicaSet in the path, not the query', 'mongodb://mongo:27017/replicaSet=rs0'],
    ])('refuses to start (transactions need a replica set): %s', (_label, url) => {
      expect(() => production({ MONGODB_URL: url })).toThrow(
        /MONGODB_URL" must be a mongodb\+srv:\/\/ URL or include replicaSet=/
      );
    });

    test('a standalone URL is still fine outside production (dev, test)', () => {
      expect(() => load({ MONGODB_URL: 'mongodb://127.0.0.1:27017/hajjcare' })).not.toThrow();
    });
  });

  test('OTP_MAX_ATTEMPTS above 5 is allowed', () => {
    expect(load({ OTP_MAX_ATTEMPTS: '6' }).otp.maxAttempts).toBe(6);
  });
});
