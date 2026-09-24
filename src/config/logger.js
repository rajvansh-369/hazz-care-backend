'use strict';

const winston = require('winston');
const config = require('./config');
const { redactInfo } = require('./redact');

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    return Object.assign({}, info, { message: info.stack });
  }
  return info;
});

/**
 * Deep-redacts secrets (passwords, OTP codes, tokens, the Authorization header,
 * email addresses) anywhere in a logged object. Request bodies are never logged in
 * the first place.
 *
 * ORDER MATTERS: redaction must run AFTER every format that can add or restore
 * content. `splat()` re-applies the caller's original meta object onto the entry, and
 * `errors()` copies an Error's stack in; placed before them, redaction is undone.
 */
const redactFormat = winston.format((info) => redactInfo(info));

const developmentFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.splat(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  redactFormat(),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const context = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${context}`;
  })
);

/** Production logs are JSON so they can be shipped to any log aggregator as-is. */
const productionFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  redactFormat(),
  winston.format.json()
);

const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: { service: config.serviceName, env: config.env },
  format: config.isProduction ? productionFormat : developmentFormat,
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
      silent: config.isTest,
    }),
  ],
  exitOnError: false,
});

module.exports = logger;
// Exposed so tests can prove redaction under both formats, not just the one this
// process happens to run.
module.exports.formats = { developmentFormat, productionFormat };
