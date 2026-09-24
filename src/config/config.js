'use strict';

const path = require('path');
const dotenv = require('dotenv');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const SERVICE_NAME = 'hajjcare-api';

/**
 * Every environment variable the application depends on is declared and validated
 * here. The process fails fast when the environment is not usable, so a
 * misconfigured container never starts serving traffic.
 *
 * Several values are pinned rather than merely defaulted, because the shipped client
 * depends on them (BACKEND_SPEC.md): OTP_LENGTH must be 6, PASSWORD_MIN_LENGTH must be
 * 8, refresh tokens must live at least 45 days, and OTP_MAX_ATTEMPTS may not drop
 * below 5.
 */
const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().port().default(5000),
    API_PREFIX: Joi.string().pattern(/^\//).default('/api/v1'),
    LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),
    CORS_ORIGINS: Joi.string()
      .default('*')
      .description('Comma separated list of allowed origins, or * for all'),
    TRUST_PROXY: Joi.number().integer().min(0).default(0),

    MONGODB_URL: Joi.string().required().description('MongoDB connection string'),
    MONGODB_REPLICA_SET: Joi.string().description('MongoDB replica set name for transactions'),
    MONGODB_AUTO_INDEX: Joi.boolean().default(true),

    JWT_ACCESS_SECRET: Joi.string()
      .min(32)
      .required()
      .description('Access token signing secret, minimum 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).default(900),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number()
      .integer()
      .min(45)
      .default(60)
      .description('Refresh token lifetime; the client assumes at least 45 days offline'),
    REFRESH_ROTATION_GRACE_SECONDS: Joi.number().integer().min(0).default(60),
    RESET_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).default(600),

    OTP_HMAC_SECRET: Joi.string()
      .min(32)
      .required()
      .description('Server secret for HMAC-SHA256 of OTP codes, minimum 32 characters'),
    OTP_TTL_SECONDS: Joi.number().integer().min(60).default(600),
    OTP_RESEND_AFTER_SECONDS: Joi.number().integer().min(0).default(60),
    OTP_LENGTH: Joi.number().valid(6).default(6),
    OTP_MAX_ATTEMPTS: Joi.number().integer().min(5).default(5),
    OTP_MAX_SENDS_PER_HOUR: Joi.number().integer().min(1).default(5),

    PASSWORD_MIN_LENGTH: Joi.number().valid(8).default(8),

    RATE_LIMIT_IP_PER_HOUR: Joi.number().integer().min(1).default(300),

    EMAIL_PROVIDER: Joi.string()
      .valid('dev', 'smtp')
      .default('dev')
      .when('NODE_ENV', {
        is: 'production',
        // Joi.override replaces the allowed set (a bare valid('smtp') would add to it),
        // and required() stops the unvalidated 'dev' default applying in production.
        then: Joi.valid(Joi.override, 'smtp').required().messages({
          'any.only': '"EMAIL_PROVIDER" must be smtp when NODE_ENV is production',
        }),
      }),
    EMAIL_FROM: Joi.string()
      .email({ tlds: { allow: false } })
      .when('EMAIL_PROVIDER', { is: 'smtp', then: Joi.required() }),
    EMAIL_DEV_DIR: Joi.string().default('.dev-emails'),
    SMTP_URL: Joi.string()
      .uri()
      .when('EMAIL_PROVIDER', { is: 'smtp', then: Joi.required() }),

    RC_WEBHOOK_SECRET: Joi.string()
      .min(32)
      .required()
      .description('RevenueCat webhook shared secret'),
    RC_WEBHOOK_HMAC_SECRET: Joi.string()
      .min(32)
      .description('RevenueCat webhook HMAC signing secret'),
    HAJJCARE_ENTITLEMENT_ID: Joi.string().default('hajjcare_pass'),
  })
  .unknown();

const parseOrigins = (origins) =>
  origins === '*'
    ? '*'
    : origins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

/**
 * Validates an environment and builds the config object. Exposed so tests can
 * prove that each pinned rule refuses to start the process.
 *
 * @param {object} env
 * @returns {object}
 */
const loadConfig = (env) => {
  const { value: envVars, error } = envVarsSchema
    .prefs({ errors: { label: 'key' }, abortEarly: false })
    .validate(env);

  if (error) {
    throw new Error(`Invalid environment configuration: ${error.message}`);
  }

  return {
    serviceName: SERVICE_NAME,
    env: envVars.NODE_ENV,
    isProduction: envVars.NODE_ENV === 'production',
    isTest: envVars.NODE_ENV === 'test',
    port: envVars.PORT,
    apiPrefix: envVars.API_PREFIX,
    trustProxy: envVars.TRUST_PROXY,
    logLevel: envVars.LOG_LEVEL,
    corsOrigins: parseOrigins(envVars.CORS_ORIGINS),
    mongoose: {
      url: envVars.MONGODB_URL,
      options: {
        autoIndex: envVars.MONGODB_AUTO_INDEX,
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 20,
        minPoolSize: 1,
        ...(envVars.MONGODB_REPLICA_SET && { replicaSet: envVars.MONGODB_REPLICA_SET }),
      },
    },
    jwt: {
      accessSecret: envVars.JWT_ACCESS_SECRET,
      accessTtlSeconds: envVars.ACCESS_TOKEN_TTL_SECONDS,
    },
    tokens: {
      refreshTtlDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
      refreshRotationGraceSeconds: envVars.REFRESH_ROTATION_GRACE_SECONDS,
      resetTtlSeconds: envVars.RESET_TOKEN_TTL_SECONDS,
    },
    otp: {
      hmacSecret: envVars.OTP_HMAC_SECRET,
      ttlSeconds: envVars.OTP_TTL_SECONDS,
      resendAfterSeconds: envVars.OTP_RESEND_AFTER_SECONDS,
      length: envVars.OTP_LENGTH,
      maxAttempts: envVars.OTP_MAX_ATTEMPTS,
      maxSendsPerHour: envVars.OTP_MAX_SENDS_PER_HOUR,
    },
    security: {
      passwordMinLength: envVars.PASSWORD_MIN_LENGTH,
    },
    rateLimit: {
      ipPerHour: envVars.RATE_LIMIT_IP_PER_HOUR,
    },
    email: {
      provider: envVars.EMAIL_PROVIDER,
      from: envVars.EMAIL_FROM,
      devDir: envVars.EMAIL_DEV_DIR,
      smtpUrl: envVars.SMTP_URL,
    },
    revenueCat: {
      webhookSecret: envVars.RC_WEBHOOK_SECRET,
      webhookHmacSecret: envVars.RC_WEBHOOK_HMAC_SECRET,
      entitlementId: envVars.HAJJCARE_ENTITLEMENT_ID,
    },
  };
};

module.exports = loadConfig(process.env);
module.exports.loadConfig = loadConfig;
