'use strict';

const mongoose = require('mongoose');
const database = require('../../src/config/database');

/**
 * Connects once per suite and truncates every collection between tests, so each
 * test starts from a known empty state without paying for a reconnect.
 */
const setupTestDB = () => {
  beforeAll(async () => {
    await database.connect();
  });

  beforeEach(async () => {
    const { collections } = mongoose.connection;
    await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await database.disconnect();
  });
};

module.exports = setupTestDB;
