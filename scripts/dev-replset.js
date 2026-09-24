'use strict';

/* eslint-disable no-console -- CLI script: stdout is the interface */

/**
 * Local development MongoDB: a one-node replica set named rs0 on port 27018.
 *
 * Token rotation and password reset use transactions, which need a replica set; a
 * standalone mongod will not do. This runs one from mongodb-memory-server with a
 * persistent wiredTiger dbPath in .dev-data/, so data survives restarts. It does not
 * touch any other mongod on this machine.
 *
 *   npm run db:dev        # then, in another terminal: npm run dev
 *
 * Stays in the foreground until Ctrl+C, then shuts the server down cleanly.
 */

const fs = require('fs');
const path = require('path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const PORT = 27018;
const REPL_SET = 'rs0';
const DB_NAME = 'hajjcare';
const DB_PATH = path.join(__dirname, '..', '.dev-data', `${REPL_SET}-0`);

const main = async () => {
  fs.mkdirSync(DB_PATH, { recursive: true });

  const replSet = await MongoMemoryReplSet.create({
    replSet: { name: REPL_SET, count: 1, storageEngine: 'wiredTiger' },
    // launchTimeout: after an unclean stop, WiredTiger recovery took 12s, past the 10s default.
    instanceOpts: [{ port: PORT, dbPath: DB_PATH, storageEngine: 'wiredTiger', launchTimeout: 30000 }],
  });

  const uri = `mongodb://127.0.0.1:${PORT}/${DB_NAME}?replicaSet=${REPL_SET}`;
  console.log('');
  console.log(`MongoDB replica set "${REPL_SET}" is running on 127.0.0.1:${PORT}`);
  console.log(`Data directory: ${DB_PATH}`);
  console.log('');
  console.log(`  MONGODB_URL=${uri}`);
  console.log('');
  console.log('Press Ctrl+C to stop.');

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`\n${signal} received, stopping MongoDB...`);
    try {
      // doCleanup: false keeps the dbPath; the data must survive restarts.
      await replSet.stop({ doCleanup: false });
      console.log('MongoDB stopped.');
      process.exit(0);
    } catch (error) {
      console.error(`Failed to stop MongoDB cleanly: ${error.message}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGBREAK', () => stop('SIGBREAK'));
};

main().catch((error) => {
  console.error(`Could not start the development replica set: ${error.message}`);
  console.error(`Is port ${PORT} already in use, or is another db:dev still running?`);
  process.exit(1);
});
