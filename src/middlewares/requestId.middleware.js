'use strict';

const { randomUUID } = require('crypto');
const { REQUEST_ID_HEADER } = require('../config/constants');

/**
 * Gives every request a stable id that is echoed back in the response headers,
 * logs and error payloads, so one identifier can be traced from the gateway
 * through the service to the log aggregator.
 */
const requestId = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, req.id);
  next();
};

module.exports = requestId;
