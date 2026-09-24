'use strict';

/**
 * Graceful shutdown for SIGTERM / SIGINT, in this order:
 *
 *   1. Stop accepting connections. In-flight requests run to completion; idle
 *      keep-alive sockets are closed so they cannot hold the server open.
 *   2. Wait for queued OTP emails to settle, for at most `emailIdleCapMs`. An email
 *      that misses the cap is lost; the pilgrim recovers with the Resend button.
 *   3. Close the Mongoose connection (after the requests, which still need it).
 *   4. Exit with `exitCode`.
 *
 * A second signal while this runs exits immediately. `forceExitMs` is the backstop
 * for a request or a driver that never finishes; the platform's stop grace period
 * must be longer than it (docs/DEPLOY.md).
 */
const IDLE_SWEEP_MS = 100;

const createShutdown = ({
  getServer,
  emailService,
  database,
  logger,
  exit = (code) => process.exit(code),
  emailIdleCapMs = 10000,
  forceExitMs = 30000,
}) => {
  let inProgress = false;

  // close() drops the sockets that are idle at that moment, but a keep-alive socket
  // that finishes its in-flight request afterwards would sit idle until
  // keepAliveTimeout (65s) and hold the server open. Sweep until close completes.
  const closeServer = (server) =>
    new Promise((resolve, reject) => {
      const sweep = setInterval(() => server.closeIdleConnections(), IDLE_SWEEP_MS);
      sweep.unref();
      server.close((error) => {
        clearInterval(sweep);
        return error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve();
      });
      server.closeIdleConnections();
    });

  /** Resolves true when `promise` settles in time, false when the cap wins. */
  const settlesWithin = (promise, ms) => {
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    });
    const settled = promise.then(
      () => true,
      () => true
    );
    return Promise.race([settled, cap]).finally(() => clearTimeout(timer));
  };

  return async (signal, exitCode = 0) => {
    if (inProgress) {
      logger.warn(`${signal} received during shutdown, exiting immediately`);
      exit(1);
      return;
    }
    inProgress = true;
    logger.info(`${signal} received, shutting down gracefully`);

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      exit(1);
    }, forceExitMs);
    forceExit.unref();

    try {
      const server = getServer();
      if (server) {
        await closeServer(server);
        logger.info('HTTP server closed');
      }
      const emailsSent = await settlesWithin(emailService.idle(), emailIdleCapMs);
      if (!emailsSent) {
        logger.warn(`Queued emails still pending after ${emailIdleCapMs}ms, abandoning them`);
      }
      await database.disconnect();
      logger.info('MongoDB connection closed');
      clearTimeout(forceExit);
      exit(exitCode);
    } catch (error) {
      clearTimeout(forceExit);
      logger.error(`Error during shutdown: ${error.message}`);
      exit(1);
    }
  };
};

module.exports = { createShutdown };
