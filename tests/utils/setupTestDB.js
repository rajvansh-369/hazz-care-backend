'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const logger = require('../../src/config/logger');

let mongoMemory;

/**
 * Connects once per suite using mongodb-memory-server with replica set support
 * (required for transactions in password reset). Truncates every collection between
 * tests so each test starts from a known empty state without paying for a reconnect.
 */
const setupTestDB = () => {
  beforeAll(async () => {
    // Create in-memory MongoDB replica set (single node sufficient for tests)
    mongoMemory = await MongoMemoryReplSet.create({
      replSet: {
        name: 'rs0',
        count: 1, // Single node replica set
      },
    });

    const uri = mongoMemory.getUri();
    logger.info(`Test DB: connecting to ${uri}`);

    await mongoose.connect(uri, {
      replicaSet: 'rs0',
    });

    logger.info('Test DB: connected');
  });

  beforeEach(async () => {
    const { collections } = mongoose.connection;
    await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    if (mongoMemory) {
      await mongoMemory.stop();
    }
  });
};

module.exports = setupTestDB;
