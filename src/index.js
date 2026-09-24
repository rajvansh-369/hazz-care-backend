'use strict';

const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const database = require('./config/database');
const emailService = require('./services/email.service');
const revenueCatService = require('./services/revenueCat.service');
const { createShutdown } = require('./shutdown');

let server;

// Work that runs after its request has been answered, and must settle before exit.
const background = { idle: () => Promise.all([emailService.idle(), revenueCatService.idle()]) };

const shutdown = createShutdown({ getServer: () => server, background, database, logger });

const start = async () => {
  await database.connect();
  server = app.listen(config.port, () => {
    logger.info(`${config.serviceName} listening on port ${config.port} [${config.env}]`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`Port ${config.port} is already in use`);
    } else {
      logger.error(`HTTP server error: ${error.message}`);
    }
    process.exit(1);
  });

  return server;
};

// A crash must never leave the process in an undefined state: log, then exit so
// the orchestrator can replace the instance.
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.stack || error.message}`);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  shutdown('unhandledRejection', 1);
});

['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.on(signal, () => shutdown(signal, 0));
});

start().catch((error) => {
  logger.error(`Failed to start ${config.serviceName}: ${error.message}`);
  process.exit(1);
});

module.exports = { start, shutdown };
