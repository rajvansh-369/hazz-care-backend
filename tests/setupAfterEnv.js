'use strict';

const logger = require('../src/config/logger');

// Winston is already silenced under NODE_ENV=test; this guards against a future
// transport being added without the same guard.
logger.silent = true;

jest.setTimeout(30000);
