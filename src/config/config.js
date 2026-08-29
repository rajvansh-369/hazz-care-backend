'use strict';

const path = require('path');
const dotenv = require('dotenv');
const Joi = require('joi');

dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * Every environment variable the application depends on is declared and validated
 * here. The process fails fast when the environment is not usable, so a
 * misconfigured container never starts serving traffic.
 */
const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().port().default(5000),
    GATEWAY_PORT: Joi.number().port().default(8080),
    API_PREFIX: Joi.string().default('/api/v1'),
    SERVICE_NAME: Joi.string().default('core-service'),
    MONGODB_URL: Joi.string().required().description('MongoDB connection string'),
    MONGODB_AUTO_INDEX: Joi.boolean().default(true),
    JWT_SECRET: Joi.string()
      .min(32)
      .required()
      .description('JWT signing secret, minimum 32 characters'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(15),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number().default(10),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number().default(60),
    JWT_ISSUER: Joi.string().default('node-mongo-api-boilerplate'),
    JWT_AUDIENCE: Joi.string().default('node-mongo-api-boilerplate-clients'),
    BCRYPT_SALT_ROUNDS: Joi.number().min(10).max(15).default(12),
    LOGIN_MAX_ATTEMPTS: Joi.number().min(1).default(5),
    LOGIN_LOCK_MINUTES: Joi.number().min(1).default(15),
    RATE_LIMIT_WINDOW_MINUTES: Joi.number().default(15),
    RATE_LIMIT_MAX: Joi.number().default(300),
    AUTH_RATE_LIMIT_MAX: Joi.number().default(20),
    CORS_ORIGINS: Joi.string()
      .default('*')
      .description('Comma separated list of allowed origins, or * for all'),
    TRUST_PROXY: Joi.number().min(0).default(1),
    BODY_LIMIT: Joi.string().default('100kb'),
    LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),
    CORE_SERVICE_URL: Joi.string().uri().default('http://127.0.0.1:5000'),
    GATEWAY_PROXY_TIMEOUT_MS: Joi.number().default(30000),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: 'key' }, abortEarly: false })
  .validate(process.env);

if (error) {
  throw new Error(`Invalid environment configuration: ${error.message}`);
}

const parseOrigins = (origins) =>
  origins === '*'
    ? '*'
    : origins
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

module.exports = {
  env: envVars.NODE_ENV,
  isProduction: envVars.NODE_ENV === 'production',
  isTest: envVars.NODE_ENV === 'test',
  serviceName: envVars.SERVICE_NAME,
  port: envVars.PORT,
  gatewayPort: envVars.GATEWAY_PORT,
  apiPrefix: envVars.API_PREFIX,
  trustProxy: envVars.TRUST_PROXY,
  bodyLimit: envVars.BODY_LIMIT,
  logLevel: envVars.LOG_LEVEL,
  corsOrigins: parseOrigins(envVars.CORS_ORIGINS),
  mongoose: {
    url: envVars.MONGODB_URL,
    options: {
      autoIndex: envVars.MONGODB_AUTO_INDEX,
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 20,
      minPoolSize: 1,
    },
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    issuer: envVars.JWT_ISSUER,
    audience: envVars.JWT_AUDIENCE,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  security: {
    bcryptSaltRounds: envVars.BCRYPT_SALT_ROUNDS,
    loginMaxAttempts: envVars.LOGIN_MAX_ATTEMPTS,
    loginLockMinutes: envVars.LOGIN_LOCK_MINUTES,
  },
  rateLimit: {
    windowMs: envVars.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: envVars.RATE_LIMIT_MAX,
    authMax: envVars.AUTH_RATE_LIMIT_MAX,
  },
  gateway: {
    proxyTimeoutMs: envVars.GATEWAY_PROXY_TIMEOUT_MS,
    services: {
      core: envVars.CORE_SERVICE_URL,
    },
  },
};
