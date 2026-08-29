'use strict';

const Joi = require('joi');
const pick = require('../utils/pick');
const ApiError = require('../utils/ApiError');
const httpStatus = require('../utils/httpStatus');
const errorCodes = require('../utils/errorCodes');

const SEGMENTS = ['params', 'query', 'body'];

/**
 * Request validation middleware.
 *
 * `params` and `body` reject unknown keys (so client typos surface immediately),
 * while `query` strips them (proxies and browsers routinely append their own).
 * The validated, coerced value replaces the raw input, so controllers only ever
 * see data that matched the schema.
 *
 * @param {object} schema `{ params?, query?, body? }` of Joi schemas.
 * @returns {import('express').RequestHandler}
 */
const validate = (schema) => (req, res, next) => {
  const validSchema = pick(schema, SEGMENTS);
  const details = [];

  Object.keys(validSchema).forEach((segment) => {
    // eslint-disable-next-line security/detect-object-injection
    const segmentSchema = Joi.compile(validSchema[segment]);
    const isQuery = segment === 'query';
    // eslint-disable-next-line security/detect-object-injection
    const { value, error } = segmentSchema
      .prefs({
        errors: { label: 'key', wrap: { label: false } },
        abortEarly: false,
        allowUnknown: isQuery,
        stripUnknown: isQuery,
        convert: true,
      })
      // eslint-disable-next-line security/detect-object-injection
      .validate(req[segment]);

    if (error) {
      error.details.forEach((detail) => {
        details.push({
          field: detail.path.join('.') || detail.context.key || segment,
          location: segment,
          message: detail.message,
        });
      });
      return;
    }

    // req.query has only a getter in some Express versions; mutate in place.
    if (isQuery) {
      Object.keys(req.query).forEach((key) => {
        // eslint-disable-next-line security/detect-object-injection
        delete req.query[key];
      });
      Object.assign(req.query, value);
    } else {
      // eslint-disable-next-line security/detect-object-injection
      req[segment] = value;
    }
  });

  if (details.length) {
    return next(
      new ApiError(httpStatus.BAD_REQUEST, 'Request validation failed', {
        code: errorCodes.VALIDATION_ERROR,
        details,
      })
    );
  }

  return next();
};

module.exports = validate;
