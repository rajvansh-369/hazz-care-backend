'use strict';

const Joi = require('joi');
const validate = require('../../src/middlewares/validate.middleware');
const ApiError = require('../../src/utils/ApiError');

const runValidate = (schema, req) => {
  const next = jest.fn();
  validate(schema)(req, {}, next);
  return next;
};

describe('validate middleware', () => {
  test('passes through and coerces valid input', () => {
    const req = { body: { name: '  Ada  ' }, query: { limit: '5' }, params: {} };
    const next = runValidate(
      {
        body: Joi.object({ name: Joi.string().trim().required() }),
        query: Joi.object({ limit: Joi.number().integer() }),
      },
      req
    );

    expect(next).toHaveBeenCalledWith();
    expect(req.body.name).toBe('Ada');
    expect(req.query.limit).toBe(5);
  });

  test('collects every failure instead of stopping at the first', () => {
    const req = { body: { email: 'nope' }, query: {}, params: {} };
    const next = runValidate(
      {
        body: Joi.object({
          email: Joi.string().email().required(),
          name: Joi.string().required(),
        }),
      },
      req
    );

    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(400);
    expect(error.details).toHaveLength(2);
    expect(error.details.map((detail) => detail.field).sort()).toEqual(['email', 'name']);
    expect(error.details[0].location).toBe('body');
  });

  test('rejects unknown keys in the body', () => {
    const req = { body: { name: 'Ada', isAdmin: true }, query: {}, params: {} };
    const next = runValidate({ body: Joi.object({ name: Joi.string() }) }, req);
    expect(next.mock.calls[0][0].details[0].field).toBe('isAdmin');
  });

  test('strips unknown keys from the query instead of failing', () => {
    const req = { body: {}, query: { page: '2', utm_source: 'newsletter' }, params: {} };
    const next = runValidate({ query: Joi.object({ page: Joi.number() }) }, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ page: 2 });
  });

  test('validates params', () => {
    const req = { body: {}, query: {}, params: { id: 'abc' } };
    const next = runValidate({ params: Joi.object({ id: Joi.number().required() }) }, req);
    expect(next.mock.calls[0][0].details[0].location).toBe('params');
  });

  test('ignores request segments the schema does not declare', () => {
    const req = { body: { anything: true }, query: {}, params: {} };
    const next = runValidate({ params: Joi.object({}) }, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ anything: true });
  });
});
