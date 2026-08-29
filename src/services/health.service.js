'use strict';

const os = require('os');
const config = require('../config/config');
const database = require('../config/database');

const startedAt = Date.now();

/** Liveness: the process is up and able to answer. */
const liveness = () => ({
  status: 'up',
  service: config.serviceName,
  env: config.env,
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  timestamp: new Date().toISOString(),
});

/** Readiness: every downstream dependency this service needs is usable. */
const readiness = async () => {
  const dependencies = {
    mongodb: database.isConnected() ? 'up' : 'down',
  };
  const healthy = Object.values(dependencies).every((state) => state === 'up');
  return {
    status: healthy ? 'ready' : 'not_ready',
    service: config.serviceName,
    dependencies,
    memory: {
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
      freeMemMb: Math.round((os.freemem() / 1024 / 1024) * 100) / 100,
    },
    timestamp: new Date().toISOString(),
  };
};

module.exports = { liveness, readiness };
