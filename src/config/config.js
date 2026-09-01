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
    API_PREFIX: Joi.string().default('/'),
    MONGODB_URL: Joi.string().required().description('MongoDB connection string'),
    MONGODB_REPLICA_SET: Joi.string().description('MongoDB replica set name for transactions'),
    MONGODB_AUTO_INDEX: Joi.boolean().default(true),
    JWT_ACCESS_SECRET: Joi.string()
      .min(32)
      .required()
      .description('Access token signing secret, minimum 32 characters'),
    JWT_REFRESH_SECRET: Joi.string()
      .min(32)
      .required()
      .description('Refresh token signing secret, minimum 32 characters'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(15),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().min(45).default(60),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number().default(10),
    BCRYPT_SALT_ROUNDS: Joi.number().min(10).max(15).default(12),
    RC_WEBHOOK_SECRET: Joi.string()
      .min(32)
      .required()
      .description('RevenueCat webhook shared secret'),
    CORS_ORIGINS: Joi.string()
      .default('*')
      .description('Comma separated list of allowed origins, or * for all'),
    TRUST_PROXY: Joi.number().min(0).default(1),
    BODY_LIMIT: Joi.string().default('100kb'),
    LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'debug').default('info'),
    SMTP_URL: Joi.string().uri(),
    MAIL_FROM: Joi.string().email(),
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
  port: envVars.PORT,
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
      ...(envVars.MONGODB_REPLICA_SET && { replicaSet: envVars.MONGODB_REPLICA_SET }),
    },
  },
  jwt: {
    accessSecret: envVars.JWT_ACCESS_SECRET,
    refreshSecret: envVars.JWT_REFRESH_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
  },
  security: {
    bcryptSaltRounds: envVars.BCRYPT_SALT_ROUNDS,
  },
  revenueCat: {
    webhookSecret: envVars.RC_WEBHOOK_SECRET,
  },
  mail: {
    smtp: envVars.SMTP_URL,
    from: envVars.MAIL_FROM,
  },
};
