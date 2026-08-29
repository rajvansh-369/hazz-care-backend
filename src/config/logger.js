'use strict';

const winston = require('winston');
const config = require('./config');

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    return Object.assign({}, info, { message: info.stack });
  }
  return info;
});

const developmentFormat = winston.format.combine(
  enumerateErrorFormat(),
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.splat(),
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
