'use strict';

/* eslint-disable no-console -- CLI script: stdout is the interface */

/**
 * Makes every collection's indexes match its Mongoose schema.
 *
 * Mongoose never drops or alters an index that already exists: after a schema change,
 * an old index (say a unique index on PasswordResetOtp.codeHash, or a TTL on expiresAt)
 * survives in any database created before the change and keeps enforcing the old rule.
 * `Model.syncIndexes()` drops indexes the schema no longer declares and builds the ones
 * it does.
 *
 *   npm run db:sync-indexes
 *
 * Run it after ANY index change, locally and on every deploy.
 */

const mongoose = require('mongoose');

const NAMESPACE_NOT_FOUND = 26;

const listIndexNames = async (model) => {
  try {
    const indexes = await model.collection.indexes();
    return indexes.map((index) => index.name);
  } catch (error) {
    if (error.code === NAMESPACE_NOT_FOUND) {
      return [];
    }
    throw error;
  }
};

/**
 * @param {Record<string, import('mongoose').Model>} models
 * @returns {Promise<Array<{model: string, collection: string, dropped: string[], created: string[]}>>}
 */
const syncAllIndexes = async (models) => {
  const results = [];
  // Sequential on purpose: the output is read by a person, in order.
  for (const [name, model] of Object.entries(models)) {
    const before = await listIndexNames(model);
    const dropped = await model.syncIndexes();
    const after = await listIndexNames(model);
    results.push({
      model: name,
      collection: model.collection.collectionName,
      dropped,
      created: after.filter((index) => !before.includes(index)),
    });
  }
  return results;
};

const main = async () => {
  const config = require('../src/config/config');
  const models = require('../src/models');

  // autoIndex off, so indexes are built by syncIndexes below and reported, not
  // silently built on connect.
  await mongoose.connect(config.mongoose.url, { ...config.mongoose.options, autoIndex: false });
  console.log(`Connected to database "${mongoose.connection.name}"`);

  try {
    const results = await syncAllIndexes(models);
    results.forEach(({ model, collection, dropped, created }) => {
      console.log(`\n${model} (${collection})`);
      console.log(`  dropped: ${dropped.length ? dropped.join(', ') : '(none)'}`);
      console.log(`  created: ${created.length ? created.join(', ') : '(none)'}`);
    });
  } finally {
    await mongoose.disconnect();
  }
  console.log('\nIndexes in sync.');
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`sync-indexes failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { syncAllIndexes };
