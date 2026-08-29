'use strict';

/**
 * Starts a throwaway MongoDB for the suite.
 *
 * Set `MONGODB_URL_TEST` (for example in CI, where a mongo service container is
 * already running) to reuse an existing server and skip the download entirely.
 */
module.exports = async () => {
  if (process.env.MONGODB_URL_TEST) {
    process.env.MONGODB_URL = process.env.MONGODB_URL_TEST;
    return;
  }

  // Required lazily so the package is only touched when it is actually needed.
  // eslint-disable-next-line global-require
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const instance = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  global.__MONGO_INSTANCE__ = instance;
  process.env.MONGODB_URL = instance.getUri('jest-boilerplate');
};
