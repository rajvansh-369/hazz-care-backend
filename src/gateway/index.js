'use strict';

const gateway = require('./gateway');
const config = require('../config/config');
const logger = require('../config/logger');

const server = gateway.listen(config.gatewayPort, () => {
  logger.info(`api-gateway listening on port ${config.gatewayPort} [${config.env}]`);
  logger.info(`Test console: http://localhost:${config.gatewayPort}/`);
  logger.info(`Proxying ${config.apiPrefix}/* -> ${config.gateway.services.core}`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.gatewayPort} is already in use`);
  } else {
    logger.error(`Gateway server error: ${error.message}`);
  }
  process.exit(1);
});

const shutdown = (signal, exitCode = 0) => {
  logger.info(`${signal} received, stopping gateway`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  server.close(() => {
    logger.info('Gateway stopped');
    process.exit(exitCode);
  });
};

process.on('uncaughtException', (error) => {
  logger.error(`Gateway uncaught exception: ${error.stack || error.message}`);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Gateway unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  shutdown('unhandledRejection', 1);
});

['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal, 0)));

module.exports = server;
