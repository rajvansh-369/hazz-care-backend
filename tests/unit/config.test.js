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

    test('the Gmail staging shape loads: smtps:// with a %40-encoded username, and a display-name sender', () => {
      const smtpUrl = 'smtps://pilgrim.ops%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465';
      const config = production({ SMTP_URL: smtpUrl, EMAIL_FROM: 'HajjCare <pilgrim.ops@gmail.com>' });
      expect(config.email.smtpUrl).toBe(smtpUrl);
      expect(config.email.from).toBe('HajjCare <pilgrim.ops@gmail.com>');

      // And nodemailer (which sends with it) decodes it to the Gmail account and implicit TLS.
      // eslint-disable-next-line global-require
      const transport = require('nodemailer').createTransport(smtpUrl);
      expect(transport.options).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
      expect(transport.options.auth).toEqual({ user: 'pilgrim.ops@gmail.com', pass: 'abcdefghijklmnop' });
    });

    test('the port-587 fallback (outbound 465 blocked) loads and requires STARTTLS', () => {
      const smtpUrl = 'smtp://pilgrim.ops%40gmail.com:abcdefghijklmnop@smtp.gmail.com:587?requireTLS=true';
      expect(production({ SMTP_URL: smtpUrl }).email.smtpUrl).toBe(smtpUrl);
      // eslint-disable-next-line global-require
      const transport = require('nodemailer').createTransport(smtpUrl);
      expect(transport.options).toMatchObject({ port: 587, secure: false, requireTLS: true });
      expect(transport.options.auth.user).toBe('pilgrim.ops@gmail.com');
    });

    test.each([
      ['a bare address', 'no-reply@hajjcare.example'],
      ['Name <address>', 'HajjCare <no-reply@hajjcare.example>'],
      ['"Quoted Name" <address>', '"HajjCare Staging" <no-reply@hajjcare.example>'],
    ])('EMAIL_FROM accepts %s', (_label, from) => {
      expect(production({ EMAIL_FROM: from }).email.from).toBe(from);
    });

    test.each([
      ['a name alone', 'HajjCare'],
      ['a bad address in brackets', 'HajjCare <not-an-address>'],
      ['an unclosed bracket', 'HajjCare <no-reply@hajjcare.example'],
      ['empty brackets', 'HajjCare <>'],
    ])('EMAIL_FROM refuses %s', (_label, from) => {
      expect(() => production({ EMAIL_FROM: from })).toThrow(/EMAIL_FROM" must be an address or "Display Name <address>"/);
    });

    describe('.env.production.example, as docker-compose.prod.yml supplies it', () => {
      // eslint-disable-next-line global-require
      const fs = require('fs');
      // eslint-disable-next-line global-require
      const path = require('path');
      // eslint-disable-next-line global-require
      const dotenv = require('dotenv');
      const example = dotenv.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', '.env.production.example'), 'utf8')
      );
      // docker-compose.prod.yml's `environment:` block, which wins over the env file.
      const composeEnvironment = {
        NODE_ENV: 'production',
        PORT: '5000',
        MONGODB_URL: 'mongodb://mongo:27017/hajjcare?replicaSet=rs0',
        TRUST_PROXY: '1',
      };

      test('refuses to start while the CHANGE_ME placeholders are still there', () => {
        let message = '';
        try {
          loadConfig({ ...example, ...composeEnvironment });
        } catch (error) {
          ({ message } = error);
        }
        ['JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET', 'RC_WEBHOOK_SECRET'].forEach((key) =>
          expect(message).toContain(`"${key}" length must be at least 32`)
        );
      });

      test('loads once the secrets are filled in, with the Gmail SMTP shape unchanged', () => {
        const secret = 'q'.repeat(64);
        const config = loadConfig({
          ...example,
          JWT_ACCESS_SECRET: secret,
          OTP_HMAC_SECRET: secret,
          RC_WEBHOOK_SECRET: secret,
          ...composeEnvironment,
        });
        expect(config.isProduction).toBe(true);
        expect(config.trustProxy).toBe(1);
        expect(config.email.smtpUrl).toMatch(/^smtps:\/\/YOUR_ADDRESS%40gmail\.com:.*@smtp\.gmail\.com:465$/);
        expect(config.email.from).toBe('HajjCare <YOUR_ADDRESS@gmail.com>');
      });
    });

    test('a standalone URL is still fine outside production (dev, test)', () => {
      expect(() => load({ MONGODB_URL: 'mongodb://127.0.0.1:27017/hajjcare' })).not.toThrow();
    });
  });

  test('OTP_MAX_ATTEMPTS above 5 is allowed', () => {
    expect(load({ OTP_MAX_ATTEMPTS: '6' }).otp.maxAttempts).toBe(6);
  });
});
