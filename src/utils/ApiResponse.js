'use strict';

const httpStatus = require('./httpStatus');

/**
 * Every successful response has the same envelope, so clients can be written
 * against one contract: { success, message, data, meta }.
 */
class ApiResponse {
  constructor(data = null, message = 'Success', meta = undefined) {
    this.success = true;
    this.message = message;
    this.data = data;
    if (meta !== undefined) {
      this.meta = meta;
    }
  }

  /**
   * @param {import('express').Response} res
   * @param {object} [options]
   */
  static send(res, { statusCode = httpStatus.OK, data = null, message = 'Success', meta } = {}) {
    const payload = new ApiResponse(data, message, meta);
    payload.requestId = res.req && res.req.id ? res.req.id : undefined;
    if (payload.requestId === undefined) {
      delete payload.requestId;
    }
    return res.status(statusCode).json(payload);
  }
}

module.exports = ApiResponse;
