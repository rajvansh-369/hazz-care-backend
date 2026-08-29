'use strict';

const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');
const database = require('./config/database');

let server;

const shutdown = async (signal, exitCode = 0) => {
  logger.info(`${signal} received, shutting down gracefully`);
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed');
    }
    await database.disconnect();
    logger.info('MongoDB connection closed');
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error(`Error during shutdown: ${error.message}`);
    process.exit(1);
  }
};

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
