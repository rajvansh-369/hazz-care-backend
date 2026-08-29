'use strict';

const mongoose = require('mongoose');
const config = require('./config');
const logger = require('./logger');

mongoose.set('strictQuery', true);
// NOTE: `sanitizeFilter` is deliberately NOT enabled globally - it would wrap
// every legitimate internal operator ($lt, $regex, ...) in $eq. Injection is
// blocked at the edges instead: express-mongo-sanitize strips `$`/`.` keys from
// request payloads and Joi rejects anything that is not the declared type.

let connectionPromise = null;

const registerConnectionEvents = () => {
  const { connection } = mongoose;
  connection.on('connected', () => logger.info('MongoDB connected'));
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (error) => logger.error(`MongoDB connection error: ${error.message}`));
};

/**
 * Connects to MongoDB exactly once per process and reuses the promise so that
 * concurrent callers (server bootstrap, tests) never open competing pools.
 */
const connect = async (url = config.mongoose.url, options = config.mongoose.options) => {
  if (connectionPromise) {
    return connectionPromise;
  }
  registerConnectionEvents();
  connectionPromise = mongoose.connect(url, options).then(() => mongoose.connection);
  try {
    return await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
};

const disconnect = async () => {
  connectionPromise = null;
  await mongoose.disconnect();
};

/** 1 === connected. Used by the readiness probe so orchestrators can gate traffic. */
const isConnected = () => mongoose.connection.readyState === 1;

module.exports = { connect, disconnect, isConnected, mongoose };
